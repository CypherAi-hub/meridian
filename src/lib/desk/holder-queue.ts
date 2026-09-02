import { bucketOf, type UniverseBucket } from "./buckets.ts";

export type HolderReason = "OPEN_POSITION" | "CANDIDATE" | "NEW_LAUNCH" | "EARLY" | "EMERGING" | "REFRESH";

export type HolderLookupJob = {
  mint: string;
  bucket: UniverseBucket;
  priority: number;
  requestedAt: number;
  reason: HolderReason;
};

export function holderPriority(reason: HolderReason): number {
  switch (reason) {
    case "OPEN_POSITION":
      return 0;
    case "CANDIDATE":
      return 1;
    case "NEW_LAUNCH":
      return 2;
    case "EARLY":
      return 3;
    case "EMERGING":
      return 4;
    default:
      return 5;
  }
}

export function holderReasonFor(opts: {
  held?: boolean;
  candidate?: boolean;
  ageS?: number | null;
}): HolderReason {
  if (opts.held) return "OPEN_POSITION";
  if (opts.candidate) return "CANDIDATE";
  const b = bucketOf(opts.ageS ?? null);
  if (b === "new_launch") return "NEW_LAUNCH";
  if (b === "early") return "EARLY";
  if (b === "emerging") return "EMERGING";
  return "REFRESH";
}

export function makeHolderJob(
  mint: string,
  opts: { held?: boolean; candidate?: boolean; ageS?: number | null; now?: number },
): HolderLookupJob {
  const reason = holderReasonFor(opts);
  const bucket = bucketOf(opts.ageS ?? null);
  return {
    mint,
    bucket,
    priority: holderPriority(reason),
    requestedAt: opts.now ?? Date.now(),
    reason,
  };
}

export function rankHolderJobs(jobs: HolderLookupJob[]): HolderLookupJob[] {
  return [...jobs].sort((a, b) => a.priority - b.priority || a.requestedAt - b.requestedAt);
}

export function takeHolderJobs(jobs: HolderLookupJob[], limit: number): HolderLookupJob[] {
  return rankHolderJobs(jobs).slice(0, Math.max(0, limit));
}
