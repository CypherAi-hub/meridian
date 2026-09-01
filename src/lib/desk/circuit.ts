export type CircuitState = "HEALTHY" | "DEGRADED" | "OPEN_CIRCUIT" | "OFFLINE";

export class CircuitBreaker {
  failureThreshold: number;
  resetMs: number;
  failures = 0;
  openedAt: number | null = null;
  lastError: string | null = null;

  constructor(failureThreshold = 5, resetMs = 60_000) {
    this.failureThreshold = failureThreshold;
    this.resetMs = resetMs;
  }

  canCall(now = Date.now()): boolean {
    if (this.openedAt == null) return true;
    if (now - this.openedAt >= this.resetMs) {
      this.failures = 0;
      this.openedAt = null;
      return true;
    }
    return false;
  }

  success() {
    this.failures = 0;
    this.openedAt = null;
    this.lastError = null;
  }

  failure(message?: string, now = Date.now()) {
    this.failures += 1;
    this.lastError = message ?? this.lastError;
    if (this.failures >= this.failureThreshold) this.openedAt = now;
  }

  state(): CircuitState {
    if (this.openedAt != null) return "OPEN_CIRCUIT";
    if (this.failures >= 2) return "DEGRADED";
    if (this.lastError && this.failures > 0) return "DEGRADED";
    return "HEALTHY";
  }
}

const breakers = new Map<string, CircuitBreaker>();

export function breakerFor(name: string): CircuitBreaker {
  let b = breakers.get(name);
  if (!b) {
    b = new CircuitBreaker();
    breakers.set(name, b);
  }
  return b;
}

export function resetBreakers() {
  breakers.clear();
}
