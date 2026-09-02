export type SourceId =
  | "geckoterminal"
  | "dexscreener"
  | "jupiter"
  | "solana"
  | "helius"
  | "birdeye"
  | "rugcheck";

export type SourceStatus = "live" | "degraded" | "offline" | "unconfigured";

export type SourceHealth = {
  id: SourceId;
  status: SourceStatus;
  lagMs: number | null;
  lastOkAt: number | null;
  detail: string;
};

export type DataStatus = "VALID" | "UNKNOWN" | "STALE" | "ERROR";

export type FieldObs<T> = {
  value: T | null;
  eventTime: number;
  ingestedAt: number;
  source: SourceId | "derived";
  lagMs: number;
  stale?: boolean;
  error?: string | null;
  status?: DataStatus;
  errorCode?: string | null;
};

export type RouteState = "ROUTABLE" | "QUOTE_ONLY" | "NO_ROUTE" | "UNKNOWN" | "TIMEOUT" | "RATE_LIMITED" | "ERROR";

export type QuoteObs = {
  available: boolean;
  inMint: string;
  outMint: string;
  inAmount: string;
  outAmount: string;
  notionalUsd: number;
  priceImpactPct: number | null;
  impliedPriceUsd: number | null;
  routeLabels: string[];
  latencyMs: number;
  eventTime: number;
  ingestedAt: number;
  source: SourceId;
  error?: string;
  routeState?: RouteState;
  failureReason?: string | null;
};

export type TokenSnapshot = {
  address: string;
  pairAddress: string;
  symbol: string;
  name: string;
  decimals: number;
  createdAt: number | null;
  priceUsd: FieldObs<number>;
  priceCrossUsd: FieldObs<number>;
  liquidityUsd: FieldObs<number>;
  mcapUsd: FieldObs<number>;
  fdvUsd: FieldObs<number>;
  volume1mUsd: FieldObs<number>;
  volume5mUsd: FieldObs<number>;
  volume1hUsd: FieldObs<number>;
  buys5m: FieldObs<number>;
  sells5m: FieldObs<number>;
  uniqueBuyers5m: FieldObs<number>;
  uniqueSellers5m: FieldObs<number>;
  holders: FieldObs<number>;
  top10Pct: FieldObs<number>;
  top20Pct?: FieldObs<number>;
  largestHolderPct?: FieldObs<number>;
  mintAuth: FieldObs<boolean>;
  freezeAuth: FieldObs<boolean>;
  buyQuote: QuoteObs | null;
  sellQuote: QuoteObs | null;
};

export type MarketTape = {
  ingestedAt: number;
  eventTime: number;
  fetchMs: number;
  solPriceUsd: number | null;
  tokens: TokenSnapshot[];
  sources: SourceHealth[];
};

export type GateName =
  | "Contract risk"
  | "Holder concentration"
  | "Liquidity"
  | "Exit route"
  | "Data freshness"
  | "Price impact"
  | "Portfolio exposure"
  | "Daily drawdown"
  | "Regime risk"
  | "Execution conditions";

export type GateStatus = "PASS" | "FAIL" | "UNKNOWN";

export type GateResult = {
  name: GateName;
  status: GateStatus;
  reason: string;
  reasonCode?: string;
  provider?: string;
  eventTime?: number;
  ingestedAt?: number;
};

export const WSOL = "So11111111111111111111111111111111111111112";
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const START_EQUITY = 25_000;
export const STALE_MS = 45_000;
export const HEARTBEAT_STALE_MS = 90_000;
export const MAX_STRESSED_EXIT_PCT = 0.07;
export const SLIPPAGE_BPS_DEFAULT = 50;
export const CONSIDER_COOLDOWN_MS = 20_000;
export const MIN_LIQ_USD = 35_000;
export const LEDGER_MEMORY = 80;
export const LEDGER_PENDING_MAX = 2500;
export const LEDGER_ARCHIVE_MAX = 50_000;
export const STRATEGY_VERSION = "3.3.0";
export const LIQ_COLLAPSE_THRESHOLD = 0.6;
export const PATH_MIN_INTERVAL_MS = 3_000;
