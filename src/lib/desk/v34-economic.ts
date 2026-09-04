import { EXECUTION_ASSUMPTION } from "./versions.ts";

export type EconomicRow = {
  p: number;
  y: 0 | 1;
  tokenAddress: string;
  notional: number;
  impactBps: number;
  routeLost?: boolean;
  failedExit?: boolean;
};

export type CostAssumptions = {
  slippageBps: number;
  feeBps: number;
  extraAdverseBps: number;
  latencyPenaltyBps: number;
  routeLossBps: number;
  failedExitBps: number;
  liquidityHaircut: number;
};

export const BASE_COSTS: CostAssumptions = {
  slippageBps: EXECUTION_ASSUMPTION.slippage_bps,
  feeBps: EXECUTION_ASSUMPTION.fee_bps,
  extraAdverseBps: EXECUTION_ASSUMPTION.extra_adverse_bps,
  latencyPenaltyBps: 5,
  routeLossBps: 150,
  failedExitBps: 200,
  liquidityHaircut: 0,
};

export type EconomicReport = {
  n: number;
  taken: number;
  gross: number;
  costs: number;
  net: number;
  expectancy: number;
  sizedCapital: false;
};

function bps(n: number, bps: number) {
  return n * (bps / 10_000);
}

/** Hypothetical expectancy after friction. Does not size live capital. */
export function economicEvaluate(
  rows: EconomicRow[],
  costs: CostAssumptions,
  opts?: { threshold?: number },
): EconomicReport {
  const threshold = opts?.threshold ?? 0.55;
  let gross = 0;
  let cost = 0;
  let taken = 0;
  for (const r of rows) {
    if (r.p < threshold) continue;
    taken += 1;
    const notional = r.notional * (1 - costs.liquidityHaircut);
    const win = r.y === 1 ? 0.1 : -0.1;
    gross += notional * win;
    let c =
      bps(notional, costs.slippageBps) +
      bps(notional, costs.feeBps) +
      bps(notional, costs.extraAdverseBps) +
      bps(notional, costs.latencyPenaltyBps) +
      bps(notional, r.impactBps);
    if (r.routeLost) c += bps(notional, costs.routeLossBps);
    if (r.failedExit) c += bps(notional, costs.failedExitBps);
    cost += c;
  }
  const net = gross - cost;
  return { n: rows.length, taken, gross, costs: cost, net, expectancy: taken ? net / taken : 0, sizedCapital: false };
}

export type StressName =
  | "base"
  | "latency_x2"
  | "latency_x5"
  | "slippage_x2"
  | "liq_m25"
  | "liq_m50"
  | "route_stress"
  | "adverse_gap";

export function stressAssumptions(): Record<StressName, CostAssumptions> {
  return {
    base: { ...BASE_COSTS },
    latency_x2: { ...BASE_COSTS, latencyPenaltyBps: BASE_COSTS.latencyPenaltyBps * 2 },
    latency_x5: { ...BASE_COSTS, latencyPenaltyBps: BASE_COSTS.latencyPenaltyBps * 5 },
    slippage_x2: { ...BASE_COSTS, slippageBps: BASE_COSTS.slippageBps * 2 },
    liq_m25: { ...BASE_COSTS, liquidityHaircut: 0.25 },
    liq_m50: { ...BASE_COSTS, liquidityHaircut: 0.5 },
    route_stress: { ...BASE_COSTS, routeLossBps: BASE_COSTS.routeLossBps * 2 },
    adverse_gap: { ...BASE_COSTS, extraAdverseBps: 40 },
  };
}

export function stressMatrix(rows: EconomicRow[]): Record<StressName, EconomicReport> {
  const out = {} as Record<StressName, EconomicReport>;
  const stressed = (name: StressName, rowsX: EconomicRow[], costs: CostAssumptions) => {
    out[name] = economicEvaluate(rowsX, costs);
  };
  const all = stressAssumptions();
  for (const name of Object.keys(all) as StressName[]) {
    if (name === "route_stress") {
      stressed(name, rows.map((r) => ({ ...r, routeLost: true })), all[name]);
    } else {
      stressed(name, rows, all[name]);
    }
  }
  return out;
}

export type CapacityPoint = { notional: number; expectancy: number; net: number };

/** Impact grows with size. A $20-only edge is not scalable alpha. */
export function capacityCurve(rows: EconomicRow[], notionals: number[]): CapacityPoint[] {
  return notionals.map((notional) => {
    const scaled = rows.map((r) => ({
      ...r,
      notional,
      impactBps: r.impactBps * (notional / Math.max(r.notional, 1)),
    }));
    const ev = economicEvaluate(scaled, BASE_COSTS);
    return { notional, expectancy: ev.expectancy, net: ev.net };
  });
}
