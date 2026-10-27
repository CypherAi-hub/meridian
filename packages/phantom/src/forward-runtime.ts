import {
  FORWARD_SCOPE,
  ForwardCohortCollector,
  canonical,
  forwardHash,
  forwardCostAudit,
  freezeForwardProtocol,
  validateForwardProtocol,
  type ForwardProtocol,
  type ForwardRecord,
} from "./forward-cohort.ts";
import { ForwardSqlJournal } from "./forward-cohort-store.ts";

export interface ForwardRuntimeStore {
  assertWorkerLease(): void;
  exec(sql: string, args?: unknown[]): Promise<unknown>;
  query(sql: string, args?: unknown[]): Promise<Array<{ payload: unknown }>>;
  get(id: string): Promise<unknown>;
  save(id: string, value: unknown): Promise<void>;
}

export const FORWARD_ACTIVE_STATE_KEY = "forward-runtime-active-v1";
export const forwardRetirementStateKey = (experimentId: string) => {
  if (!ID.test(experimentId)) throw Error("FORWARD_EXPERIMENT_ID_INVALID");
  return `forward-runtime-retirement-v1:${experimentId}`;
};
const ID = /^[A-Za-z0-9:_-]{1,128}$/;
const HASH = /^[a-f0-9]{64}$/;
// One Store is one fenced worker. Switching source waits for its in-flight quotes.
const lanes = new WeakMap<ForwardRuntimeStore, Promise<unknown>>();
// Even same-source restarts retire the previous in-memory inventory cache.
const owners = new WeakMap<ForwardRuntimeStore, object>();
function serialized<T>(store: ForwardRuntimeStore, work: () => Promise<T>): Promise<T> {
  const result = (lanes.get(store) ?? Promise.resolve()).then(work);
  lanes.set(
    store,
    result.catch(() => undefined),
  );
  return result;
}

export type ForwardExperimentMetadata = Pick<
  ForwardProtocol,
  | "experimentId"
  | "runtimeSourceVersion"
  | "sourceCommit"
  | "configurationHash"
  | "frozenAt"
  | "enrollmentStart"
  | "enrollmentEnd"
> & { active: boolean; retirement?: ForwardEpochRetirement };

export type ForwardEpochRetirement = {
  schemaVersion: 1;
  status: "INCOMPLETE";
  reason: "SOURCE_CHANGED";
  cutoffAt: number;
  oldExperimentId: string;
  oldRuntimeSourceVersion: string;
  oldConfigurationHash: string;
  originalEnrollmentStart: number;
  originalEnrollmentEnd: number;
  newExperimentId: string;
  newRuntimeSourceVersion: string;
  journalRecordCount: number;
  journalCanonicalSha256: string;
  /** Frozen before pointer replacement, including retries before manifest acknowledgement. */
  targetProtocol: ForwardProtocol;
};

export type ForwardRuntimeCollector = Pick<
  ForwardCohortCollector,
  "protocol" | "initialize" | "nextQuoteWindow" | "considerProbe" | "tick" | "export" | "idle"
>;

type ActivePointer = {
  version: 1;
  experimentId: string;
  runtimeSourceVersion: string;
  configurationHash: string;
};

/** Durable manifests and quote-only history, through the sole existing fenced Store. */
export class ForwardRuntime {
  private readonly journal: ForwardSqlJournal;
  private readonly source: string;
  private readonly commit: string;
  private readonly now: () => number;
  private readonly experimentId: string;
  private readonly retireInterruptedEpoch: boolean;
  private initializePromise: Promise<this> | null = null;
  private current: ForwardCohortCollector | null = null;
  private facade: ForwardRuntimeCollector | null = null;

  constructor(
    private readonly store: ForwardRuntimeStore,
    options: {
      runtimeSourceVersion: string;
      sourceCommit: string;
      now?: () => number;
      retireInterruptedEpoch?: boolean;
    },
  ) {
    if (!/^[a-f0-9]{64}$/.test(options.runtimeSourceVersion))
      throw Error("FORWARD_RUNTIME_SOURCE_INVALID");
    if (!/^[a-f0-9]{40}$/.test(options.sourceCommit)) throw Error("FORWARD_RUNTIME_COMMIT_INVALID");
    this.source = options.runtimeSourceVersion;
    this.commit = options.sourceCommit;
    this.now = options.now ?? Date.now;
    if (
      options.retireInterruptedEpoch !== undefined &&
      typeof options.retireInterruptedEpoch !== "boolean"
    )
      throw Error("FORWARD_RUNTIME_RETIREMENT_OPTION_INVALID");
    this.retireInterruptedEpoch = options.retireInterruptedEpoch === true;
    this.experimentId = `post-probe-60s-v1-${this.source}`;
    this.journal = new ForwardSqlJournal(store);
  }

  private time() {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0 || Object.is(now, -0))
      throw Error("FORWARD_CLOCK_INVALID");
    return now;
  }

  private decodeProtocol(value: unknown, id?: string): ForwardProtocol {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Error("FORWARD_PROTOCOL_INVALID_OR_CHANGED");
    const protocol = structuredClone(value) as ForwardProtocol;
    validateForwardProtocol(protocol);
    if (id !== undefined && protocol.experimentId !== id)
      throw Error("FORWARD_PROTOCOL_ID_MISMATCH");
    return Object.freeze(protocol);
  }

  private async findProtocol(id: string): Promise<ForwardProtocol | null> {
    this.store.assertWorkerLease();
    const rows = await this.store.query(
      "SELECT payload FROM phantom_forward_protocols WHERE experiment_id=$1",
      [id],
    );
    return rows.length ? this.decodeProtocol(rows[0].payload, id) : null;
  }

  private async activeProtocol(): Promise<ForwardProtocol | null> {
    const pointer = (await this.store.get(
      FORWARD_ACTIVE_STATE_KEY,
    )) as Partial<ActivePointer> | null;
    // Preserve support for a stale/incomplete advisory pointer with no usable identity.
    if (
      pointer?.version !== 1 ||
      typeof pointer.experimentId !== "string" ||
      !ID.test(pointer.experimentId) ||
      typeof pointer.runtimeSourceVersion !== "string" ||
      !HASH.test(pointer.runtimeSourceVersion) ||
      typeof pointer.configurationHash !== "string" ||
      !HASH.test(pointer.configurationHash)
    ) {
      // A partial source-bearing pointer cannot silently authorize another epoch.
      if (pointer?.runtimeSourceVersion !== undefined || pointer?.configurationHash !== undefined)
        throw Error("FORWARD_ACTIVE_POINTER_INVALID");
      return null;
    }
    const protocol = await this.findProtocol(pointer.experimentId);
    if (!protocol) throw Error("FORWARD_ACTIVE_PROTOCOL_MISSING");
    if (
      protocol.runtimeSourceVersion !== pointer.runtimeSourceVersion ||
      protocol.configurationHash !== pointer.configurationHash
    )
      throw Error("FORWARD_ACTIVE_POINTER_INVALID");
    return protocol;
  }

  private async retirement(id: string): Promise<ForwardEpochRetirement | null> {
    this.store.assertWorkerLease();
    const input = await this.store.get(forwardRetirementStateKey(id));
    this.store.assertWorkerLease();
    if (input === null || input === undefined) return null;
    const value = structuredClone(input) as ForwardEpochRetirement;
    const keys = [
      "schemaVersion",
      "status",
      "reason",
      "cutoffAt",
      "oldExperimentId",
      "oldRuntimeSourceVersion",
      "oldConfigurationHash",
      "originalEnrollmentStart",
      "originalEnrollmentEnd",
      "newExperimentId",
      "newRuntimeSourceVersion",
      "journalRecordCount",
      "journalCanonicalSha256",
      "targetProtocol",
    ];
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== keys.length ||
      !keys.every((key) => Object.hasOwn(value, key)) ||
      value.schemaVersion !== 1 ||
      value.status !== "INCOMPLETE" ||
      value.reason !== "SOURCE_CHANGED" ||
      value.oldExperimentId !== id ||
      !HASH.test(value.oldRuntimeSourceVersion) ||
      !HASH.test(value.oldConfigurationHash) ||
      !HASH.test(value.newRuntimeSourceVersion) ||
      !HASH.test(value.journalCanonicalSha256) ||
      !ID.test(value.newExperimentId) ||
      value.newExperimentId === id ||
      value.oldRuntimeSourceVersion === value.newRuntimeSourceVersion ||
      ![
        value.cutoffAt,
        value.originalEnrollmentStart,
        value.originalEnrollmentEnd,
        value.journalRecordCount,
      ].every((n) => Number.isSafeInteger(n) && n >= 0 && !Object.is(n, -0)) ||
      value.originalEnrollmentEnd <= value.originalEnrollmentStart
    )
      throw Error("FORWARD_RETIREMENT_INVALID");
    const target = this.decodeProtocol(value.targetProtocol, value.newExperimentId);
    if (
      target.runtimeSourceVersion !== value.newRuntimeSourceVersion ||
      target.frozenAt > value.cutoffAt
    )
      throw Error("FORWARD_RETIREMENT_INVALID");
    return Object.freeze({ ...value, targetProtocol: target });
  }

  private validateJournal(protocol: ForwardProtocol, records: ForwardRecord[], asOf: number) {
    for (const row of records) {
      if (
        !row ||
        row.experimentId !== protocol.experimentId ||
        row.configurationHash !== protocol.configurationHash ||
        row.scope !== FORWARD_SCOPE ||
        !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(row.mint) ||
        !["ENROLLMENT", "ENTRY_REQUEST", "ENTRY_RESULT", "EXIT_REQUEST", "EXIT_RESULT"].includes(
          row.phase,
        ) ||
        row.id !== `${protocol.experimentId}:${row.mint}:${row.phase}` ||
        !Number.isSafeInteger(row.at) ||
        row.at < protocol.frozenAt ||
        row.at > asOf
      )
        throw Error("FORWARD_JOURNAL_CONTEXT_INVALID");
    }
  }

  private validateRetirement(
    protocol: ForwardProtocol,
    records: ForwardRecord[],
    retirement: ForwardEpochRetirement,
  ) {
    if (
      retirement.oldExperimentId !== protocol.experimentId ||
      retirement.oldRuntimeSourceVersion !== protocol.runtimeSourceVersion ||
      retirement.oldConfigurationHash !== protocol.configurationHash ||
      retirement.originalEnrollmentStart !== protocol.enrollmentStart ||
      retirement.originalEnrollmentEnd !== protocol.enrollmentEnd ||
      retirement.cutoffAt < protocol.frozenAt
    )
      throw Error("FORWARD_RETIREMENT_PROTOCOL_MISMATCH");
    this.validateJournal(protocol, records, retirement.cutoffAt);
    if (
      records.length !== retirement.journalRecordCount ||
      forwardHash(records) !== retirement.journalCanonicalSha256
    )
      throw Error("FORWARD_RETIRED_JOURNAL_CHANGED");
  }

  private async retire(
    previous: ForwardProtocol,
    existingTarget: ForwardProtocol | null,
  ): Promise<ForwardEpochRetirement> {
    let retired = await this.retirement(previous.experimentId);
    if (retired) {
      if (
        retired.newExperimentId !== this.experimentId ||
        retired.newRuntimeSourceVersion !== this.source
      )
        throw Error("FORWARD_RETIREMENT_TARGET_MISMATCH");
    } else {
      const cutoffAt = this.time();
      if (cutoffAt < previous.frozenAt) throw Error("FORWARD_CLOCK_PRECEDES_FREEZE");
      const records = await this.journal.records(previous.experimentId);
      this.validateJournal(previous, records, cutoffAt);
      const targetProtocol =
        existingTarget ??
        freezeForwardProtocol({
          now: cutoffAt,
          runtimeSourceVersion: this.source,
          sourceCommit: this.commit,
          experimentId: this.experimentId,
        });
      if (targetProtocol.frozenAt > cutoffAt) throw Error("FORWARD_CLOCK_PRECEDES_FREEZE");
      const candidate: ForwardEpochRetirement = {
        schemaVersion: 1,
        status: "INCOMPLETE",
        reason: "SOURCE_CHANGED",
        cutoffAt,
        oldExperimentId: previous.experimentId,
        oldRuntimeSourceVersion: previous.runtimeSourceVersion,
        oldConfigurationHash: previous.configurationHash,
        originalEnrollmentStart: previous.enrollmentStart,
        originalEnrollmentEnd: previous.enrollmentEnd,
        newExperimentId: this.experimentId,
        newRuntimeSourceVersion: this.source,
        journalRecordCount: records.length,
        journalCanonicalSha256: forwardHash(records),
        targetProtocol,
      };
      this.store.assertWorkerLease();
      try {
        await this.store.exec(
          "INSERT INTO phantom_state(id,payload,updated_at) VALUES($1,$2::jsonb,$3) ON CONFLICT(id) DO NOTHING",
          [forwardRetirementStateKey(previous.experimentId), canonical(candidate), cutoffAt],
        );
      } catch (error) {
        retired = await this.retirement(previous.experimentId);
        if (!retired) throw error;
      }
      retired ??= await this.retirement(previous.experimentId);
      if (!retired || canonical(retired) !== canonical(candidate))
        throw Error("FORWARD_IMMUTABLE_RETIREMENT_CONFLICT");
    }
    if (this.time() < retired.cutoffAt) throw Error("FORWARD_CLOCK_PRECEDES_RETIREMENT");
    const records = await this.journal.records(previous.experimentId);
    this.validateRetirement(previous, records, retired);
    if (existingTarget && canonical(existingTarget) !== canonical(retired.targetProtocol))
      throw Error("FORWARD_FROZEN_PROTOCOL_CONFLICT");
    return retired;
  }

  private ready(): ForwardCohortCollector {
    if (!this.current) throw Error("FORWARD_RUNTIME_NOT_INITIALIZED");
    return this.current;
  }

  private async assertActive() {
    const collector = this.ready();
    this.store.assertWorkerLease();
    if (owners.get(this.store) !== this) throw Error("FORWARD_RUNTIME_SUPERSEDED");
    if (await this.retirement(collector.protocol.experimentId))
      throw Error("FORWARD_RUNTIME_EPOCH_RETIRED");
    const pointer = (await this.store.get(FORWARD_ACTIVE_STATE_KEY)) as ActivePointer | null;
    if (
      pointer?.version !== 1 ||
      pointer.experimentId !== collector.protocol.experimentId ||
      pointer.runtimeSourceVersion !== this.source ||
      pointer.configurationHash !== collector.protocol.configurationHash
    )
      throw Error("FORWARD_RUNTIME_SUPERSEDED");
    this.store.assertWorkerLease();
  }

  private activeCall<T>(work: (collector: ForwardCohortCollector) => Promise<T>): Promise<T> {
    return serialized(this.store, async () => {
      await this.assertActive();
      return work(this.ready());
    });
  }

  initialize(): Promise<this> {
    if (this.current)
      return this.activeCall(async (collector) => {
        await collector.initialize();
        return this;
      });
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = serialized(this.store, async () => {
      this.store.assertWorkerLease();
      // A failed replacement stays fail-closed; no older cached collector may
      // resume provider requests while replacement initialization is incomplete.
      owners.set(this.store, this);
      // Additive table creation only. Lookup happens before freezing, independently
      // of the advisory pointer, so an orphan durable manifest is always reused.
      await this.journal.records(this.experimentId);
      if (await this.retirement(this.experimentId)) throw Error("FORWARD_RUNTIME_EPOCH_RETIRED");
      const previous = await this.activeProtocol();
      const changingSource = previous && previous.runtimeSourceVersion !== this.source;
      if (changingSource && !this.retireInterruptedEpoch)
        throw Error("FORWARD_SOURCE_CHANGE_REQUIRES_RETIREMENT");
      let protocol = await this.findProtocol(this.experimentId);
      if (protocol && protocol.runtimeSourceVersion !== this.source)
        throw Error("FORWARD_RUNTIME_SOURCE_MISMATCH");
      if (changingSource) {
        const existing = protocol;
        protocol = (await this.retire(previous, existing)).targetProtocol;
        if (!existing) {
          try {
            await this.journal.ensureProtocol(protocol);
          } catch (error) {
            const durable = await this.findProtocol(this.experimentId);
            if (!durable || canonical(durable) !== canonical(protocol)) throw error;
            protocol = durable;
          }
        }
      }
      if (!protocol) {
        const candidate = freezeForwardProtocol({
          now: this.time(),
          runtimeSourceVersion: this.source,
          sourceCommit: this.commit,
          experimentId: this.experimentId,
        });
        try {
          await this.journal.ensureProtocol(candidate);
          protocol = candidate;
        } catch (error) {
          // The INSERT may have committed before its acknowledgement was lost.
          // Adopt that original manifest; never freeze a later enrollment window.
          protocol = await this.findProtocol(this.experimentId);
          if (!protocol) throw error;
        }
      }
      if (protocol.runtimeSourceVersion !== this.source)
        throw Error("FORWARD_RUNTIME_SOURCE_MISMATCH");
      if (this.time() < protocol.frozenAt) throw Error("FORWARD_CLOCK_PRECEDES_FREEZE");
      this.store.assertWorkerLease();
      await this.store.save(FORWARD_ACTIVE_STATE_KEY, {
        version: 1,
        experimentId: protocol.experimentId,
        runtimeSourceVersion: this.source,
        configurationHash: protocol.configurationHash,
      } satisfies ActivePointer);
      this.store.assertWorkerLease();
      // Publish source before recovery: a failed new-source recovery must not
      // leave the previous source eligible to make another provider request.
      const collector = new ForwardCohortCollector(protocol, this.journal, this.source, () =>
        this.time(),
      );
      await collector.initialize();
      this.current = collector;
      this.facade = Object.freeze({
        protocol: collector.protocol,
        initialize: () => this.activeCall((c) => c.initialize()),
        nextQuoteWindow: () => this.activeCall((c) => c.nextQuoteWindow()),
        considerProbe: (input) => this.activeCall((c) => c.considerProbe(input)),
        tick: (provider, permit = true) => this.activeCall((c) => c.tick(provider, permit)),
        export: () => this.export(),
        idle: () => this.idle(),
      } satisfies ForwardRuntimeCollector);
      return this;
    }).catch((error) => {
      this.initializePromise = null;
      throw error;
    });
    return this.initializePromise;
  }

  get protocol(): ForwardProtocol {
    return this.ready().protocol;
  }

  get collector(): ForwardRuntimeCollector {
    this.ready();
    return this.facade!;
  }

  history(): Promise<ForwardExperimentMetadata[]> {
    this.ready();
    return serialized(this.store, async () => {
      this.store.assertWorkerLease();
      const rows = await this.store.query("SELECT payload FROM phantom_forward_protocols");
      const pointer = (await this.store.get(FORWARD_ACTIVE_STATE_KEY)) as ActivePointer | null;
      const history: ForwardExperimentMetadata[] = [];
      for (const { payload } of rows) {
        const p = this.decodeProtocol(payload),
          retirement = await this.retirement(p.experimentId);
        if (retirement)
          this.validateRetirement(p, await this.journal.records(p.experimentId), retirement);
        history.push({
          experimentId: p.experimentId,
          runtimeSourceVersion: p.runtimeSourceVersion,
          sourceCommit: p.sourceCommit,
          configurationHash: p.configurationHash,
          frozenAt: p.frozenAt,
          enrollmentStart: p.enrollmentStart,
          enrollmentEnd: p.enrollmentEnd,
          active:
            !retirement &&
            pointer?.version === 1 &&
            pointer.experimentId === p.experimentId &&
            pointer.runtimeSourceVersion === p.runtimeSourceVersion &&
            pointer.configurationHash === p.configurationHash,
          ...(retirement ? { retirement } : {}),
        });
      }
      return history.sort(
        (a, b) => a.frozenAt - b.frozenAt || a.experimentId.localeCompare(b.experimentId),
      );
    });
  }

  export(experimentId = this.experimentId): Promise<{
    exportedAt: number;
    protocol: ForwardProtocol;
    costAudit: ReturnType<typeof forwardCostAudit>;
    records: ForwardRecord[];
    retirement?: ForwardEpochRetirement;
  }> {
    this.ready();
    if (!ID.test(experimentId)) return Promise.reject(Error("FORWARD_EXPERIMENT_ID_INVALID"));
    return serialized(this.store, async () => {
      const protocol = await this.findProtocol(experimentId);
      if (!protocol) throw Error("FORWARD_EXPERIMENT_NOT_FOUND");
      const records = await this.journal.records(experimentId);
      const exportedAt = this.time();
      if (exportedAt < protocol.frozenAt) throw Error("FORWARD_CLOCK_PRECEDES_FREEZE");
      this.validateJournal(protocol, records, exportedAt);
      const retirement = await this.retirement(experimentId);
      if (retirement) {
        if (exportedAt < retirement.cutoffAt) throw Error("FORWARD_CLOCK_PRECEDES_RETIREMENT");
        this.validateRetirement(protocol, records, retirement);
      }
      // Deliberately no collector construction or initialization here. Incomplete
      // historical requests stay incomplete and retain their original provenance.
      return {
        exportedAt,
        protocol,
        costAudit: forwardCostAudit(protocol),
        records: structuredClone(records),
        ...(retirement ? { retirement } : {}),
      };
    });
  }

  async idle(): Promise<void> {
    await serialized(this.store, async () => {
      await this.current?.idle();
    });
  }
}
