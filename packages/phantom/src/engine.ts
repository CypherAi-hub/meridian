import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { Connection } from "@solana/web3.js";
import { Store } from "./store.ts";
import { decodeTransaction, decodeLogNotification, type LogEnrichmentHint, type RpcTransaction } from "./decoder.ts";
import { Rpc, SolanaStream, startYellowstone, type FinalizedLogEnvelope } from "./stream.ts";
import { JupiterQuoteClient, PumpQuoteClient } from "./execution.ts";
import {
  WalletIntelligence,
  featuresAt,
  evaluateStrategies,
  DEFAULT_STRATEGY_RULES,
  type TradeObservation,
} from "./intelligence.ts";
import { RiskGovernor, DEFAULT_RISK_LIMITS, checkTokenSafety } from "./risk.ts";
import {
  PaperLedger,
  restoreLedger,
  aggregateCompletedPositions,
  type QuoteProvider,
} from "./paper.ts";
import { SecurityReader, type SecuritySnapshot } from "./security.ts";
import { WSOL, json, solAmount, type ChainEvent, type Health } from "./types.ts";
import { WalletHistoryReader } from "./wallet-reader.ts";
import {
  flattenReplayFeatures,
  replayObservationFromSnapshot,
  researchReplayConfiguration,
} from "./replay-strategy.ts";
import type { Quote } from "./execution.ts";
import { QuoteResearchCollector } from "./quote-research.ts";
import { runtimeSourceVersion } from "./runtime-version.ts";
import { conservativeCostBps } from "./costs.ts";
import { ForwardRuntime } from "./forward-runtime.ts";
function sourceCommit(configured?: string) {
  const explicit = configured ?? process.env.PHANTOM_SOURCE_COMMIT;
  if (explicit?.trim()) {
    if (!/^[a-f0-9]{40}$/.test(explicit.trim())) throw Error("INVALID_SOURCE_COMMIT");
    return explicit.trim();
  }
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      encoding: "utf8",
      windowsHide: true,
      timeout: 3000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (/^[a-f0-9]{40}$/.test(head)) return head;
  } catch {}
  throw Error("FORWARD_SOURCE_COMMIT_REQUIRED_FOR_ARCHIVED_SOURCE");
}
function rpcInterval() {
  const value = Number(process.env.PHANTOM_RPC_INTERVAL_MS ?? 1000);
  if (!Number.isInteger(value) || value < 100 || value > 60_000)
    throw Error("INVALID_RPC_INTERVAL_MS");
  return value;
}
const eventKey = (e: ChainEvent) => [e.signature, e.protocol, e.kind, e.mint, e.actor].join(":");

export class Engine {
  readonly sourceVersion = runtimeSourceVersion();
  readonly startedAt = Date.now();
  readonly health: Health = {
    status: "CONNECTING",
    source: process.env.PHANTOM_SOURCE ?? "rpc",
    received: 0,
    decoded: 0,
    rejected: 0,
    errors: 0,
    lastEventAt: null,
    latencyMs: { p50: null, p95: null },
    backfillGaps: 0,
    queueDepth: 0,
  };
  readonly store = new Store();
  readonly rpc = new Rpc(
    process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
    rpcInterval(),
  );
  readonly intelligence = new WalletIntelligence();
  readonly security = new SecurityReader(this.rpc);
  private walletReader = new WalletHistoryReader(
    this.rpc,
    this.store,
    this.intelligence,
    new Set((process.env.PHANTOM_SHARED_SERVICE_WALLETS ?? "").split(",").filter(Boolean)),
  );
  private walletJobs = new Set<string>();
  private killFile = resolve(process.env.PHANTOM_KILL_FILE ?? "./data/KILL");
  private quoteResearch!: QuoteResearchCollector;
  private forwardRuntime: ForwardRuntime | null = null;
  private managingPositions = false;
  private researchTimer: ReturnType<typeof setInterval> | null = null;
  private researchWork: Promise<void> | null = null;
  private fastEvents: ChainEvent[] = [];
  private fastIds = new Set<string>();
  private materializedTrades = new Map<string, number>();
  private fastTradeCounts = new Map<string, number>();
  private rpcSource: SolanaStream | null = null;
  private typedObserved = 0;
  get url() {
    const address = this.stateServer?.address();
    return typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : null;
  }
  private suspensionReason: string | null = null;
  private ledgerSaves = Promise.resolve();
  private tickWork: Promise<void> | null = null;
  private killed() {
    return (
      this.suspensionReason !== null ||
      existsSync(this.killFile) ||
      process.env.PHANTOM_KILL_SWITCH === "true"
    );
  }
  private quote: QuoteProvider = process.env.JUPITER_API_KEY
    ? new JupiterQuoteClient()
    : new PumpQuoteClient(new Connection(this.rpc.url, "finalized"));
  private ledger!: PaperLedger;
  private events: ChainEvent[] = [];
  private trades: TradeObservation[] = [];
  private decisions: any[] = [];
  private latencies: number[] = [];
  private snapshots = new Map<string, SecuritySnapshot>();
  private lastAnalysis = new Map<string, number>();
  private busyMints = new Set<string>();
  private launches = new Map<string, ChainEvent>();
  private stateServer: Server | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private source: { stop(): Promise<void> } | null = null;
  private work = Promise.resolve();
  private stopped = false;
  readonly limitations: string[] = [
    "Paper fills only: no wallet is loaded, signed, or submitted by this worker.",
    "RPC fallback fetches finalized transactions and is slower than Yellowstone; provider limits and gaps are reported.",
    "Raydium CPMM detection is supported; CLMM, AMM v4, and LaunchLab layouts are unsupported.",
    "Jupiter requires a configured API key. Missing routes or security evidence veto paper entries.",
    "No strategy is certified profitable. Adaptive selection stays locked until validated artifacts exist.",
    "Creator relationships and track records are limited to collected, point-in-time evidence.",
    "The current SecurityReader always leaves creator associations unverified: no token can pass strict entry safety until scoped supply coverage is implemented.",
    "Live execution primitives are not connected to this CLI; production unattended execution remains uncertified.",
  ];
  async start(options: { stream?: boolean; port?: number; sourceCommit?: string } = {}) {
    try {
      return await this.initialize(options);
    } catch (error) {
      this.stopped = true;
      if (this.timer) clearInterval(this.timer);
      if (this.researchTimer) clearInterval(this.researchTimer);
      await this.source?.stop();
      await this.work;
      await this.tickWork;
      await this.researchWork;
      if (this.stateServer?.listening)
        await new Promise<void>((r) => this.stateServer!.close(() => r()));
      await this.store.close();
      throw error;
    }
  }
  private async initialize(
    options: { stream?: boolean; port?: number; sourceCommit?: string } = {},
  ) {
    if ((process.env.PHANTOM_MODE ?? "PAPER") !== "PAPER")
      throw Error("CLI_PAPER_MODE_ONLY_LIVE_REQUIRES_SEPARATE_REVIEW");
    if (process.env.NODE_ENV === "production" && !process.env.PHANTOM_DATABASE_URL)
      throw Error("PRODUCTION_POSTGRES_REQUIRED");
    await this.store.open(
      process.env.PHANTOM_DATABASE_URL,
      process.env.PHANTOM_DATA_DIR ?? "./data/warehouse",
      true,
    );
    if (
      process.env.PHANTOM_QUOTE_RESEARCH !== "false" &&
      process.env.PHANTOM_FORWARD_RESEARCH !== "false"
    ) {
      this.forwardRuntime = await new ForwardRuntime(this.store, {
        runtimeSourceVersion: this.sourceVersion,
        sourceCommit: sourceCommit(options.sourceCommit),
      }).initialize();
    }
    this.quoteResearch = new QuoteResearchCollector(
      this.store,
      30_000,
      this.forwardRuntime?.collector,
      () =>
        !this.managingPositions &&
        !this.ledger?.state.pendingExits.some((exit) => exit.readyAt <= Date.now()),
    );
    await this.quoteResearch.initialize();
    const restored = restoreLedger(await this.store.get("ledger"));
    this.suspensionReason = (await this.store.get("suspension"))?.reason ?? null;
    const governor = new RiskGovernor({
      ...DEFAULT_RISK_LIMITS,
      maxPerTradeLamports: solAmount(process.env.PHANTOM_MAX_TRADE_SOL ?? "0.02"),
      minReserveLamports: solAmount(process.env.PHANTOM_MIN_RESERVE_SOL ?? "0.1"),
    });
    this.ledger = new PaperLedger(
      solAmount(process.env.PHANTOM_INITIAL_SOL ?? "1"),
      governor,
      restored,
    );
    this.ledger.state.killSwitch = this.killed();
    if (!this.ledger.state.equity.length) this.ledger.recordEquity(Date.now());
    if (!(await this.store.get("research-config")))
      await this.store.save(
        "research-config",
        researchReplayConfiguration("launch_sniper", Date.now()),
      );
    this.events = await this.store.recentEvents(2000);
    for (const e of [...this.events].reverse()) this.observe(e);
    this.fastEvents = (
      await this.store.query(
        "SELECT payload FROM phantom_observed_events ORDER BY received_at DESC LIMIT 2000",
      )
    ).map((x) => x.payload);
    for (const e of [...this.fastEvents].reverse()) {
      this.fastIds.add(e.id);
      this.observe(e);
    }
    this.decisions = await this.store.recentDecisions(200);
    this.stateServer = createServer((req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", "application/json");
      if (req.method !== "GET") {
        res.writeHead(405);
        res.end(json({ error: "READ_ONLY" }));
        return;
      }
      if (req.url === "/state") {
        res.end(json(this.state()));
      } else if (req.url === "/health") {
        res.end(json(this.health));
      } else if (req.url === "/replay") {
        void this.exportReplay()
          .then((value) => res.end(json(value)))
          .catch(() => {
            res.writeHead(503);
            res.end(json({ error: "REPLAY_EXPORT_UNAVAILABLE" }));
          });
      } else if (req.url === "/quote-research") {
        void this.store
          .query("SELECT payload FROM phantom_quote_research ORDER BY at DESC LIMIT 10000")
          .then((rows) => res.end(json({ observations: rows.map((x) => x.payload) })))
          .catch(() => {
            res.writeHead(503);
            res.end(json({ error: "RESEARCH_EXPORT_UNAVAILABLE" }));
          });
      } else if (req.url === "/forward-cohorts") {
        if (!this.forwardRuntime) {
          res.writeHead(503);
          res.end(json({ error: "FORWARD_RESEARCH_DISABLED" }));
          return;
        }
        void this.forwardRuntime
          .history()
          .then((experiments) =>
            res.end(
              json({ activeExperimentId: this.forwardRuntime!.protocol.experimentId, experiments }),
            ),
          )
          .catch(() => {
            res.writeHead(503);
            res.end(json({ error: "FORWARD_HISTORY_UNAVAILABLE" }));
          });
      } else if (req.url === "/forward-cohort" || req.url?.startsWith("/forward-cohort?")) {
        if (!this.forwardRuntime) {
          res.writeHead(503);
          res.end(json({ error: "FORWARD_RESEARCH_DISABLED" }));
          return;
        }
        const url = new URL(req.url, "http://127.0.0.1");
        if (
          [...url.searchParams.keys()].some((key) => key !== "experiment") ||
          url.searchParams.getAll("experiment").length > 1
        ) {
          res.writeHead(400);
          res.end(json({ error: "INVALID_FORWARD_EXPORT_QUERY" }));
          return;
        }
        void this.exportForwardCohort(url.searchParams.get("experiment") ?? undefined)
          .then((value) => res.end(json(value)))
          .catch(() => {
            res.writeHead(404);
            res.end(json({ error: "FORWARD_EXPORT_UNAVAILABLE" }));
          });
      } else {
        res.writeHead(404);
        res.end(json({ error: "NOT_FOUND" }));
      }
    });
    const port = options.port ?? Number(process.env.PHANTOM_ENGINE_PORT ?? 8790);
    await new Promise<void>((resolve, reject) => {
      this.stateServer!.once("error", reject);
      this.stateServer!.listen(port, "127.0.0.1", () => resolve());
    });
    for (const e of await this.store.unevaluated()) this.schedule(e);
    if (options.stream !== false) {
      const receive = (tx: RpcTransaction, at: number, c: "confirmed" | "finalized") =>
        this.receive(tx, at, c);
      if (this.health.source === "yellowstone") {
        const endpoint = process.env.YELLOWSTONE_ENDPOINT;
        if (!endpoint) throw Error("YELLOWSTONE_ENDPOINT_REQUIRED");
        this.source = await startYellowstone(
          endpoint,
          process.env.YELLOWSTONE_TOKEN ?? "",
          this.health,
          receive,
          { store: this.store },
        );
      } else if (this.health.source === "rpc") {
        const url =
          process.env.SOLANA_WS_URL ??
          (process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com").replace(
            /^http/,
            "ws",
          );
        const source = new SolanaStream(this.rpc, url, this.store, this.health, receive, {
          onLogs: async (envelope) => {
            const enrichmentHints: LogEnrichmentHint[] = [];
            const events = await this.recordLogs(envelope, (hint) => enrichmentHints.push(hint));
            return { events, enrichmentHints };
          },
          isWatchedMint: (mint) =>
            this.launches.has(mint) || this.ledger.state.positions.some((p) => p.mint === mint),
          maxQueue: 200,
        });
        source.start();
        this.source = source;
        this.rpcSource = source;
      } else throw Error("UNSUPPORTED_STREAM_SOURCE");
    }
    this.timer = setInterval(() => {
      if (this.tickWork || this.stopped) return;
      this.tickWork = this.tick()
        .catch(() => this.fail("PAPER_POSITION_TICK_FAILED"))
        .finally(() => {
          this.tickWork = null;
        });
    }, 3000);
    this.researchTimer = setInterval(() => {
      if (this.researchWork || this.stopped || process.env.PHANTOM_QUOTE_RESEARCH === "false")
        return;
      this.researchWork = this.quoteResearch
        .tick(this.quote)
        .catch(() => this.fail("QUOTE_RESEARCH_HORIZON_FAILED"))
        .finally(() => {
          this.researchWork = null;
        });
    }, 3000);
    await this.store.save("ledger", this.ledger.state);
    return this;
  }
  setQuoteProvider(provider: QuoteProvider) {
    this.quote = provider;
  }
  async idle() {
    await this.work;
    await this.tickWork;
    await this.ledgerSaves;
  }
  private fail(code: string) {
    this.health.errors++;
    this.health.lastError = code;
    this.health.status = "DEGRADED";
  }
  async receive(tx: RpcTransaction, at: number, commitment: "confirmed" | "finalized") {
    const events = decodeTransaction(tx, at, commitment);
    await this.store.transaction(tx.transaction.signatures[0], tx.slot, tx);
    for (const e of events) {
      if (!(await this.store.event(e))) continue;
      this.health.decoded++;
      this.health.lastEventAt = Date.now();
      this.events.unshift(e);
      if (this.events.length > 2000) this.events.pop();
      this.observe(e);
      this.latencies.push(e.processedAt - at);
      if (this.latencies.length > 2000) this.latencies.shift();
      if (process.env.PHANTOM_QUOTE_RESEARCH !== "false")
        void this.quoteResearch
          .sample(e, this.quote)
          ?.catch(() => this.fail("QUOTE_RESEARCH_PERSISTENCE_FAILED"));
      this.schedule(e);
    }
  }
  async recordLogs(envelope: FinalizedLogEnvelope, onEnrichmentHint?: (hint: LogEnrichmentHint) => void) {
    const decoded = decodeLogNotification(
      envelope.logs,
      envelope.signature,
      envelope.slot,
      envelope.receivedAt,
      Date.now(),
      {
        onEnrichmentHint,
        resolvePool: (pool, protocol) => {
          const e = this.events.find((x) => x.pool === pool && x.protocol === protocol);
          return e ? { mint: e.mint, quoteMint: e.quoteMint } : undefined;
        },
      },
    );
    let events = decoded.filter((e) => !this.fastIds.has(e.id));
    if (events.length) {
      const values: unknown[] = [];
      const sql = events.map((event, i) => {
        values.push(event.id, event.signature, event.slot, event.receivedAt, json(event));
        const start = i * 5;
        return `($${start + 1},$${start + 2},$${start + 3},$${start + 4},$${start + 5}::jsonb)`;
      });
      const inserted = await this.store.exec(
        `INSERT INTO phantom_observed_events(id,signature,slot,received_at,payload) VALUES ${sql.join(",")} ON CONFLICT(id) DO NOTHING RETURNING id`,
        values,
      );
      const ids = new Set(inserted.rows.map((r) => r.id));
      events = events.filter((e) => ids.has(e.id));
      this.typedObserved += events.length;
    }
    for (const event of events) {
      this.fastIds.add(event.id);
      if (this.fastIds.size > 20000) this.fastIds.delete(this.fastIds.keys().next().value!);
      this.fastEvents.unshift(event);
      if (this.fastEvents.length > 2000) this.fastEvents.pop();
      this.observe(event);
      if (process.env.PHANTOM_QUOTE_RESEARCH !== "false")
        void this.quoteResearch
          .sample(event, this.quote)
          ?.catch(() => this.fail("QUOTE_RESEARCH_PERSISTENCE_FAILED"));
    }
    return decoded;
  }
  private observe(e: ChainEvent) {
    if (e.kind === "launch") {
      this.launches.set(e.mint, e);
      if (this.launches.size > 5000) this.launches.delete(this.launches.keys().next().value!);
    }
    if (
      (e.kind === "buy" || e.kind === "sell") &&
      e.amountRaw &&
      e.quoteAmountRaw &&
      e.quoteMint === WSOL
    ) {
      const key = [e.signature, e.mint, e.actor, e.kind, e.amountRaw, e.quoteAmountRaw].join(":");
      const fast = e.instructionIndex.startsWith("log:");
      if (fast) {
        const count = (this.fastTradeCounts.get(key) ?? 0) + 1;
        this.fastTradeCounts.set(key, count);
        if (this.fastTradeCounts.size > 20000)
          this.fastTradeCounts.delete(this.fastTradeCounts.keys().next().value!);
        if (count <= (this.materializedTrades.get(key) ?? 0)) return;
      }
      if (!fast) {
        this.materializedTrades.set(key, (this.materializedTrades.get(key) ?? 0) + 1);
        if (this.materializedTrades.size > 20000)
          this.materializedTrades.delete(this.materializedTrades.keys().next().value!);
        const replaced = this.trades.findIndex(
          (t) =>
            t.signature === e.signature &&
            t.mint === e.mint &&
            t.wallet === e.actor &&
            t.side === e.kind &&
            t.tokenAmount === BigInt(e.amountRaw!) &&
            t.quoteAmount === BigInt(e.quoteAmountRaw!) &&
            t.instructionIndex.startsWith("log:"),
        );
        if (replaced >= 0) this.trades.splice(replaced, 1);
      }
      this.trades.push({
        signature: e.signature,
        instructionIndex: e.instructionIndex,
        mint: e.mint,
        wallet: e.actor,
        side: e.kind,
        quoteAmount: BigInt(e.quoteAmountRaw),
        tokenAmount: BigInt(e.amountRaw),
        quoteMint: e.quoteMint,
        eventAt: e.blockTime == null ? e.receivedAt : e.blockTime * 1000,
        observedAt: e.receivedAt,
      });
      if (this.trades.length > 10_000) this.trades.shift();
    }
  }
  private collectWalletEvidence(event: ChainEvent) {
    if (process.env.PHANTOM_WALLET_HISTORY === "false") return;
    const related = new Set(this.trades.filter((t) => t.mint === event.mint).map((t) => t.wallet));
    const creator = this.launches.get(event.mint)?.creator;
    if (creator) related.add(creator);
    for (const wallet of [...related].slice(-3)) {
      if (this.walletJobs.size >= 2 || this.walletJobs.has(wallet)) continue;
      this.walletJobs.add(wallet);
      void this.walletReader
        .inspect(wallet, related)
        .catch(() => this.fail("WALLET_HISTORY_PROVIDER_UNAVAILABLE"))
        .finally(() => this.walletJobs.delete(wallet));
    }
  }
  private schedule(e: ChainEvent) {
    if (e.commitment !== "finalized") return;
    if (
      this.busyMints.has(e.mint) ||
      this.busyMints.size >= 10 ||
      Date.now() - (this.lastAnalysis.get(e.mint) ?? 0) < 15_000
    ) {
      void this.store.evaluated(e.id).catch(() => this.fail("EVENT_MARK_FAILED"));
      return;
    }
    this.busyMints.add(e.mint);
    this.lastAnalysis.set(e.mint, Date.now());
    if (this.lastAnalysis.size > 10000)
      this.lastAnalysis.delete(this.lastAnalysis.keys().next().value!);
    this.work = this.work
      .then(() => this.analyze(e))
      .then(() => this.store.evaluated(e.id))
      .catch(() => this.fail("EVENT_ANALYSIS_FAILED"))
      .finally(() => {
        this.busyMints.delete(e.mint);
      });
  }
  private feature(e: ChainEvent, snapshot?: SecuritySnapshot, costBps: number | null = null) {
    const launch = this.launches.get(e.mint);
    return featuresAt(this.trades, Date.now(), 30_000, this.intelligence, {
      mint: e.mint,
      quoteMint: e.quoteMint,
      launchAt: launch?.blockTime == null ? null : launch.blockTime * 1000,
      launchVerified: !!launch,
      creator: launch?.creator ?? e.creator,
      liquidityLamports: snapshot?.liquidityLamports ?? null,
      liquidityPreviousLamports: this.snapshots.get(e.mint)?.liquidityLamports,
      liquidityObservedAt: snapshot?.observedAt,
      curveProgressBps: snapshot?.curveProgressBps ?? null,
      curveObservedAt: snapshot?.observedAt,
      executionCostBps: costBps,
      executionObservedAt: Date.now(),
    });
  }
  private async decision(value: any) {
    this.decisions.unshift(value);
    if (this.decisions.length > 200) this.decisions.pop();
    if (!value.accepted) this.health.rejected++;
    await this.store.decision(value, value.at);
  }
  private async analyze(event: ChainEvent) {
    if (event.quoteMint !== WSOL) {
      await this.decision({
        at: Date.now(),
        mint: event.mint,
        strategy: "all",
        accepted: false,
        reasons: ["NON_SOL_QUOTE_UNSUPPORTED_BY_PAPER_LEDGER"],
      });
      return;
    }
    const executionReasons =
      event.details.executionSupported === false
        ? [
            event.details.transactionVersion === 1
              ? "TRANSACTION_V1_READ_ONLY_EXECUTION_UNCERTIFIED"
              : "EVENT_SCHEMA_PARTIALLY_VERIFIED_EXECUTION_UNSUPPORTED",
          ]
        : [];
    if (executionReasons.length)
      await this.decision({
        at: Date.now(),
        mint: event.mint,
        strategy: "execution",
        accepted: false,
        reasons: executionReasons,
      });
    const simple = this.feature(event);
    if (simple.observations < 3) {
      await this.decision({
        at: Date.now(),
        mint: event.mint,
        strategy: "all",
        accepted: false,
        reasons: ["INSUFFICIENT_VERIFIED_TRADE_OBSERVATIONS"],
      });
      return;
    }
    this.collectWalletEvidence(event);
    let buy, sell, snapshot: SecuritySnapshot;
    const amount = solAmount(process.env.PHANTOM_TRADE_SOL ?? "0.01");
    try {
      buy = await this.quote.quote({
        inputMint: WSOL,
        outputMint: event.mint,
        amount,
        slippageBps: 100,
      });
      sell = await this.quote.quote({
        inputMint: event.mint,
        outputMint: WSOL,
        amount: BigInt(buy.minOutAmount),
        slippageBps: 100,
      });
      snapshot = await this.security.inspect(
        { ...event, creator: this.launches.get(event.mint)?.creator ?? event.creator },
        { available: true, at: sell.observedAt },
      );
    } catch (err) {
      await this.decision({
        at: Date.now(),
        mint: event.mint,
        strategy: "all",
        accepted: false,
        reasons: [
          err instanceof Error && /^[A-Z_0-9]+$/.test(err.message)
            ? err.message
            : "QUOTE_OR_SECURITY_PROVIDER_UNAVAILABLE",
        ],
      });
      return;
    }
    const cost = conservativeCostBps(amount, BigInt(sell.minOutAmount), 20_000n);
    const feature = this.feature(event, snapshot, cost);
    if (feature.observations >= 3 && this.launches.has(event.mint))
      snapshot.evidence.abnormalCreatorActivity = feature.creatorSelling;
    const safety = checkTokenSafety(snapshot.evidence);
    this.snapshots.set(event.mint, snapshot);
    if (this.snapshots.size > 500) this.snapshots.delete(this.snapshots.keys().next().value!);
    await this.capture(event, feature, snapshot, buy, sell);
    for (const d of evaluateStrategies(feature)) {
      const reasons = [
        ...d.reasons,
        ...executionReasons,
        ...(!safety.allowed ? safety.reasons : []),
      ];
      const accepted = d.enter && safety.allowed && !executionReasons.length;
      await this.decision({
        at: Date.now(),
        mint: event.mint,
        strategy: d.strategy,
        accepted,
        reasons,
        score: d.score,
        organicDemandScore: feature.organic.score,
        walletEvidence: feature.organic.evidence,
        features: feature,
        securityWarnings: snapshot.warnings,
      });
      if (accepted) {
        this.ledger.queue(
          {
            id: `${event.id}:${d.strategy}`,
            mint: event.mint,
            strategy: d.strategy,
            amountLamports: amount,
            eventId: event.id,
          },
          Date.now(),
          Number(process.env.PHANTOM_MIN_DELAY_MS ?? 2000),
        );
        await this.persistLedger();
        break;
      }
    }
  }
  private async capture(
    event: ChainEvent,
    feature: ReturnType<typeof featuresAt>,
    snapshot: SecuritySnapshot,
    buy: Quote,
    sell: Quote,
  ) {
    const toReplay = (q: Quote) =>
      q.impactBps == null
        ? undefined
        : {
            observedAt: q.observedAt,
            ...(q.requestedAt !== undefined ? { requestedAt: q.requestedAt } : {}),
            inputRaw: q.inAmount,
            outputRaw: q.minOutAmount,
            networkFeeLamports: "10000",
            priceImpactBps: q.impactBps,
          };
    const at = Date.now();
    const value = replayObservationFromSnapshot({
      event: { ...event, id: `${event.id}:snapshot:${at}` },
      snapshotAt: at,
      regime: "unclassified",
      features: flattenReplayFeatures(feature, snapshot.evidence, {
        now: at,
        slippageBps: 100,
        killSwitch: this.ledger.state.killSwitch,
        consecutiveFailures: this.ledger.state.failures,
      }),
      buy: toReplay(buy),
      sell: toReplay(sell),
    });
    await this.store.exec(
      "INSERT INTO phantom_replay_observations(id,at,payload) VALUES($1,$2,$3::jsonb) ON CONFLICT(id) DO NOTHING",
      [value.id, value.at, json(value)],
    );
  }
  async tick() {
    if (this.stopped) return;
    if (!(await this.workerLeaseAvailable())) return;
    this.ledger.state.killSwitch = this.killed();
    this.managingPositions = true;
    try {
      await this.managePositions();
    } finally {
      this.managingPositions = false;
    }
    if (this.stopped || !(await this.workerLeaseAvailable())) return;
    for (const order of [...this.ledger.state.pending]) {
      if (Date.now() < order.readyAt) continue;
      let settled = false;
      try {
        const event =
          this.events.find((e) => e.id === order.eventId) ??
          this.events.find((e) => e.mint === order.mint);
        if (!event || event.details.executionSupported === false)
          throw Error("ENTRY_EVENT_UNSUPPORTED");
        const preliminary = await this.quote.quote({
          priority: "entry",
          inputMint: WSOL,
          outputMint: order.mint,
          amount: order.amountLamports,
          slippageBps: 100,
        });
        const route = await this.quote.quote({
          priority: "entry",
          inputMint: order.mint,
          outputMint: WSOL,
          amount: BigInt(preliminary.minOutAmount),
          slippageBps: 100,
        });
        const snapshot = await this.security.inspect(
          { ...event, creator: this.launches.get(event.mint)?.creator ?? event.creator },
          { available: true, at: route.observedAt },
        );
        // Reprice after slower security reads. An earlier quote cannot authorize a later fill.
        const quote = await this.quote.quote({
          priority: "entry",
          inputMint: WSOL,
          outputMint: order.mint,
          amount: order.amountLamports,
          slippageBps: 100,
        });
        const exitQuote = await this.quote.quote({
          priority: "entry",
          inputMint: order.mint,
          outputMint: WSOL,
          amount: BigInt(quote.minOutAmount),
          slippageBps: 100,
        });
        snapshot.evidence.sellRouteObservedAt = exitQuote.observedAt;
        snapshot.evidence.sellRouteAvailable = true;
        const cost = conservativeCostBps(
          order.amountLamports,
          BigInt(exitQuote.minOutAmount),
          20_000n,
        );
        const features = this.feature(event, snapshot, cost);
        snapshot.evidence.abnormalCreatorActivity =
          this.launches.has(event.mint) && features.observations >= 3
            ? features.creatorSelling
            : null;
        if (!evaluateStrategies(features).some((d) => d.strategy === order.strategy && d.enter))
          throw Error("SIGNAL_NO_LONGER_VALID_AT_FILL");
        this.ledger.state.killSwitch = this.killed();
        if (this.stopped) throw Error("WORKER_STOPPING_NO_ENTRY");
        if (!(await this.workerLeaseAvailable())) return;
        const verdict = this.ledger.fill(
          order,
          quote,
          checkTokenSafety(snapshot.evidence),
          snapshot.liquidityLamports,
          10_000n,
          Date.now(),
        );
        settled = verdict.allowed;
        if (!verdict.allowed)
          this.ledger.state.pending = this.ledger.state.pending.filter((x) => x.id !== order.id);
        await this.persistLedger();
        await this.capture(event, features, snapshot, quote, exitQuote);
        await this.decision({
          at: Date.now(),
          mint: order.mint,
          strategy: order.strategy,
          accepted: verdict.allowed,
          reasons: verdict.reasons,
        });
      } catch {
        if (settled) {
          await this.latchSuspension("PAPER_FILL_AUDIT_OR_DURABILITY_FAILED_POSITION_PRESERVED");
          continue;
        }
        this.ledger.state.pending = this.ledger.state.pending.filter((x) => x.id !== order.id);
        this.ledger.state.failures++;
        await this.decision({
          at: Date.now(),
          mint: order.mint,
          strategy: order.strategy,
          accepted: false,
          reasons: ["PAPER_ENTRY_FAILED_NO_FILL"],
        });
      }
    }
    this.ledger.recordEquity(Date.now());
    await this.persistLedger();
  }
  private async managePositions() {
    let requiredIntentAdded = false;
    // Persist every price-independent intent before the first provider await.
    // One slow position must not postpone another position's delay clock.
    for (const position of this.ledger.state.positions) {
      const previous = this.ledger.state.pendingExits.find((exit) => exit.positionId === position.id);
      const required = this.ledger.queueRequiredExit(
        position,
        Date.now(),
        Number(process.env.PHANTOM_MIN_DELAY_MS ?? 2000),
      );
      if (required && required !== previous) requiredIntentAdded = true;
    }
    if (requiredIntentAdded) await this.persistLedger();
    const readyExits = new Set(
      this.ledger.state.pendingExits
        .filter((exit) => exit.readyAt <= Date.now())
        .map((exit) => exit.positionId),
    );
    const positions = [...this.ledger.state.positions].sort(
      (a, b) => Number(readyExits.has(b.id)) - Number(readyExits.has(a.id)),
    );
    for (const p of positions) {
      try {
        const pending = this.ledger.state.pendingExits.find((x) => x.positionId === p.id);
        if (pending) {
          if (Date.now() < pending.readyAt) continue;
          const quote = await this.quote.quote({
            priority: "protective_exit",
            inputMint: p.mint,
            outputMint: WSOL,
            amount: pending.quantityRaw,
            slippageBps: pending.slippageBps,
          });
          if (!(await this.workerLeaseAvailable())) return;
          this.ledger.close(
            p,
            quote,
            pending.quantityRaw,
            10_000n,
            pending.reason,
            Date.now(),
            pending.id,
          );
          await this.persistLedger();
          continue;
        }
        const quote = await this.quote.quote({
          priority: "protective_exit",
          inputMint: p.mint,
          outputMint: WSOL,
          amount: p.quantityRaw,
          slippageBps: 100,
        });
        if (!(await this.workerLeaseAvailable())) return;
        this.ledger.mark(p, quote, 10_000n, Date.now());
        await this.persistLedger();
        const event = this.events.find((e) => e.mint === p.mint);
        const signal = event ? this.feature(event) : undefined;
        const exit = this.ledger.exitReason(p, Date.now(), signal);
        if (exit) {
          const qty = (p.quantityRaw * BigInt(exit.bps)) / 10_000n;
          this.ledger.queueExit(
            p,
            qty,
            exit.reason,
            Date.now(),
            Number(process.env.PHANTOM_MIN_DELAY_MS ?? 2000),
          );
          await this.persistLedger();
        }
      } catch {
        p.markLamports = null;
        p.markAt = null;
        this.ledger.state.failures++;
        this.ledger.recordEquity(Date.now());
        // Unknown valuation is economic state. Checkpoint it before audit
        // logging, which can fail independently and interrupt the tick.
        await this.persistLedger();
        await this.decision({
          at: Date.now(),
          mint: p.mint,
          strategy: p.strategy,
          accepted: false,
          reasons: ["EXIT_QUOTE_UNAVAILABLE_POSITION_UNRESOLVED"],
        });
      }
    }
  }
  private async workerLeaseAvailable() {
    try {
      this.store.assertWorkerLease();
      return true;
    } catch {
      await this.latchSuspension("DATABASE_WORKER_LEASE_LOST_ALL_SETTLEMENT_SUSPENDED");
      return false;
    }
  }
  private async latchSuspension(reason: string) {
    this.suspensionReason = reason;
    this.ledger.state.killSwitch = true;
    this.ledger.governor.kill();
    this.fail(reason);
    try {
      mkdirSync(dirname(this.killFile), { recursive: true });
      writeFileSync(
        this.killFile,
        json({ schema: "phantom-suspension-v1", reason, at: Date.now() }),
        { flag: "wx", mode: 0o600 },
      );
    } catch {}
    try {
      await this.store.save("suspension", { reason, at: Date.now() });
    } catch {}
  }
  private async persistLedger() {
    const save = this.ledgerSaves
      .catch(() => {})
      .then(() => this.store.save("ledger", this.ledger.state));
    this.ledgerSaves = save;
    try {
      await save;
    } catch {
      await this.latchSuspension("LEDGER_PERSISTENCE_FAILED_ENTRIES_SUSPENDED");
      throw Error("LEDGER_PERSISTENCE_FAILED");
    }
  }
  async exportReplay() {
    const configuration = await this.store.get("research-config");
    return {
      configuration,
      options: {
        strategy: configuration.strategy,
        initialCapitalLamports: this.ledger.state.initialLamports.toString(),
        minimumLatencyMs: 2000,
        maxQuoteAgeMs: 5000,
        maxImpactBps: 200,
        fixtureKind: "recorded-chain",
      },
      observations: (
        await this.store.query("SELECT payload FROM phantom_replay_observations ORDER BY at,id")
      ).map((x) => x.payload),
    };
  }
  private async exportForwardCohort(experimentId?: string) {
    if (!this.forwardRuntime) throw Error("FORWARD_RESEARCH_DISABLED");
    const value = await this.forwardRuntime.export(experimentId);
    // Read the original tagged delivery intents even for retired/closed cohorts.
    // Never initialize an old collector or create a later eligibility decision.
    const tagged = await this.store.query(
      `SELECT jsonb_build_object('mint',payload->>'mint','probeId',payload->'forwardProbe'->>'id',
         'phase',payload->>'phase') AS payload FROM phantom_quote_research
       WHERE payload->>'forwardExperimentId'=$1 AND at<=$2 ORDER BY at,id`,
      [value.protocol.experimentId, value.exportedAt],
    );
    const first = new Map<string, string>();
    for (const { payload } of tagged) {
      if (
        payload.phase !== "BASELINE" ||
        typeof payload.mint !== "string" ||
        !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(payload.mint) ||
        typeof payload.probeId !== "string" ||
        !/^[A-Za-z0-9:_-]{1,128}$/.test(payload.probeId)
      )
        throw Error("FORWARD_TAGGED_PROBE_INVALID");
      if (!first.has(payload.mint)) first.set(payload.mint, payload.probeId);
    }
    const enrollments = new Map(
      value.records.filter((r) => r.phase === "ENROLLMENT").map((r) => [r.mint, r]),
    );
    const missing = [...first.keys()].filter((mint) => !enrollments.has(mint)).length;
    const displaced = [...first].filter(
      ([mint, id]) => enrollments.has(mint) && enrollments.get(mint)!.data.probeId !== id,
    ).length;
    const unmatched = [...enrollments.keys()].filter((mint) => !first.has(mint)).length;
    return {
      ...value,
      probeDeliveryAudit: {
        version: 1,
        scope: "EXPLICITLY_TAGGED_BASELINES_ONLY",
        experimentId: value.protocol.experimentId,
        exportedAt: value.exportedAt,
        taggedBaselineRows: tagged.length,
        distinctTaggedMints: first.size,
        missingEnrollmentMints: missing,
        displacedFirstProbeMints: displaced,
        unmatchedEnrollmentMints: unmatched,
        status: missing || displaced || unmatched ? "INCOMPLETE" : "COMPLETE",
      },
    };
  }
  state() {
    const latency = [...this.latencies].sort((a, b) => a - b);
    this.health.latencyMs = {
      p50: latency.length ? latency[Math.floor(latency.length * 0.5)] : null,
      p95: latency.length
        ? latency[Math.min(latency.length - 1, Math.floor(latency.length * 0.95))]
        : null,
    };
    const l = this.ledger.state;
    const full = new Map<string, number>();
    for (const event of this.events) {
      const key = eventKey(event);
      full.set(key, (full.get(key) ?? 0) + 1);
    }
    const events = [
      ...this.events,
      ...this.fastEvents.filter((e) => {
        const key = eventKey(e),
          count = full.get(key) ?? 0;
        if (count) {
          full.set(key, count - 1);
          return false;
        }
        return true;
      }),
    ]
      .sort((a, b) => b.receivedAt - a.receivedAt)
      .slice(0, 200)
      .map((e) => ({
        ...e,
        verification:
          e.details.fullTransactionVerified === false ? "TYPED_PROGRAM_EVENT" : "FULL_TRANSACTION",
        instructionSchema: e.details.instructionSchema,
        eventSchema: e.details.eventSchema,
      }));
    return {
      application: "PHANTOM",
      sourceVersion: this.sourceVersion,
      strategyRules: { ...DEFAULT_STRATEGY_RULES },
      mode: "PAPER",
      startedAt: this.startedAt,
      now: Date.now(),
      health: {
        ...this.health,
        typedLogs: this.rpcSource?.logMetrics() ?? null,
        typedObserved: this.typedObserved,
        status:
          this.health.lastEventAt && Date.now() - this.health.lastEventAt > 60_000
            ? "STALE"
            : this.health.status,
      },
      events,
      decisions: this.decisions,
      positions: l.positions,
      trades: l.trades.slice(-1000),
      completedPositions: aggregateCompletedPositions(l.trades),
      equity: l.equity,
      cashLamports: l.cashLamports,
      pending: l.pending,
      research: this.quoteResearch?.status() ?? null,
      forwardResearch: this.forwardRuntime
        ? {
            experimentId: this.forwardRuntime.protocol.experimentId,
            configurationHash: this.forwardRuntime.protocol.configurationHash,
            enrollmentStart: this.forwardRuntime.protocol.enrollmentStart,
            enrollmentEnd: this.forwardRuntime.protocol.enrollmentEnd,
            security: this.forwardRuntime.protocol.security,
            scope: this.forwardRuntime.protocol.scope,
          }
        : null,
      limitations: this.limitations,
    };
  }
  async stop() {
    this.stopped = true;
    this.ledger.governor.kill();
    if (this.timer) clearInterval(this.timer);
    if (this.researchTimer) clearInterval(this.researchTimer);
    try {
      await this.source?.stop();
      await this.work;
      await this.tickWork;
      await this.researchWork;
      while (this.walletJobs.size) await new Promise((r) => setTimeout(r, 100));
      await this.quoteResearch.idle();
      await this.forwardRuntime?.idle();
      if (this.store.workerLeaseHealthy) await this.persistLedger();
    } finally {
      try {
        if (this.stateServer?.listening)
          await new Promise<void>((r) => this.stateServer!.close(() => r()));
      } finally {
        await this.store.close();
      }
    }
  }
}
