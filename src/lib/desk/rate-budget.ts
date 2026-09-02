export class AdaptiveRateBudget {
  rate: number;
  tokens: number;
  lastRefill: number;
  readonly minRate: number;
  readonly maxRate: number;

  constructor(rate: number, minRate: number, maxRate: number, now = Date.now()) {
    this.rate = rate;
    this.minRate = minRate;
    this.maxRate = maxRate;
    this.tokens = rate;
    this.lastRefill = now;
  }

  onRateLimit() {
    this.rate = Math.max(this.minRate, this.rate * 0.5);
    this.tokens = Math.min(this.tokens, this.rate);
  }

  onHealthyWindow() {
    this.rate = Math.min(this.maxRate, this.rate * 1.1);
  }

  refill(now = Date.now()) {
    const dt = Math.max(0, (now - this.lastRefill) / 1000);
    this.tokens = Math.min(this.maxRate, this.tokens + dt * this.rate);
    this.lastRefill = now;
  }

  take(n = 1, now = Date.now()): boolean {
    this.refill(now);
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

const budgets = new Map<string, AdaptiveRateBudget>();

export function budgetFor(name: string, defaults?: { rate: number; min: number; max: number }): AdaptiveRateBudget {
  let b = budgets.get(name);
  if (!b) {
    const d = defaults ?? { rate: 0.4, min: 0.05, max: 2 };
    b = new AdaptiveRateBudget(d.rate, d.min, d.max);
    budgets.set(name, b);
  }
  return b;
}

export function resetBudgets() {
  budgets.clear();
}
