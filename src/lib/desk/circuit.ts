export type CircuitState = "HEALTHY" | "DEGRADED" | "OPEN_CIRCUIT" | "OFFLINE";
export type CircuitPhase = "CLOSED" | "OPEN" | "HALF_OPEN";

export class CircuitBreaker {
  failureThreshold: number;
  resetMs: number;
  failures = 0;
  openedAt: number | null = null;
  lastError: string | null = null;
  halfOpenProbes = 0;
  maxHalfOpenProbes = 1;

  constructor(failureThreshold = 5, resetMs = 60_000) {
    this.failureThreshold = failureThreshold;
    this.resetMs = resetMs;
  }

  phase(now = Date.now()): CircuitPhase {
    if (this.openedAt == null) return "CLOSED";
    if (now - this.openedAt < this.resetMs) return "OPEN";
    return "HALF_OPEN";
  }

  canCall(now = Date.now()): boolean {
    if (this.openedAt == null) return true;
    if (now - this.openedAt < this.resetMs) return false;
    if (this.halfOpenProbes < this.maxHalfOpenProbes) {
      this.halfOpenProbes += 1;
      return true;
    }
    return false;
  }

  canRequest(now = Date.now()): boolean {
    return this.canCall(now);
  }

  success() {
    this.failures = 0;
    this.openedAt = null;
    this.lastError = null;
    this.halfOpenProbes = 0;
  }

  failure(message?: string, now = Date.now()) {
    this.failures += 1;
    this.lastError = message ?? this.lastError;
    if (this.openedAt != null) {
      this.openedAt = now;
      this.halfOpenProbes = 0;
      return;
    }
    if (this.failures >= this.failureThreshold) {
      this.openedAt = now;
      this.halfOpenProbes = 0;
    }
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
