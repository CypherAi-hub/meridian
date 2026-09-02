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

export function observationFingerprint(input: {
  mint: string;
  eventTime: number;
  price: number | null;
  liquidity: number | null;
  provider: string;
}): string {
  const payload = {
    mint: input.mint,
    t: Math.floor(input.eventTime / 1000),
    p: input.price,
    l: input.liquidity,
    s: input.provider,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
