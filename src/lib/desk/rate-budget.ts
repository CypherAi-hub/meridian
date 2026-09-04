export type RateBudgetSnapshot = {
  name: string;
  rate: number;
  tokens: number;
  minRate: number;
  maxRate: number;
  limitedUntil: number;
  last429At: number | null;
  lastOkAt: number | null;
  limitedCount: number;
  taken: number;
  skipped: number;
  consecutiveOk: number;
  storming: boolean;
  stormCount: number;
};

export function parseRetryAfter(header: string | null | undefined, now = Date.now()): number {
  if (!header || !header.trim()) return 0;
  const raw = header.trim();
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60_000, seconds * 1000);
  const when = Date.parse(raw);
  if (Number.isFinite(when)) return Math.max(0, Math.min(60_000, when - now));
  return 0;
}

const STORM_WINDOW_MS = 30_000;
const STORM_HITS = 3;

/**
 * Per-family AIMD token bucket.
 * 429 → multiplicative decrease + Retry-After cooldown.
 * Healthy streak → small additive increase, never a jump back to the ceiling.
 * A skipped take is NOT a quote result — callers must record UNKNOWN / not-checked.
 */
export class AdaptiveRateBudget {
  rate: number;
  tokens: number;
  lastRefill: number;
  readonly minRate: number;
  readonly maxRate: number;
  limitedUntil = 0;
  last429At: number | null = null;
  lastOkAt: number | null = null;
  limitedCount = 0;
  taken = 0;
  skipped = 0;
  consecutiveOk = 0;
  storming = false;
  stormCount = 0;
  recent429: number[] = [];
  readonly name: string;
  readonly healthyWindowMs: number;
  readonly healthyStreak: number;
  readonly additiveStep: number;

  constructor(rate: number, minRate: number, maxRate: number, now = Date.now(), name = "anon") {
    this.rate = rate;
    this.minRate = minRate;
    this.maxRate = maxRate;
    this.tokens = Math.max(1, rate);
    this.lastRefill = now;
    this.name = name;
    this.healthyWindowMs = 15_000;
    this.healthyStreak = 8;
    this.additiveStep = Math.max(0.02, (maxRate - minRate) * 0.05);
  }

  onRateLimit(retryAfterMs = 0, now = Date.now()) {
    this.rate = Math.max(this.minRate, this.rate * 0.5);
    this.tokens = Math.min(this.tokens, this.rate);
    this.consecutiveOk = 0;
    this.limitedCount += 1;
    this.last429At = now;
    this.recent429.push(now);
    this.recent429 = this.recent429.filter((t) => now - t <= STORM_WINDOW_MS);
    if (this.recent429.length >= STORM_HITS) {
      this.storming = true;
      this.stormCount += 1;
      this.rate = this.minRate;
    }
    const backoff = Math.max(retryAfterMs, Math.round(1000 / Math.max(this.rate, this.minRate)));
    this.limitedUntil = Math.max(this.limitedUntil, now + Math.min(60_000, backoff));
  }

  onHealthyWindow() {
    this.rate = Math.min(this.maxRate, this.rate + this.additiveStep);
    this.storming = false;
  }

  onSuccess(now = Date.now()) {
    this.lastOkAt = now;
    this.consecutiveOk += 1;
    this.recent429 = this.recent429.filter((t) => now - t <= STORM_WINDOW_MS);
    const cooled = this.last429At == null || now - this.last429At >= this.healthyWindowMs;
    if (cooled && this.consecutiveOk >= this.healthyStreak && now >= this.limitedUntil) {
      this.onHealthyWindow();
      this.consecutiveOk = 0;
    }
  }

  refill(now = Date.now()) {
    const dt = Math.max(0, (now - this.lastRefill) / 1000);
    const cap = Math.max(1, Math.max(this.rate, this.minRate) * 2);
    this.tokens = Math.min(cap, this.tokens + dt * this.rate);
    this.lastRefill = now;
  }

  limited(now = Date.now()): boolean {
    this.refill(now);
    return now < this.limitedUntil || this.tokens < 1;
  }

  take(n = 1, now = Date.now()): boolean {
    this.refill(now);
    if (now < this.limitedUntil || this.tokens < n) {
      this.skipped += 1;
      return false;
    }
    this.tokens -= n;
    this.taken += 1;
    return true;
  }

  snapshot(): RateBudgetSnapshot {
    return {
      name: this.name,
      rate: this.rate,
      tokens: this.tokens,
      minRate: this.minRate,
      maxRate: this.maxRate,
      limitedUntil: this.limitedUntil,
      last429At: this.last429At,
      lastOkAt: this.lastOkAt,
      limitedCount: this.limitedCount,
      taken: this.taken,
      skipped: this.skipped,
      consecutiveOk: this.consecutiveOk,
      storming: this.storming,
      stormCount: this.stormCount,
    };
  }

  applySnapshot(s: RateBudgetSnapshot, now = Date.now()) {
    this.rate = s.rate;
    this.tokens = s.tokens;
    this.limitedUntil = s.limitedUntil;
    this.last429At = s.last429At;
    this.lastOkAt = s.lastOkAt;
    this.limitedCount = s.limitedCount;
    this.taken = s.taken;
    this.skipped = s.skipped;
    this.consecutiveOk = s.consecutiveOk;
    this.storming = s.storming;
    this.stormCount = s.stormCount;
    this.lastRefill = now;
    this.recent429 = s.last429At != null ? [s.last429At] : [];
  }
}

export const FAMILY_DEFAULTS: Record<string, { rate: number; min: number; max: number }> = {
  jupiter: { rate: 0.3, min: 0.05, max: 0.8 },
  geckoterminal: { rate: 0.25, min: 0.05, max: 0.8 },
  rugcheck: { rate: 0.45, min: 0.08, max: 1.5 },
  dexscreener: { rate: 0.8, min: 0.15, max: 2.5 },
  birdeye: { rate: 1, min: 0.1, max: 4 },
  helius: { rate: 0.8, min: 0.1, max: 3 },
};

export const JUPITER_KEYED_BUDGET = { rate: 1.5, min: 0.2, max: 4 };

const g = globalThis as typeof globalThis & {
  __meridianRateBudgets__?: Map<string, AdaptiveRateBudget>;
};

function budgetMap(): Map<string, AdaptiveRateBudget> {
  g.__meridianRateBudgets__ ??= new Map();
  return g.__meridianRateBudgets__;
}

export function budgetFor(name: string, defaults?: { rate: number; min: number; max: number }): AdaptiveRateBudget {
  const budgets = budgetMap();
  let b = budgets.get(name);
  if (!b) {
    const d = defaults ?? FAMILY_DEFAULTS[name] ?? { rate: 0.4, min: 0.05, max: 2 };
    b = new AdaptiveRateBudget(d.rate, d.min, d.max, Date.now(), name);
    budgets.set(name, b);
  }
  return b;
}

export function snapshotBudgets(): RateBudgetSnapshot[] {
  return [...budgetMap().values()].map((b) => b.snapshot());
}

export function replaceBudget(b: AdaptiveRateBudget) {
  budgetMap().set(b.name, b);
}

export function resetBudgets() {
  budgetMap().clear();
}

export function anyBudgetStorming(): boolean {
  return [...budgetMap().values()].some((b) => b.storming);
}
