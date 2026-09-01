import { bucketOf } from "./buckets";
import { MAX_STRESSED_EXIT_PCT, MIN_LIQ_USD, STALE_MS } from "./schema";
import type { Features, GovernorVerdict, Predictions, QuoteObs, Regime, TokenLive } from "./types";
import type { GateResult } from "./schema";

function asFrac(n: number | null | undefined) {
  if (n == null) return null;
  return n > 1 ? n / 100 : n;
}

function impactFromQuote(q: QuoteObs | null | undefined, notional: number, liq: number) {
  const quoted = asFrac(q?.priceImpactPct ?? null);
  if (quoted != null && q?.notionalUsd) {
    return Math.min(0.95, quoted * (notional / Math.max(q.notionalUsd, 1)));
  }
  if (quoted != null) return quoted;
  if (liq <= 0) return 1;
  return Math.min(0.95, notional / liq);
}

export function govern(opts: {
  t: TokenLive;
  f: Features;
  pred: Predictions;
  equity: number;
  riskBps: number;
  openCount: number;
  maxPositions: number;
  regime: Regime;
  strategyId: string;
  now: number;
  dayDd: number;
}): GovernorVerdict {
  const { t, f, pred, equity, riskBps, openCount, maxPositions, regime, strategyId, now, dayDd } = opts;
  const bucket = f.bucket ?? bucketOf(f.tokenAgeS);
  const liqKnown = t.liquidityUsd.value != null;
  const liq = t.liquidityUsd.value ?? 0;
  const layers: GateResult[] = [];
  let sizeMul = 1;

  const d = pred.maeQ90 + pred.expectedExecCostBps / 10_000 + 0.015;
  const R = equity * (riskBps / 10_000);
  const nRisk = R / Math.max(d, 0.02);
  const nLiq = 0.006 * Math.max(liq, 0);
  const nCap = 0.018 * equity;
  let sized = Math.max(0, Math.min(nRisk, nLiq, nCap));

  if (t.mintAuth.value == null || t.freezeAuth.value == null) {
    layers.push({
      name: "Contract risk",
      status: "UNKNOWN",
      reason: "Mint/freeze authority unknown — veto until verified",
    });
  } else if (t.mintAuth.value || t.freezeAuth.value) {
    layers.push({
      name: "Contract risk",
      status: "FAIL",
      reason: t.mintAuth.value ? "Mint authority active" : "Freeze authority active",
    });
  } else {
    layers.push({ name: "Contract risk", status: "PASS", reason: "Mint and freeze revoked" });
  }

  if (t.top10Pct.value == null) {
    const young = bucket === "new_launch" || bucket === "early" || bucket === "unknown";
    if (young) {
      layers.push({
        name: "Holder concentration",
        status: "UNKNOWN",
        reason: "Concentration unverified — veto on new/early names",
      });
    } else {
      sizeMul = Math.min(sizeMul, 0.2);
      layers.push({
        name: "Holder concentration",
        status: "UNKNOWN",
        reason: "Concentration unverified — size cut to 20%",
      });
    }
  } else if (t.top10Pct.value >= 0.42) {
    layers.push({
      name: "Holder concentration",
      status: "FAIL",
      reason: `Top 10 holds ${(t.top10Pct.value * 100).toFixed(0)}%`,
    });
  } else {
    layers.push({
      name: "Holder concentration",
      status: "PASS",
      reason: `Top 10 ${(t.top10Pct.value * 100).toFixed(0)}%`,
    });
  }

  if (!liqKnown) {
    layers.push({ name: "Liquidity", status: "UNKNOWN", reason: "Liquidity missing — cannot size an exit" });
  } else if (liq < MIN_LIQ_USD) {
    layers.push({
      name: "Liquidity",
      status: "FAIL",
      reason: `Liq $${Math.round(liq).toLocaleString()} below $35k`,
    });
  } else {
    layers.push({
      name: "Liquidity",
      status: "PASS",
      reason: `Liq $${Math.round(liq).toLocaleString()}`,
    });
  }

  if (!t.sellQuote) {
    layers.push({
      name: "Exit route",
      status: "UNKNOWN",
      reason: "No Jupiter quote yet — cannot verify exit",
    });
  } else if (!t.sellQuote.available) {
    layers.push({
      name: "Exit route",
      status: "FAIL",
      reason: t.sellQuote.error ?? "Sell quote unavailable",
    });
  } else {
    layers.push({
      name: "Exit route",
      status: "PASS",
      reason: t.sellQuote.routeLabels[0] ?? "Jupiter route",
    });
  }

  const age = now - t.priceUsd.ingestedAt;
  if (!t.priceUsd.value) {
    layers.push({ name: "Data freshness", status: "UNKNOWN", reason: "No price on snapshot" });
  } else if (age > STALE_MS) {
    layers.push({
      name: "Data freshness",
      status: "FAIL",
      reason: `Snapshot age ${(age / 1000).toFixed(0)}s`,
    });
  } else if (f.priceDisagreement != null && f.priceDisagreement > 0.18) {
    layers.push({
      name: "Data freshness",
      status: "FAIL",
      reason: `Sources disagree ${(f.priceDisagreement * 100).toFixed(0)}%`,
    });
  } else {
    layers.push({ name: "Data freshness", status: "PASS", reason: `Age ${(age / 1000).toFixed(1)}s` });
  }

  sized *= sizeMul;
  const entryImp = impactFromQuote(t.buyQuote, sized, liq);
  const exitImp = impactFromQuote(t.sellQuote, sized, liq);
  const stressedExit = Math.min(0.99, exitImp * 2.4 + 0.01);

  layers.push(
    stressedExit > MAX_STRESSED_EXIT_PCT
      ? {
          name: "Price impact",
          status: "FAIL",
          reason: `Estimated stressed exit impact = ${(stressedExit * 100).toFixed(1)}%. Maximum permitted = ${(MAX_STRESSED_EXIT_PCT * 100).toFixed(1)}%`,
        }
      : { name: "Price impact", status: "PASS", reason: `Stressed exit ${(stressedExit * 100).toFixed(1)}%` },
  );

  layers.push(
    openCount >= maxPositions
      ? { name: "Portfolio exposure", status: "FAIL", reason: "Position cap" }
      : { name: "Portfolio exposure", status: "PASS", reason: `${openCount}/${maxPositions} names` },
  );

  layers.push(
    dayDd > 0.12
      ? { name: "Daily drawdown", status: "FAIL", reason: `Intraday ${(dayDd * 100).toFixed(1)}%` }
      : { name: "Daily drawdown", status: "PASS", reason: `Intraday ${(dayDd * 100).toFixed(1)}%` },
  );

  layers.push(
    regime === "risk_off" || strategyId === "flat"
      ? { name: "Regime risk", status: "FAIL", reason: "Stand-down regime" }
      : { name: "Regime risk", status: "PASS", reason: `${regime.replaceAll("_", " ")} · ${bucket.replaceAll("_", " ")}` },
  );

  const quoteLag = t.sellQuote?.latencyMs ?? t.buyQuote?.latencyMs ?? 0;
  if (!t.buyQuote || !t.sellQuote) {
    layers.push({ name: "Execution conditions", status: "UNKNOWN", reason: "Quote incomplete" });
  } else if (quoteLag > 2500) {
    layers.push({
      name: "Execution conditions",
      status: "FAIL",
      reason: `Quote latency ${quoteLag}ms`,
    });
  } else {
    layers.push({ name: "Execution conditions", status: "PASS", reason: `Quote ${quoteLag}ms` });
  }

  if (liqKnown && sized < 40) {
    layers.push({ name: "Liquidity", status: "FAIL", reason: "Sized below $40 minimum" });
  }

  const fails = layers.filter((l) => l.status === "FAIL");
  const unknown = layers.filter((l) => l.status === "UNKNOWN");
  const holderUnknown = unknown.find((l) => l.name === "Holder concentration");
  const young = bucket === "new_launch" || bucket === "early" || bucket === "unknown";
  const blockingUnknown = unknown.filter((l) => l.name !== "Holder concentration" || young);
  const approved = fails.length === 0 && blockingUnknown.length === 0;

  const reasons = [
    ...fails.map((l) => l.reason),
    ...blockingUnknown.map((l) => l.reason),
  ];
  if (!approved && !reasons.length && holderUnknown) reasons.push(holderUnknown.reason);

  return {
    approved,
    reasons,
    sizedUsd: sized,
    stressedLoss: sized * Math.max(d, stressedExit),
    stressedExitPct: stressedExit,
    entryImpactPct: t.buyQuote?.available ? entryImp : null,
    exitImpactPct: t.sellQuote?.available ? exitImp : null,
    unknownCount: unknown.length,
    layers,
  };
}

export function paperFillPrice(price: number, impactPct: number | null, slipBps: number, side: "buy" | "sell") {
  const impact = impactPct ?? 0.004;
  const slip = slipBps / 10_000;
  const fee = 0.0025;
  const load = impact + slip + fee;
  return side === "buy" ? price * (1 + load) : price * (1 - load);
}

export function paperFillFromQuote(
  mid: number,
  quote: QuoteObs | null | undefined,
  slipBps: number,
  side: "buy" | "sell",
  fallbackImpact: number | null,
) {
  const quoted = quote?.impliedPriceUsd && quote.available ? quote.impliedPriceUsd : null;
  const rel = quoted != null && mid > 0 ? Math.abs(quoted - mid) / mid : Number.POSITIVE_INFINITY;
  const base = quoted != null && rel < 0.35 ? quoted : mid;
  const slip = slipBps / 10_000;
  const fee = 0.0025;
  const impact = quoted != null && rel < 0.35 ? 0 : (fallbackImpact ?? 0.004);
  const load = impact + slip + fee;
  return side === "buy" ? base * (1 + load) : base * (1 - load);
}
