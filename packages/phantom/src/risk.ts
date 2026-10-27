import {
  evaluateResearchPaperAdmission,
  validateResearchPaperPolicy,
  type ResearchPaperPolicy,
  type ResearchPaperDecisionEvidence,
  type ResearchPaperAdmission,
} from "./research-paper-policy.ts";

/** Pure, deterministic final authority. Quotes and safety evidence are never a guarantee. */
export interface TokenSafetyEvidence {
  mint: string;
  observedAt: number;
  /** Actual start of the evidence read. Publication cannot renew the age of its original controls. */
  evidenceRequestedAt?: number;
  mintAuthority: string | null | undefined;
  freezeAuthority: string | null | undefined;
  tokenProgram: "spl-token" | "token-2022" | "unknown";
  extensionsVerified: boolean;
  extensions: string[];
  transferFeeBps: number | null;
  permanentDelegate: string | null | undefined;
  transferRestricted: boolean | null;
  creatorConcentrationBps: number | null;
  /** Direct creator balances are only a lower bound. Missing/partial association coverage is not verified. */
  creatorAssociationsVerified?: boolean;
  creatorAssociatedConcentrationBps?: number | null;
  topHolderConcentrationBps: number | null;
  knownMalicious: boolean | null;
  sellRouteAvailable: boolean | null;
  sellRouteObservedAt: number | null;
  liquidityAccessible: boolean | null;
  abnormalCreatorActivity: boolean | null;
}
export interface SafetyPolicy {
  maxAgeMs: number;
  maxTransferFeeBps: number;
  maxCreatorConcentrationBps: number;
  maxTopHolderConcentrationBps: number;
  /** Explicit reviewed extension allowlist. Any other Token-2022 extension is rejected. */
  allowedExtensions: string[];
}
export const DEFAULT_SAFETY_POLICY: SafetyPolicy = {
  maxAgeMs: 30_000,
  maxTransferFeeBps: 0,
  maxCreatorConcentrationBps: 1_000,
  maxTopHolderConcentrationBps: 3_500,
  allowedExtensions: ["MetadataPointer", "TokenMetadata", "ImmutableOwner"],
};
export interface SafetyVerdict {
  mint: string;
  allowed: boolean;
  checkedAt: number;
  expiresAt: number;
  reasons: string[];
}

export function checkTokenSafety(
  e: TokenSafetyEvidence,
  policy: SafetyPolicy = DEFAULT_SAFETY_POLICY,
  now = Date.now(),
): SafetyVerdict {
  const reasons: string[] = [];
  const evidenceAnchor = e.evidenceRequestedAt === undefined ? e.observedAt : e.evidenceRequestedAt;
  if (!Number.isSafeInteger(e.observedAt) || e.observedAt < 0 || e.observedAt > now ||
    !Number.isSafeInteger(evidenceAnchor) || evidenceAnchor < 0 || evidenceAnchor > e.observedAt ||
    now - evidenceAnchor > policy.maxAgeMs)
    reasons.push("SECURITY_EVIDENCE_STALE_OR_FUTURE");
  if (e.mintAuthority === undefined) reasons.push("MINT_AUTHORITY_UNKNOWN");
  else if (e.mintAuthority !== null) reasons.push("MINT_AUTHORITY_ACTIVE");
  if (e.freezeAuthority === undefined) reasons.push("FREEZE_AUTHORITY_UNKNOWN");
  else if (e.freezeAuthority !== null) reasons.push("FREEZE_AUTHORITY_ACTIVE");
  if (e.tokenProgram !== "spl-token" && e.tokenProgram !== "token-2022")
    reasons.push("TOKEN_PROGRAM_UNSUPPORTED");
  if (!e.extensionsVerified) reasons.push("TOKEN_EXTENSIONS_UNVERIFIED");
  if (e.tokenProgram === "token-2022")
    for (const extension of e.extensions)
      if (!policy.allowedExtensions.includes(extension))
        reasons.push(`UNSUPPORTED_TOKEN_EXTENSION:${extension}`);
  if (e.permanentDelegate === undefined) reasons.push("PERMANENT_DELEGATE_UNKNOWN");
  else if (e.permanentDelegate !== null) reasons.push("PERMANENT_DELEGATE_ACTIVE");
  if (e.transferRestricted !== false)
    reasons.push(e.transferRestricted ? "TRANSFER_RESTRICTED" : "TRANSFER_RESTRICTIONS_UNKNOWN");
  if (
    e.transferFeeBps == null ||
    !Number.isInteger(e.transferFeeBps) ||
    e.transferFeeBps < 0 ||
    e.transferFeeBps > policy.maxTransferFeeBps
  )
    reasons.push("TRANSFER_FEES_UNKNOWN_OR_EXCESSIVE");
  if (
    e.creatorConcentrationBps == null ||
    !Number.isFinite(e.creatorConcentrationBps) ||
    e.creatorConcentrationBps < 0 ||
    e.creatorConcentrationBps > policy.maxCreatorConcentrationBps
  )
    reasons.push("CREATOR_CONCENTRATION_UNKNOWN_OR_EXCESSIVE");
  if (e.creatorAssociationsVerified !== true) reasons.push("CREATOR_ASSOCIATIONS_UNVERIFIED");
  if (
    e.creatorAssociatedConcentrationBps == null ||
    !Number.isFinite(e.creatorAssociatedConcentrationBps) ||
    e.creatorAssociatedConcentrationBps < 0 ||
    e.creatorAssociatedConcentrationBps > policy.maxCreatorConcentrationBps
  )
    reasons.push("CREATOR_ASSOCIATED_CONCENTRATION_UNKNOWN_OR_EXCESSIVE");
  else if (
    e.creatorConcentrationBps != null &&
    Number.isFinite(e.creatorConcentrationBps) &&
    e.creatorAssociatedConcentrationBps < e.creatorConcentrationBps
  )
    reasons.push("CREATOR_ASSOCIATED_CONCENTRATION_BELOW_DIRECT_LOWER_BOUND");
  if (
    e.topHolderConcentrationBps == null ||
    !Number.isFinite(e.topHolderConcentrationBps) ||
    e.topHolderConcentrationBps < 0 ||
    e.topHolderConcentrationBps > policy.maxTopHolderConcentrationBps
  )
    reasons.push("HOLDER_CONCENTRATION_UNKNOWN_OR_EXCESSIVE");
  if (e.knownMalicious !== false)
    reasons.push(
      e.knownMalicious ? "MALICIOUS_CONFIGURATION" : "MALICIOUS_CONFIGURATION_UNCHECKED",
    );
  if (e.sellRouteAvailable !== true) reasons.push("SELL_ROUTE_UNAVAILABLE_OR_UNKNOWN");
  if (
    e.sellRouteObservedAt == null ||
    e.sellRouteObservedAt > now ||
    now - e.sellRouteObservedAt > policy.maxAgeMs
  )
    reasons.push("SELL_ROUTE_STALE_OR_FUTURE");
  if (e.liquidityAccessible !== true) reasons.push("LIQUIDITY_ACCESS_UNKNOWN_OR_RESTRICTED");
  if (e.abnormalCreatorActivity !== false) reasons.push("ABNORMAL_CREATOR_ACTIVITY_OR_UNKNOWN");
  return {
    mint: e.mint,
    allowed: reasons.length === 0,
    checkedAt: now,
    expiresAt: Math.min(
      evidenceAnchor + policy.maxAgeMs,
      (e.sellRouteObservedAt ?? 0) + policy.maxAgeMs,
    ),
    reasons: reasons.length ? reasons : ["CHECKS_PASSED_FUTURE_SELLABILITY_NOT_GUARANTEED"],
  };
}

export interface RiskLimits {
  maxPerTradeLamports: bigint;
  maxCapitalPerTradeBps: number;
  maxPositions: number;
  dailyRealizedLossLimitLamports: bigint;
  maxDrawdownBps: number;
  maxExposureBps: number;
  minReserveLamports: bigint;
  maxConsecutiveFailures: number;
  minLiquidityLamports: bigint;
  maxImpactBps: number;
  maxSlippageBps: number;
  maxFeeLamports: bigint;
  maxQuoteAgeMs: number;
  authorizationTtlMs: number;
}
export const DEFAULT_RISK_LIMITS: RiskLimits = {
  maxPerTradeLamports: 100_000_000n,
  maxCapitalPerTradeBps: 200,
  maxPositions: 3,
  dailyRealizedLossLimitLamports: 200_000_000n,
  maxDrawdownBps: 1_000,
  maxExposureBps: 1_000,
  minReserveLamports: 100_000_000n,
  maxConsecutiveFailures: 3,
  minLiquidityLamports: 20_000_000_000n,
  maxImpactBps: 200,
  maxSlippageBps: 100,
  maxFeeLamports: 1_000_000n,
  maxQuoteAgeMs: 5_000,
  authorizationTtlMs: 2_000,
};
export interface PortfolioRiskState {
  equityLamports: bigint;
  peakEquityLamports: bigint;
  cashLamports: bigint;
  exposureLamports: bigint;
  openPositions: number;
  dailyRealizedPnlLamports: bigint;
  consecutiveFailures: number;
  killSwitch: boolean;
}
export interface TradeProposal {
  orderId: string;
  mint: string;
  strategy: string;
  amountLamports: bigint;
  feeLamports: bigint;
  liquidityLamports: bigint | null;
  impactBps: number | null;
  slippageBps: number;
  quoteObservedAt: number;
}
export interface RiskAuthorization {
  orderId: string;
  mint: string;
  allowed: boolean;
  reasons: string[];
  expiresAt: number;
  reservedLamports: bigint;
}

/** Research limits are a frozen engineering profile, never live approval. */
export const RESEARCH_PAPER_RISK_LIMITS: Readonly<RiskLimits> = Object.freeze({
  ...DEFAULT_RISK_LIMITS,
  maxPerTradeLamports: 10_000_000n,
  maxPositions: 1,
  maxSlippageBps: 25,
  maxFeeLamports: 10_000n,
});
export interface ResearchRiskBook {
  readonly bookId: string;
  readonly policy: ResearchPaperPolicy;
}
export interface ResearchRiskAuthorization {
  readonly kind: "RESEARCH_PAPER_CAPITAL_AUTHORIZATION";
  readonly allowedForResearch: boolean;
  readonly bookId: string;
  readonly policyHash: string;
  readonly orderId: string;
  readonly mint: string;
  readonly reasons: readonly string[];
  readonly expiresAt: number;
  readonly reservedLamports: bigint;
  readonly admission: ResearchPaperAdmission;
}
type IssuedAuthorization = RiskAuthorization | ResearchRiskAuthorization;

/** One governor per portfolio; durable transactional lock is required across processes. */
export class RiskGovernor {
  private reservations = new Map<
    string,
    { mint: string; amount: bigint; exposure: bigint; expiresAt: number }
  >();
  private completed = new Set<string>();
  private killed = false;
  readonly limits: Readonly<RiskLimits>;
  #research: Readonly<ResearchRiskBook> | null;
  #issued = new WeakMap<object, TradeProposal>();
  get researchBook() { return this.#research; }
  constructor(limits: RiskLimits = DEFAULT_RISK_LIMITS, research?: ResearchRiskBook) {
    this.#research = research ? Object.freeze({
      bookId: research.bookId,
      policy: validateResearchPaperPolicy(research.policy),
    }) : null;
    if (research) {
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(research.bookId)) throw Error("RESEARCH_BOOK_ID_INVALID");
      const keys = Object.keys(RESEARCH_PAPER_RISK_LIMITS) as (keyof RiskLimits)[];
      if (Object.keys(limits).length !== keys.length || keys.some((k) => limits[k] !== RESEARCH_PAPER_RISK_LIMITS[k]))
        throw Error("RESEARCH_RISK_PROFILE_MISMATCH");
    }
    for (const n of [
      limits.maxCapitalPerTradeBps,
      limits.maxDrawdownBps,
      limits.maxExposureBps,
      limits.maxImpactBps,
      limits.maxSlippageBps,
    ])
      if (!Number.isInteger(n) || n < 0 || n > 10_000)
        throw new Error("Invalid basis point risk limit");
    for (const n of [
      limits.maxPerTradeLamports,
      limits.dailyRealizedLossLimitLamports,
      limits.minReserveLamports,
      limits.minLiquidityLamports,
      limits.maxFeeLamports,
    ])
      if (n < 0n) throw new Error("Negative risk limit");
    if (
      !Number.isInteger(limits.maxPositions) ||
      limits.maxPositions < 1 ||
      !Number.isInteger(limits.maxConsecutiveFailures) ||
      limits.maxConsecutiveFailures < 1 ||
      limits.maxQuoteAgeMs <= 0 ||
      limits.authorizationTtlMs <= 0
    )
      throw new Error("Invalid risk limits");
    this.limits = Object.freeze({ ...limits });
  }
  kill(): void {
    this.killed = true;
  }
  isKilled(): boolean {
    return this.killed;
  }
  /** Liquidations remain possible under a kill switch; execution limits still have final authority. */
  authorizeExit(
    p: {
      orderId: string;
      mint: string;
      quantityRaw: bigint;
      positionQuantityRaw: bigint;
      feeLamports: bigint;
      quoteObservedAt: number;
      slippageBps: number;
      impactBps: number | null;
    },
    now = Date.now(),
  ): { allowed: boolean; reasons: string[]; expiresAt: number } {
    const reasons: string[] = [];
    if (!p.orderId || !p.mint || this.completed.has(p.orderId))
      reasons.push("DUPLICATE_OR_INVALID_EXIT");
    if (p.quantityRaw <= 0n || p.quantityRaw > p.positionQuantityRaw)
      reasons.push("EXIT_EXCEEDS_CONFIRMED_POSITION");
    if (p.feeLamports < 0n || p.feeLamports > this.limits.maxFeeLamports)
      reasons.push("EXIT_FEE_BUDGET_EXCEEDED");
    if (
      !Number.isFinite(p.quoteObservedAt) ||
      p.quoteObservedAt > now ||
      now - p.quoteObservedAt > this.limits.maxQuoteAgeMs
    )
      reasons.push("EXIT_QUOTE_STALE_OR_FUTURE");
    if (
      !Number.isInteger(p.slippageBps) ||
      p.slippageBps < 0 ||
      p.slippageBps > this.limits.maxSlippageBps
    )
      reasons.push("EXIT_SLIPPAGE_LIMIT");
    if (
      p.impactBps == null ||
      !Number.isFinite(p.impactBps) ||
      p.impactBps < 0 ||
      p.impactBps > this.limits.maxImpactBps
    )
      reasons.push("EXIT_PRICE_IMPACT_UNKNOWN_OR_HIGH");
    return {
      allowed: reasons.length === 0,
      reasons: reasons.length ? reasons : ["RISK_EXIT_APPROVED"],
      expiresAt: Math.min(
        now + this.limits.authorizationTtlMs,
        p.quoteObservedAt + this.limits.maxQuoteAgeMs,
      ),
    };
  }
  private prune(now: number): void {
    for (const [id, r] of this.reservations) if (r.expiresAt < now) this.reservations.delete(id);
  }

  authorize(
    p: TradeProposal,
    state: PortfolioRiskState,
    safety: SafetyVerdict,
    now = Date.now(),
  ): RiskAuthorization {
    const reasons: string[] = [];
    if (this.#research) reasons.push("STRICT_AUTHORIZATION_REQUIRES_STRICT_BOOK");
    if (
      safety.allowed !== true || safety.mint !== p.mint ||
      !Number.isSafeInteger(safety.checkedAt) || safety.checkedAt > now ||
      !Number.isSafeInteger(safety.expiresAt) || safety.expiresAt < now
    ) reasons.push("TOKEN_SAFETY_VETO");
    const authorization = this.authorizeEntry(p, state, safety.expiresAt, reasons, now);
    return this.issue(authorization, p, authorization.allowed);
  }

  /** Recomputes the original research evidence; a caller Boolean is never capital authority. */
  authorizeResearch(
    p: TradeProposal,
    state: PortfolioRiskState,
    evidence: ResearchPaperDecisionEvidence,
    now: number,
  ): ResearchRiskAuthorization {
    const book = this.#research;
    if (!book) throw Error("RESEARCH_AUTHORIZATION_REQUIRES_RESEARCH_BOOK");
    const admission = evaluateResearchPaperAdmission(book.policy, evidence, now);
    const reasons = [...admission.reasons];
    if (
      p.mint !== evidence.security.mint || p.strategy !== book.policy.strategy ||
      p.amountLamports.toString() !== evidence.quote.inputLamports ||
      p.feeLamports.toString() !== book.policy.networkFeePerLegLamports ||
      p.liquidityLamports !== evidence.features.liquidityLamports ||
      p.slippageBps !== book.policy.slippageBps ||
      p.quoteObservedAt !== evidence.quote.observedAt ||
      evidence.openPositions !== state.openPositions
    ) reasons.push("RESEARCH_PROPOSAL_EVIDENCE_OR_PORTFOLIO_MISMATCH");
    const capital = this.authorizeEntry(p, state, admission.expiresAt, reasons, now);
    const authorization: ResearchRiskAuthorization = {
      kind: "RESEARCH_PAPER_CAPITAL_AUTHORIZATION",
      allowedForResearch: capital.allowed,
      bookId: book.bookId,
      policyHash: book.policy.manifestHash,
      orderId: p.orderId,
      mint: p.mint,
      reasons: capital.reasons,
      expiresAt: capital.expiresAt,
      reservedLamports: capital.reservedLamports,
      admission,
    };
    return this.issue(authorization, p, authorization.allowedForResearch);
  }
  private issue<T extends IssuedAuthorization>(authorization: T, proposal: TradeProposal, allowed: boolean): T {
    Object.freeze(authorization);
    if (allowed) this.#issued.set(authorization, Object.freeze({ ...proposal }));
    return authorization;
  }
  /** Only an actual issuance from this governor can be consumed, once, with its exact proposal. */
  consumeAuthorization(authorization: IssuedAuthorization, proposal: TradeProposal, now: number) {
    const issued = this.#issued.get(authorization);
    if (!issued || Object.keys(issued).some((key) => issued[key as keyof TradeProposal] !== proposal[key as keyof TradeProposal]))
      throw Error("CAPITAL_AUTHORIZATION_NOT_ISSUED_OR_PROPOSAL_MISMATCH");
    if (!Number.isSafeInteger(authorization.expiresAt) || authorization.expiresAt < now)
      throw Error("CAPITAL_AUTHORIZATION_EXPIRED");
    this.complete(proposal.orderId, now);
    this.#issued.delete(authorization);
  }
  private authorizeEntry(
    p: TradeProposal,
    state: PortfolioRiskState,
    evidenceExpiresAt: number,
    reasons: string[],
    now: number,
  ): RiskAuthorization {
    if (!Number.isSafeInteger(now) || now < 0) throw Error("INVALID_RISK_TIMESTAMP");
    this.prune(now);
    const l = this.limits;
    if (!Number.isSafeInteger(evidenceExpiresAt) || evidenceExpiresAt < now)
      reasons.push("ADMISSION_DEADLINE_INVALID_OR_EXPIRED");
    if (this.killed || state.killSwitch) reasons.push("GLOBAL_KILL_SWITCH");
    if (!p.orderId || this.reservations.has(p.orderId) || this.completed.has(p.orderId))
      reasons.push("DUPLICATE_OR_INVALID_ORDER");
    if (
      state.equityLamports <= 0n ||
      state.peakEquityLamports < state.equityLamports ||
      state.cashLamports < 0n ||
      state.exposureLamports < 0n ||
      !Number.isInteger(state.openPositions) ||
      state.openPositions < 0 ||
      !Number.isInteger(state.consecutiveFailures) ||
      state.consecutiveFailures < 0
    )
      reasons.push("INVALID_PORTFOLIO_STATE");
    if (p.amountLamports <= 0n || p.amountLamports > l.maxPerTradeLamports)
      reasons.push("MAX_SOL_PER_TRADE");
    if (p.amountLamports * 10_000n > state.equityLamports * BigInt(l.maxCapitalPerTradeBps))
      reasons.push("MAX_CAPITAL_PERCENT_PER_TRADE");
    const reserved = [...this.reservations.values()].reduce((n, r) => n + r.amount, 0n);
    const exposureReserved = [...this.reservations.values()].reduce((n, r) => n + r.exposure, 0n);
    if (state.openPositions + this.reservations.size >= l.maxPositions)
      reasons.push("MAX_SIMULTANEOUS_POSITIONS");
    if ([...this.reservations.values()].some((r) => r.mint === p.mint))
      reasons.push("MINT_ENTRY_ALREADY_PENDING");
    if (state.dailyRealizedPnlLamports <= -l.dailyRealizedLossLimitLamports)
      reasons.push("DAILY_REALIZED_LOSS_LIMIT");
    if (
      state.peakEquityLamports > 0n &&
      (state.peakEquityLamports - state.equityLamports) * 10_000n >=
        state.peakEquityLamports * BigInt(l.maxDrawdownBps)
    )
      reasons.push("MAX_PORTFOLIO_DRAWDOWN");
    if (state.consecutiveFailures >= l.maxConsecutiveFailures)
      reasons.push("REPEATED_EXECUTION_FAILURES");
    if (p.feeLamports < 0n || p.feeLamports > l.maxFeeLamports) reasons.push("FEE_BUDGET_EXCEEDED");
    if (state.cashLamports - reserved - p.amountLamports - p.feeLamports < l.minReserveLamports)
      reasons.push("MIN_SOL_RESERVE");
    if (
      (state.exposureLamports + exposureReserved + p.amountLamports) * 10_000n >
      state.equityLamports * BigInt(l.maxExposureBps)
    )
      reasons.push("MAX_PORTFOLIO_EXPOSURE");
    if (p.liquidityLamports == null || p.liquidityLamports < l.minLiquidityLamports)
      reasons.push("LIQUIDITY_UNKNOWN_OR_LOW");
    if (
      p.impactBps == null ||
      !Number.isFinite(p.impactBps) ||
      p.impactBps < 0 ||
      p.impactBps > l.maxImpactBps
    )
      reasons.push("PRICE_IMPACT_UNKNOWN_OR_HIGH");
    if (!Number.isInteger(p.slippageBps) || p.slippageBps < 0 || p.slippageBps > l.maxSlippageBps)
      reasons.push("SLIPPAGE_LIMIT");
    if (
      !Number.isFinite(p.quoteObservedAt) ||
      p.quoteObservedAt > now ||
      now - p.quoteObservedAt > l.maxQuoteAgeMs
    )
      reasons.push("QUOTE_STALE_OR_FUTURE");
    const expiresAt = Math.min(
      now + l.authorizationTtlMs,
      evidenceExpiresAt,
      p.quoteObservedAt + l.maxQuoteAgeMs,
    );
    const amount = p.amountLamports + p.feeLamports;
    if (!reasons.length)
      this.reservations.set(p.orderId, {
        mint: p.mint,
        amount,
        exposure: p.amountLamports,
        expiresAt,
      });
    return {
      orderId: p.orderId,
      mint: p.mint,
      allowed: reasons.length === 0,
      reasons: reasons.length ? reasons : ["RISK_APPROVED_RESERVED"],
      expiresAt,
      reservedLamports: reasons.length ? 0n : amount,
    };
  }

  /** Call only after a confirmed/paper fill has atomically updated the portfolio. */
  complete(orderId: string, now = Date.now()): void {
    const r = this.reservations.get(orderId);
    if (!r || r.expiresAt < now || this.killed)
      throw new Error("Missing, expired or killed risk authorization");
    this.reservations.delete(orderId);
    this.completed.add(orderId);
  }
  release(orderId: string): void {
    this.reservations.delete(orderId);
  }
  pendingCount(now = Date.now()): number {
    this.prune(now);
    return this.reservations.size;
  }
}
