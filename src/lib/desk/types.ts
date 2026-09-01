import type { UniverseBucket } from "./buckets";
import type {
  FieldObs,
  GateResult,
  MarketTape,
  QuoteObs,
  SourceHealth,
  TokenSnapshot,
} from "./schema";

export type Regime = "meme_mania" | "trend" | "chop" | "risk_off";

export type StrategyId =
  | "launch_velocity_pullback"
  | "chop_mean_revert"
  | "trend_continuation"
  | "flat";

export type TokenLive = TokenSnapshot & {
  history: number[];
  prevLiq: number;
  prevVolume5m: number;
  prevBuyers: number;
  rugged: boolean;
};

export type Features = {
  tokenAgeS: number | null;
  bucket: UniverseBucket;
  ret1m: number;
  rv5m: number;
  volAccel: number;
  usdImbalance: number;
  holderGrowth5m: number;
  top10Pct: number | null;
  liqChange1m: number;
  liqMcapRatio: number;
  uniqueBuyerShare: number;
  mintAuth: number | null;
  freezeAuth: number | null;
  sellQuoteAvailable: number;
  maxDd5m: number;
  entryImpactPct: number | null;
  exitImpactPct: number | null;
  snapshotAgeMs: number;
  priceDisagreement: number | null;
};

export type FeatureMeta = Record<
  string,
  { source: string; eventTime: number; ingestedAt: number; lagMs: number }
>;

export type Predictions = {
  momentumScore: number;
  flowScore: number;
  safetyScore: number;
  edgeScore: number;
  pCatastrophic15m: number;
  pTpBeforeSl: number;
  returnQ50: number;
  maeQ90: number;
  mfeQ50: number;
  expectedExecCostBps: number;
  expectedNetEdgeBps: number;
  uncertainty: number;
};

export type GovernorVerdict = {
  approved: boolean;
  reasons: string[];
  sizedUsd: number;
  stressedLoss: number;
  stressedExitPct: number;
  entryImpactPct: number | null;
  exitImpactPct: number | null;
  unknownCount: number;
  layers: GateResult[];
};

export type Intent = {
  intentId: string;
  tokenAddress: string;
  symbol: string;
  strategyId: StrategyId;
  decisionTs: number;
  features: Features;
  featureMeta: FeatureMeta;
  predictions: Predictions;
  regime: Regime;
  governor: GovernorVerdict;
  snapshot: TokenSnapshot;
};

export type Position = {
  tokenAddress: string;
  symbol: string;
  strategyId: StrategyId;
  qty: number;
  entry: number;
  notional: number;
  openedAt: number;
  peak: number;
  remainder: number;
  entryImpactPct: number | null;
  exitQuoteImpactPct: number | null;
};

export type JournalEvent = {
  id: string;
  ts: number;
  kind: "fill" | "exit" | "reject" | "rug" | "listing" | "halt" | "regime" | "feed";
  symbol?: string;
  title: string;
  detail: string;
  pnl?: number;
};

export type PathTick = {
  ts: number;
  px: number;
  liq: number;
  sell: 0 | 1;
};

export type LedgerRow = {
  decision_id: string;
  event_time: number;
  ingested_at: number;
  decision_time: number;
  token: string;
  tokenAddress: string;
  pair_address: string;
  token_age: number | null;
  bucket: UniverseBucket;
  price: number | null;
  market_cap: number | null;
  liquidity: number | null;
  volume_1m: number | null;
  volume_5m: number | null;
  volume_acceleration: number;
  buy_sell_imbalance: number;
  unique_buyers: number | null;
  unique_sellers: number | null;
  holder_count: number | null;
  holder_concentration: number | null;
  mint_auth: number | null;
  freeze_auth: number | null;
  entry_impact: number | null;
  exit_impact: number | null;
  stressed_exit: number;
  momentum_score: number;
  flow_score: number;
  safety_score: number;
  edge_score: number;
  regime: Regime;
  strategy_id: string;
  strategy_version: string;
  governor_result: "authorized" | "vetoed";
  veto_reason: string;
  proposed_size: number;
  proposed_entry: number | null;
  proposed_stop: number | null;
  trade_taken: boolean;
  trade_action: "take" | "veto" | "ignore";
  sell_quote_available: boolean;
  feature_sources: FeatureMeta;
  features: Features;
  gates: GateResult[];
  path: PathTick[];
  price_after_1m: number | null;
  price_after_5m: number | null;
  price_after_15m: number | null;
  price_after_30m: number | null;
  price_after_1h: number | null;
  max_gain_5m: number | null;
  max_gain_15m: number | null;
  max_gain_1h: number | null;
  max_drawdown_5m: number | null;
  max_drawdown_15m: number | null;
  max_drawdown_1h: number | null;
  hit_plus_10_before_minus_10: boolean | null;
  hit_plus_20_before_minus_10: boolean | null;
  liquidity_collapse: boolean | null;
  sell_route_lost: boolean | null;
  rug_detected: boolean | null;
  simulated_entry: number | null;
  simulated_exit: number | null;
  net_execution_return: number | null;
  labels_complete: boolean;
  outcome: string;
};

export type SliceStats = {
  n: number;
  taken: number;
  labeled: number;
  sum5m: number;
  n5m: number;
  sumNet: number;
  nNet: number;
};

export type ResearchSummary = {
  considerations: number;
  vetoed: number;
  authorized: number;
  taken: number;
  labeled: number;
  incomplete: number;
  errors: number;
  byRegime: Record<Regime, SliceStats>;
  byBucket: Record<UniverseBucket, SliceStats>;
  byStrategy: Record<string, SliceStats>;
  coverage: Record<UniverseBucket, Record<Regime, number>>;
};

export type WorkerHealth = {
  status: "live" | "offline" | "starting";
  db: "neon" | "pglite" | "offline";
  uptimeMs: number;
  lastTickAt: number | null;
  lastMarketEventAt: number | null;
  lastProviderOkAt: number | null;
  tickCount: number;
  queueDepth: number;
  pendingLabels: number;
  oldestPendingAt: number | null;
  providerErrors: number;
  lastError: string | null;
};

export type DeskSnapshot = {
  now: number;
  running: boolean;
  halted: boolean;
  equity: number;
  cash: number;
  startEquity: number;
  dayPnl: number;
  regime: Regime;
  regimeP: Record<Regime, number>;
  solPrice: number;
  solRet5m: number;
  feedLagMs: number;
  tokens: TokenLive[];
  selected: string | null;
  positions: Position[];
  journal: JournalEvent[];
  rejects: Intent[];
  lastIntent: Intent | null;
  fills: number;
  winCount: number;
  lossCount: number;
  riskBps: number;
  maxPositions: number;
  slippageBps: number;
  sources: SourceHealth[];
  tapeAgeMs: number;
  lastTapeAt: number | null;
  realData: boolean;
  ledger: LedgerRow[];
  pending: LedgerRow[];
  research: ResearchSummary;
  lastConsidered: Record<string, number>;
  flushQueue: LedgerRow[];
  worker: WorkerHealth;
};


export type { FieldObs, GateResult, MarketTape, QuoteObs, SourceHealth, TokenSnapshot, UniverseBucket };
