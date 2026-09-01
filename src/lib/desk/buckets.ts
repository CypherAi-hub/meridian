export type UniverseBucket =
  | "new_launch"
  | "early"
  | "emerging"
  | "established"
  | "mature"
  | "unknown";

export const RESEARCH_BUCKETS: UniverseBucket[] = ["new_launch", "early", "emerging"];

export const BUCKET_BOUNDS: { id: UniverseBucket; label: string; minS: number; maxS: number }[] = [
  { id: "new_launch", label: "New launch", minS: 0, maxS: 30 * 60 },
  { id: "early", label: "Early", minS: 30 * 60, maxS: 6 * 3600 },
  { id: "emerging", label: "Emerging", minS: 6 * 3600, maxS: 72 * 3600 },
  { id: "established", label: "Established", minS: 3 * 86400, maxS: 30 * 86400 },
  { id: "mature", label: "Mature", minS: 30 * 86400, maxS: Number.POSITIVE_INFINITY },
];

export function bucketOf(ageS: number | null | undefined): UniverseBucket {
  if (ageS == null || !Number.isFinite(ageS) || ageS < 0) return "unknown";
  for (const b of BUCKET_BOUNDS) {
    if (ageS >= b.minS && ageS < b.maxS) return b.id;
  }
  return "mature";
}

export function isResearchBucket(b: UniverseBucket) {
  return RESEARCH_BUCKETS.includes(b);
}

export function bucketLabel(b: UniverseBucket) {
  switch (b) {
    case "new_launch":
      return "New launch";
    case "early":
      return "Early";
    case "emerging":
      return "Emerging";
    case "established":
      return "Established";
    case "mature":
      return "Mature";
    default:
      return "Unknown age";
  }
}

export function bucketRank(b: UniverseBucket) {
  switch (b) {
    case "new_launch":
      return 0;
    case "early":
      return 1;
    case "emerging":
      return 2;
    case "established":
      return 3;
    case "mature":
      return 4;
    default:
      return 5;
  }
}
