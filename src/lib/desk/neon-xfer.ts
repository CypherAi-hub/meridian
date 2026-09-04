/** Approximate Neon egress accounting. Never logs secrets or row payloads. */

export type NeonXferSample = {
  at: number;
  researchRows: number;
  researchBytesEst: number;
  pendingRows: number;
  pendingBytesEst: number;
  ledgerRows: number;
  ledgerBytesEst: number;
  deskBytesEst: number;
  tickBytesEst: number;
  path: "universe" | "active";
};

const AVG_SNAPSHOT = 2845;
const AVG_LABEL_JSONB = 2675;
const ROW = AVG_SNAPSHOT + AVG_LABEL_JSONB;

let last: NeonXferSample | null = null;

export function estimatePairBytes(n: number): number {
  return Math.max(0, n) * ROW;
}

export function noteUniverseXfer(input: {
  researchRows: number;
  pendingRows: number;
  ledgerRows: number;
  deskBytesEst?: number;
}): NeonXferSample {
  const researchBytesEst = estimatePairBytes(input.researchRows);
  const pendingBytesEst = estimatePairBytes(input.pendingRows);
  const ledgerBytesEst = estimatePairBytes(input.ledgerRows);
  const deskBytesEst = input.deskBytesEst ?? 130_000;
  const sample: NeonXferSample = {
    at: Date.now(),
    researchRows: input.researchRows,
    researchBytesEst,
    pendingRows: input.pendingRows,
    pendingBytesEst,
    ledgerRows: input.ledgerRows,
    ledgerBytesEst,
    deskBytesEst,
    tickBytesEst: researchBytesEst + pendingBytesEst + ledgerBytesEst + deskBytesEst,
    path: "universe",
  };
  last = sample;
  console.info(
    `[meridian] neon_xfer path=universe rows=${input.researchRows} pending=${input.pendingRows} bytes~=${sample.tickBytesEst}`,
  );
  return sample;
}

export function lastNeonXfer(): NeonXferSample | null {
  return last;
}

export function projectTransfer(tickBytes: number, universeMs = 12_000) {
  const ticksPerHour = 3_600_000 / universeMs;
  const hourly = tickBytes * ticksPerHour;
  const daily = hourly * 24;
  const monthly = daily * 30;
  return { hourly, daily, monthly };
}
