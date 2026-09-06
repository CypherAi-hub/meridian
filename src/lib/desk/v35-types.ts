import type { BarrierConfidence, BarrierOutcome } from "./types.ts";

export type DataStatus = "OK" | "UNKNOWN" | "NOT_COLLECTED" | "UNAVAILABLE" | "NOT_APPLICABLE" | "STALE";

export type ParticipantEventType =
  | "BUY"
  | "SELL"
  | "TRANSFER"
  | "LIQUIDITY_ADD"
  | "LIQUIDITY_REMOVE"
  | "ROUTE_ACTIVITY"
  | "HOLDER_CHANGE"
  | "UNKNOWN";

export type ParticipantEvent = {
  id: string;
  instrumentId: string;
  tokenMint: string | null;
  eventTime: number;
  ingestedAt: number;
  providerId: string;
  providerEventId: string | null;
  eventType: ParticipantEventType;
  walletId: string;
  counterpartyId: string | null;
  baseAmount: number | null;
  quoteAmount: number | null;
  usdNotional: number | null;
  observedPrice: number | null;
  transactionSignature: string | null;
  dataStatus: DataStatus;
  collectionEpoch: string;
  schemaVersion: string;
};

export type ParticipantCapability =
  | "WALLET_TX_FLOW"
  | "TRANSFER_GRAPH"
  | "TOKEN_BALANCES"
  | "HOLDER_LIST"
  | "FIRST_SEEN"
  | "LIQUIDITY_EVENTS"
  | "ROUTE_ACTIVITY";

export type WindowFeatures = {
  uniqueBuyers: number | null;
  uniqueSellers: number | null;
  newBuyers: number | null;
  repeatBuyers: number | null;
  newBuyerRatio: number | null;
  repeatBuyerRatio: number | null;
  buyerGrowthRate: number | null;
  sellerGrowthRate: number | null;
  buyNotional: number | null;
  sellNotional: number | null;
  netNotionalFlow: number | null;
  medianBuySize: number | null;
  medianSellSize: number | null;
  top1BuyerShare: number | null;
  top5BuyerShare: number | null;
  top1SellerShare: number | null;
  flowHhiBuy: number | null;
  walletEntryVelocity: number | null;
  newWalletShare: number | null;
  liquidityDeltaPct: number | null;
  priceChange: number | null;
  priceChangePerNetBuy: number | null;
  coverage: number;
  unknownRatio: number;
};

export type ParticipantFeatureVector = {
  instrumentId: string;
  featureTime: number;
  ingestedAt: number;
  featureVersion: string;
  w10s: WindowFeatures;
  w30s: WindowFeatures;
  w60s: WindowFeatures;
  w5m: WindowFeatures;
  priceUpFlowDown: boolean;
  priceUpLiquidityDown: boolean;
  eventCoverage: number;
  walletIdentityCoverage: number;
  notionalCoverage: number;
  freshnessMs: number;
  maxEventGapMs: number | null;
  dataStatus: DataStatus;
};

export type BehaviorCandidate =
  | "ACCUMULATION_CANDIDATE"
  | "DISTRIBUTION_CANDIDATE"
  | "CAPITULATION_CANDIDATE"
  | "FOMO_CANDIDATE"
  | "EXHAUSTION_CANDIDATE"
  | "ABSORPTION_CANDIDATE"
  | "LIQUIDITY_FLIGHT_CANDIDATE"
  | "LARGE_WALLET_ACCUMULATION_CANDIDATE"
  | "LARGE_WALLET_DISTRIBUTION_CANDIDATE"
  | "NEW_BUYER_CHASE_CANDIDATE"
  | "UNKNOWN";

export type TriggerFamily =
  | "MOMENTUM_ACCELERATION"
  | "PARTICIPANT_EXPANSION"
  | "LARGE_WALLET"
  | "LIQUIDITY_EVENT"
  | "DISTRIBUTION_DIVERGENCE"
  | "ABSORPTION"
  | "CAPITULATION";

export type SniperTrigger = {
  fired: boolean;
  family: TriggerFamily | null;
  reasonCodes: string[];
  interestScore: number;
  fingerprint: string;
  suppressed?: "cooldown" | "budget" | null;
};

export type SniperSessionState = "ACTIVE" | "COMPLETED" | "EXPIRED" | "ABORTED_DATA_QUALITY" | "ABORTED_PROVIDER";

export type SniperWatchPhase = "DISCOVERED" | "WATCH" | "TRIGGERED" | "SNIPER_ACTIVE" | "COOLDOWN" | "COMPLETED";

export type SniperSession = {
  id: string;
  instrumentId: string;
  tokenMint: string | null;
  triggerVersion: string;
  triggerTime: number;
  triggerIngestedAt: number;
  triggerReasonCodes: string[];
  family: TriggerFamily;
  sessionState: SniperSessionState;
  watchPhase: SniperWatchPhase;
  priority: number;
  fingerprint: string;
  collectionEpoch: string;
  commitSha: string;
};

export type SniperCounterfactual = {
  id: string;
  sessionId: string;
  instrumentId: string;
  referenceTime: number;
  referencePrice: number;
  hypotheticalEntryBasis: "TRIGGER" | "TRIGGER_PLUS_3S" | "TRIGGER_PLUS_10S" | "TRIGGER_PLUS_30S";
  executionAssumptionVersion: string;
};

export type SniperOutcome = {
  sessionId: string;
  maxReturn30s: number | null;
  maxReturn60s: number | null;
  maxReturn5m: number | null;
  maxReturn15m: number | null;
  maxDrawdown5m: number | null;
  upper5BeforeLower5: BarrierOutcome;
  upper10BeforeLower10: BarrierOutcome;
  upper20BeforeLower10: BarrierOutcome;
  liquidityCollapse: boolean | null;
  routeLost: boolean | null;
  rugOutcome: boolean | null;
  theoreticalReturn: number | null;
  executionAdjustedReturn: number | null;
  barrierConfidence: BarrierConfidence;
  outcomeStatus: "COMPLETE" | "AMBIGUOUS" | "INSUFFICIENT_DATA" | "PENDING";
};

export type WalletCohortId =
  | "NEW_WALLET"
  | "LOW_HISTORY"
  | "HIGH_HISTORY"
  | "FAST_ROTATOR"
  | "MEDIUM_HOLD"
  | "LONGER_HOLD"
  | "EARLY_ENTRY_REPEAT"
  | "LATE_CHASER_CANDIDATE"
  | "HIGH_RUG_EXPOSURE"
  | "LOW_RUG_EXPOSURE"
  | "EARLY_DISTRIBUTOR_CANDIDATE"
  | "UNKNOWN";
