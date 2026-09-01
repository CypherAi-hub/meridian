import { createHash } from "node:crypto";

export function requestFingerprint(
  provider: string,
  endpoint: string,
  params: Record<string, unknown>,
  timeBucket: number,
): string {
  const payload = {
    provider,
    endpoint,
    params,
    bucket: timeBucket,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
