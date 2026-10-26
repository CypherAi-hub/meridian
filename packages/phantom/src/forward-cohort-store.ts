import {
  canonical,
  type ForwardJournal,
  type ForwardProtocol,
  type ForwardRecord,
} from "./forward-cohort.ts";

type FencedDatabase = {
  assertWorkerLease(): void;
  exec(sql: string, args?: unknown[]): Promise<unknown>;
  query(sql: string, args?: unknown[]): Promise<Array<{ payload: unknown }>>;
};

/** Additive tables through the existing worker-fenced Store. No paper-ledger mutations. */
export class ForwardSqlJournal implements ForwardJournal {
  private ready: Promise<void> | null = null;
  private db: FencedDatabase;
  constructor(db: FencedDatabase) {
    this.db = db;
  }
  private async initialize() {
    this.db.assertWorkerLease();
    if (!this.ready)
      this.ready = this.db
        .exec(
          `
      CREATE TABLE IF NOT EXISTS phantom_forward_protocols (
        experiment_id text PRIMARY KEY, payload jsonb NOT NULL
      );
      CREATE TABLE IF NOT EXISTS phantom_forward_records (
        id text PRIMARY KEY, experiment_id text NOT NULL REFERENCES phantom_forward_protocols(experiment_id),
        mint text NOT NULL, phase text NOT NULL, at bigint NOT NULL, payload jsonb NOT NULL,
        UNIQUE(experiment_id,mint,phase)
      );
      CREATE INDEX IF NOT EXISTS phantom_forward_records_experiment ON phantom_forward_records(experiment_id,at);
    `,
        )
        .then(() => undefined)
        .catch((error) => {
          this.ready = null;
          throw error;
        });
    await this.ready;
  }
  async ensureProtocol(protocol: ForwardProtocol) {
    await this.initialize();
    this.db.assertWorkerLease();
    await this.db.exec(
      "INSERT INTO phantom_forward_protocols(experiment_id,payload) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING",
      [protocol.experimentId, JSON.stringify(protocol)],
    );
    const row = (
      await this.db.query("SELECT payload FROM phantom_forward_protocols WHERE experiment_id=$1", [
        protocol.experimentId,
      ])
    )[0];
    if (!row || canonical(row.payload) !== canonical(protocol))
      throw Error("FORWARD_FROZEN_PROTOCOL_CONFLICT");
  }
  async records(experimentId: string) {
    await this.initialize();
    return (
      await this.db.query(
        "SELECT payload FROM phantom_forward_records WHERE experiment_id=$1 ORDER BY at,id",
        [experimentId],
      )
    ).map((x) => x.payload as ForwardRecord);
  }
  async append(record: ForwardRecord) {
    await this.initialize();
    this.db.assertWorkerLease();
    await this.db.exec(
      "INSERT INTO phantom_forward_records(id,experiment_id,mint,phase,at,payload) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING",
      [
        record.id,
        record.experimentId,
        record.mint,
        record.phase,
        record.at,
        JSON.stringify(record),
      ],
    );
    const row = (
      await this.db.query("SELECT payload FROM phantom_forward_records WHERE id=$1", [record.id])
    )[0];
    if (!row || canonical(row.payload) !== canonical(record))
      throw Error("FORWARD_APPEND_ONLY_RECORD_CONFLICT");
  }
}
