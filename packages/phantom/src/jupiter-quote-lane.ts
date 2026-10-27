export type QuotePriority = "protective_exit" | "entry" | "research" | "analysis";
const rank: Record<QuotePriority, number> = {
  protective_exit: 3,
  entry: 2,
  research: 1,
  analysis: 0,
};
const MAX_TIMER_MS = 2_147_483_647;
type Job = {
  priority: number;
  deadline: number;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
  run: (signal: AbortSignal) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

/** One local, serialized quote lane. It cannot coordinate another client/process or
 * the organisation-wide Jupiter bucket. Share an instance explicitly when needed.
 * No retries, quote reuse, or rate-limit claims about other API consumers.
 */
export class JupiterQuoteLane {
  private pending: Job[] = [];
  private active: Job | null = null;
  private wake: ReturnType<typeof setTimeout> | null = null;
  private lastStartedAt = -Infinity;
  private blockedUntil = -Infinity;
  private readonly intervalMs: number;
  private readonly maxPending: number;
  private readonly now: () => number;
  constructor(
    options: { minimumIntervalMs?: number; maxPending?: number; now?: () => number } = {},
  ) {
    this.intervalMs = options.minimumIntervalMs ?? 1000;
    this.maxPending = options.maxPending ?? 8;
    this.now = options.now ?? Date.now;
    if (
      !Number.isSafeInteger(this.intervalMs) ||
      this.intervalMs < 1000 ||
      this.intervalMs > MAX_TIMER_MS ||
      !Number.isSafeInteger(this.maxPending) ||
      this.maxPending < 1 ||
      this.maxPending > 1000
    )
      throw Error("INVALID_JUPITER_QUOTE_LANE_OPTIONS");
  }

  schedule<T>(
    priority: QuotePriority,
    timeoutMs: number,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (!Object.hasOwn(rank, priority))
      return Promise.reject(Error("JUPITER_INVALID_QUOTE_PRIORITY"));
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMER_MS)
      return Promise.reject(Error("INVALID_TIMEOUT"));
    this.expirePending();
    if (this.pending.length >= this.maxPending) {
      // The last item is the newest member of the lowest-priority tier. Preserve
      // FIFO peers and never evict the active request or an equal-priority caller.
      const worst = this.pending.at(-1)!;
      if (rank[priority] <= worst.priority)
        return Promise.reject(Error("JUPITER_QUOTE_QUEUE_FULL"));
      this.pending.pop();
      this.reject(worst, "JUPITER_QUOTE_QUEUE_EVICTED_FOR_HIGHER_PRIORITY");
    }
    return new Promise<T>((resolve, reject) => {
      const job: Job = {
        priority: rank[priority],
        deadline: this.now() + timeoutMs,
        controller: new AbortController(),
        timer: undefined!,
        settled: false,
        run,
        resolve: (value) => resolve(value as T),
        reject,
      };
      job.timer = setTimeout(() => {
        if (job === this.active) {
          job.controller.abort();
          this.reject(job, "JUPITER_QUOTE_TIMEOUT");
          // Keep the lane occupied until the actual task settles. A provider that
          // ignores abort cannot cause overlapping requests or a late success.
        } else {
          const index = this.pending.indexOf(job);
          if (index >= 0) this.pending.splice(index, 1);
          this.reject(job, "JUPITER_QUOTE_QUEUE_TIMEOUT");
          this.pump();
        }
      }, timeoutMs);
      const before = this.pending.findIndex((item) => item.priority < job.priority);
      this.pending.splice(before < 0 ? this.pending.length : before, 0, job);
      this.pump();
    });
  }

  /** Reset is absolute Unix seconds; remaining is signed. Missing remaining is
   * unknown, never zero. Docs: https://developers.jup.ag/docs/portal/rate-limits
   */
  observeResponse(status: number, headers: Pick<Headers, "get">) {
    const remainingText = headers.get("x-ratelimit-remaining")?.trim();
    const remaining =
      remainingText && /^[+-]?\d{1,20}$/.test(remainingText) ? BigInt(remainingText) : null;
    if (status !== 429 && !(status === 200 && remaining !== null && remaining <= 0n)) return;
    const now = this.now(),
      resetText = headers.get("x-ratelimit-reset")?.trim();
    const reset =
      resetText && /^\d+(?:\.\d+)?$/.test(resetText) ? Math.ceil(Number(resetText) * 1000) : NaN;
    const until = Number.isSafeInteger(reset) && reset >= 0 ? Math.max(now, reset) : now + 1000;
    this.blockedUntil = Math.max(this.blockedUntil, until);
    this.pump();
  }

  private reject(job: Job, code: string) {
    if (job.settled) return;
    job.settled = true;
    clearTimeout(job.timer);
    job.reject(Error(code));
  }
  private expirePending() {
    const now = this.now();
    this.pending = this.pending.filter((job) => {
      if (job.deadline > now) return true;
      this.reject(job, "JUPITER_QUOTE_QUEUE_TIMEOUT");
      return false;
    });
  }
  private pump() {
    if (this.wake) {
      clearTimeout(this.wake);
      this.wake = null;
    }
    if (this.active) return;
    this.expirePending();
    if (!this.pending.length) return;
    const now = this.now(),
      readyAt = Math.max(this.lastStartedAt + this.intervalMs, this.blockedUntil);
    if (readyAt > now) {
      const nearestDeadline = Math.min(...this.pending.map((job) => job.deadline));
      this.wake = setTimeout(
        () => {
          this.wake = null;
          this.pump();
        },
        Math.min(readyAt - now, nearestDeadline - now, MAX_TIMER_MS),
      );
      return;
    }
    const job = this.pending.shift()!;
    this.active = job;
    this.lastStartedAt = now;
    let task: Promise<unknown>;
    try {
      task = job.run(job.controller.signal);
    } catch (error) {
      task = Promise.reject(error);
    }
    void Promise.resolve(task)
      .then(
        (value) => {
          if (!job.settled && this.now() >= job.deadline) {
            job.controller.abort();
            this.reject(job, "JUPITER_QUOTE_TIMEOUT");
          }
          if (!job.settled) {
            job.settled = true;
            clearTimeout(job.timer);
            job.resolve(value);
          }
        },
        (error) => {
          if (!job.settled && this.now() >= job.deadline) {
            job.controller.abort();
            this.reject(job, "JUPITER_QUOTE_TIMEOUT");
          }
          if (!job.settled) {
            job.settled = true;
            clearTimeout(job.timer);
            job.reject(error);
          }
        },
      )
      .finally(() => {
        this.active = null;
        this.pump();
      });
  }
}
