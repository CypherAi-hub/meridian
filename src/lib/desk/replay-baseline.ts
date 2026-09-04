import { createHash } from "node:crypto";
import { analyzeEdgeMonotonicity, buildBaselineReport } from "./baseline.ts";
import {
  matchBaselineSafeMomentum,
  matchEligibleUniverse,
  matchRandomEligible,
  matchSafetyOnly,
  publishedMeta,
  RANDOM_ELIGIBLE_SEED,
  V33B_HYPOTHESIS_COUNT,
} from "./baseline-strategy.ts";
import { tokenLeakage, walkForwardPurgeSplit } from "./dataset.ts";
import {
  FEATURE_ENGINE_VERSION,
  LABEL_DEFINITION_VERSION,
  EXECUTION_ASSUMPTION_VERSION,
} from "./versions.ts";
import { STRATEGY_VERSION } from "./schema.ts";
import {
  replayStrategy,
  type ReplayObservation,
  type ReplayRun,
} from "./replay.ts";
import { buildReplayTradeStats, type ReplayTradeStats } from "./replay-stats.ts";
import { STRATEGIES, type StrategyDef } from "./strategies.ts";
import type { Features, Predictions, Regime, TokenLive } from "./types.ts";

export function replayTapeFingerprint(obs: ReplayObservation[], from: number, to: number, stepMs: number): string {
  const payload = {
    fe: FEATURE_ENGINE_VERSION,
    ld: LABEL_DEFINITION_VERSION,
    ea: EXECUTION_ASSUMPTION_VERSION,
    sv: STRATEGY_VERSION,
    from,
    to,
    stepMs,
    obs: [...obs]
      .sort((a, b) => a.ingestedAt - b.ingestedAt || a.mint.localeCompare(b.mint))
      .map((o) => [o.mint, o.ingestedAt, o.eventTime, o.price, o.liquidity, o.top10Pct, o.sellRoute]),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function ret15(price: number | null, after: number | null): number | null {
  if (price == null || !price || after == null) return null;
  return after / price - 1;
}

function tokenGroupedMedian15(rows: Array<{ tokenAddress: string; price: number | null; price_after_15m: number | null }>) {
  const by = new Map<string, number[]>();
  for (const r of rows) {
    const y = ret15(r.price, r.price_after_15m);
    if (y == null) continue;
    const list = by.get(r.tokenAddress) ?? [];
    list.push(y);
    by.set(r.tokenAddress, list);
  }
  const perToken = [...by.values()].map((xs) => median(xs)).filter((n): n is number => n != null);
  return { uniqueTokens: by.size, median: median(perToken) };
}

/** Null baseline: first visible price vs ~15m later, grouped by mint. Labels may see later path. */
export function universeBuyAndHold15m(obs: ReplayObservation[]): {
  uniqueTokens: number;
  labeled: number;
  median15m: number | null;
} {
  const byMint = new Map<string, ReplayObservation[]>();
  for (const o of obs) {
    const list = byMint.get(o.mint) ?? [];
    list.push(o);
    byMint.set(o.mint, list);
  }
  const rets: number[] = [];
  for (const series of byMint.values()) {
    const sorted = [...series].sort((a, b) => a.eventTime - b.eventTime || a.ingestedAt - b.ingestedAt);
    const entry = sorted.find((o) => o.price != null && o.price > 0);
    if (!entry || entry.price == null) continue;
    const horizon = entry.eventTime + 15 * 60_000;
    let best: ReplayObservation | null = null;
    let bestDist = Infinity;
    for (const o of sorted) {
      if (o.price == null || o.eventTime < entry.eventTime) continue;
      const dist = Math.abs(o.eventTime - horizon);
      if (dist < bestDist) {
        best = o;
        bestDist = dist;
      }
    }
    if (!best || best.eventTime - entry.eventTime < 5 * 60_000 || best.price == null) continue;
    rets.push(best.price / entry.price - 1);
  }
  return { uniqueTokens: byMint.size, labeled: rets.length, median15m: median(rets) };
}

export type ReplayBaselineSlice = {
  id: string;
  version: number | string;
  liveWired: boolean;
  published: boolean;
  seed: number | null;
  hypothesisIndex: number | null;
  fingerprint: string;
  considerations: number;
  authorized: number;
  vetoed: number;
  labeled: number;
  uniqueTokensAuthorized: number;
  median15mAuthorizedConsideration: number | null;
  median15mAuthorizedToken: number | null;
  vsUniverseDelta: number | null;
  beatsUniverse: boolean | null;
  walkForward: {
    trainEnd: number;
    validationEnd: number;
    train: number;
    validation: number;
    test: number;
    tokenLeakageTrainTest: string[];
    note: string;
  };
  monotonicityVerdict: string;
  spearman15m: number | null;
  leakageViolations: number;
  stats: ReplayTradeStats;
  note: string;
};

export type ReplayBaselineReport = {
  generatedAt: number;
  tapeFingerprint: string;
  observations: number;
  uniqueTokens: number;
  from: number;
  to: number;
  stepMs: number;
  leakageViolations: number;
  readyForReplay: boolean;
  readyForModeling: boolean;
  hypothesisCount: number;
  publishedSeed: number;
  universe: {
    uniqueTokens: number;
    labeled: number;
    median15m: number | null;
    note: string;
  };
  note: string;
  strategies: ReplayBaselineSlice[];
};

function summarizeRun(opts: {
  id: string;
  version: number | string;
  liveWired: boolean;
  published: boolean;
  seed: number | null;
  hypothesisIndex: number | null;
  tapeFingerprint: string;
  run: ReplayRun;
  universeMedian: number | null;
}): ReplayBaselineSlice {
  const labeled = opts.run.labeled.filter((r) => r.labels_complete);
  const authorized = opts.run.labeled.filter((r) => r.governor_result === "authorized");
  const authorizedLabeled = authorized.filter((r) => r.labels_complete);
  const considerationRets = authorizedLabeled
    .map((r) => ret15(r.price, r.price_after_15m))
    .filter((n): n is number => n != null);
  const tokenMed = tokenGroupedMedian15(authorizedLabeled);
  const span = Math.max(1, opts.run.to - opts.run.from);
  const trainEnd = opts.run.from + Math.floor(span * 0.5);
  const validationEnd = opts.run.from + Math.floor(span * 0.75);
  const split = walkForwardPurgeSplit(authorizedLabeled, trainEnd, validationEnd, 60 * 60_000);
  const leaked = tokenLeakage(split.train, split.test);
  const mono = analyzeEdgeMonotonicity(opts.run.labeled);
  const baseline = buildBaselineReport(opts.run.labeled);
  const vsUniverseDelta =
    tokenMed.median != null && opts.universeMedian != null ? tokenMed.median - opts.universeMedian : null;
  const fp = createHash("sha256")
    .update(
      JSON.stringify({
        tape: opts.tapeFingerprint,
        id: opts.id,
        version: opts.version,
        seed: opts.seed,
        from: opts.run.from,
        to: opts.run.to,
        step: opts.run.stepMs,
        approved: opts.run.considerations.map((c) => [c.decisionTime, c.mint, c.approved, c.vetoReason]),
      }),
    )
    .digest("hex");
  const authorizedCount = opts.run.considerations.filter((c) => c.approved).length;
  const vetoedCount = opts.run.considerations.filter((c) => !c.approved).length;
  return {
    id: opts.id,
    version: opts.version,
    liveWired: opts.liveWired,
    published: opts.published,
    seed: opts.seed,
    hypothesisIndex: opts.hypothesisIndex,
    fingerprint: fp,
    considerations: opts.run.considerations.length,
    authorized: authorizedCount,
    vetoed: vetoedCount,
    labeled: labeled.length,
    uniqueTokensAuthorized: new Set(authorized.map((r) => r.tokenAddress)).size,
    median15mAuthorizedConsideration: median(considerationRets),
    median15mAuthorizedToken: tokenMed.median,
    vsUniverseDelta,
    beatsUniverse: vsUniverseDelta == null ? null : vsUniverseDelta > 0,
    walkForward: {
      trainEnd,
      validationEnd,
      train: split.train.length,
      validation: split.validation.length,
      test: split.test.length,
      tokenLeakageTrainTest: leaked,
      note:
        split.train.length === 0
          ? "Train empty after 1h label-horizon purge — tape span too short to claim a walk-forward result."
          : leaked.length
            ? `Token leakage into test: ${leaked.length} mints. Do not treat as independent.`
            : "Walk-forward purge applied (decision_time + 1h < split bound).",
    },
    monotonicityVerdict: mono.verdict,
    spearman15m: mono.spearman15m,
    leakageViolations: opts.run.leakageViolations,
    stats: buildReplayTradeStats({
      labeled: opts.run.labeled,
      considerations: opts.run.considerations.length,
      authorized: authorizedCount,
      vetoed: vetoedCount,
    }),
    note: opts.published
      ? `${baseline.note} Published hypothesis ${opts.hypothesisIndex}/${V33B_HYPOTHESIS_COUNT}. Not live-wired. Not claimed alpha.`
      : baseline.note,
  };
}

function dummyStrategy(id: StrategyDef["id"]): StrategyDef {
  return STRATEGIES.find((s) => s.id === id) ?? STRATEGIES[3];
}

function researchRun(
  obs: ReplayObservation[],
  opts: {
    id: string;
    version: number | string;
    from: number;
    to: number;
    stepMs: number;
    mints: string[];
    tapeFingerprint: string;
    universeMedian: number | null;
    published: boolean;
    seed: number | null;
    hypothesisIndex: number | null;
    matches: (args: { token: TokenLive; features: Features; predictions: Predictions; regime: Regime }) => boolean;
  },
): ReplayBaselineSlice {
  const run = replayStrategy({
    observations: obs,
    strategy: dummyStrategy("trend_continuation"),
    from: opts.from,
    to: opts.to,
    stepMs: opts.stepMs,
    mints: opts.mints,
    regime: "meme_mania",
    matches: opts.matches,
    strategyLabel: opts.id,
  });
  for (const c of run.considerations) c.strategyId = opts.id;
  return summarizeRun({
    id: opts.id,
    version: opts.version,
    liveWired: false,
    published: opts.published,
    seed: opts.seed,
    hypothesisIndex: opts.hypothesisIndex,
    tapeFingerprint: opts.tapeFingerprint,
    run,
    universeMedian: opts.universeMedian,
  });
}

export function runDeterministicReplayBaselines(
  observations: ReplayObservation[],
  opts?: { from?: number; to?: number; stepMs?: number; mints?: number },
): ReplayBaselineReport {
  const obs = [...observations].sort((a, b) => a.ingestedAt - b.ingestedAt || a.mint.localeCompare(b.mint) || a.eventTime - b.eventTime);
  const from = opts?.from ?? obs[0]?.ingestedAt ?? 0;
  const to = opts?.to ?? obs.at(-1)?.ingestedAt ?? 0;
  const stepMs = opts?.stepMs ?? 20_000;
  const mints = [...new Set(obs.map((o) => o.mint))].slice(0, opts?.mints ?? 24);
  const tapeFingerprint = replayTapeFingerprint(obs, from, to, stepMs);
  const universe = universeBuyAndHold15m(obs);

  const live = STRATEGIES.filter((s) => s.id !== "flat").map((strategy) => {
    const run = replayStrategy({ observations: obs, strategy, from, to, stepMs, mints, regime: "meme_mania" });
    return summarizeRun({
      id: strategy.id,
      version: STRATEGY_VERSION,
      liveWired: true,
      published: false,
      seed: null,
      hypothesisIndex: null,
      tapeFingerprint,
      run,
      universeMedian: universe.median15m,
    });
  });

  const common = { from, to, stepMs, mints, tapeFingerprint, universeMedian: universe.median15m };
  const randomMeta = publishedMeta("random_eligible");
  const momentumMeta = publishedMeta("baseline_safe_momentum");
  const safetyMeta = publishedMeta("safety_only");
  const research = [
    researchRun(obs, {
      ...common,
      id: "random_eligible",
      version: 1,
      published: true,
      seed: RANDOM_ELIGIBLE_SEED,
      hypothesisIndex: randomMeta?.index ?? 1,
      matches: (args) => matchRandomEligible(args, RANDOM_ELIGIBLE_SEED),
    }),
    researchRun(obs, {
      ...common,
      id: "baseline_safe_momentum",
      version: 1,
      published: true,
      seed: null,
      hypothesisIndex: momentumMeta?.index ?? 2,
      matches: matchBaselineSafeMomentum,
    }),
    researchRun(obs, {
      ...common,
      id: "safety_only",
      version: 1,
      published: true,
      seed: null,
      hypothesisIndex: safetyMeta?.index ?? 3,
      matches: matchSafetyOnly,
    }),
    researchRun(obs, {
      ...common,
      id: "eligible_universe",
      version: 1,
      published: false,
      seed: null,
      hypothesisIndex: null,
      matches: matchEligibleUniverse,
    }),
  ];

  const leakage = [...live, ...research].reduce((a, s) => a + s.leakageViolations, 0);
  const published = research.filter((s) => s.published);
  const compared = published.filter((s) => s.beatsUniverse != null);
  const beating = compared.filter((s) => s.beatsUniverse).map((s) => s.id);
  return {
    generatedAt: Date.now(),
    tapeFingerprint,
    observations: obs.length,
    uniqueTokens: new Set(obs.map((o) => o.mint)).size,
    from,
    to,
    stepMs,
    leakageViolations: leakage,
    readyForReplay: true,
    readyForModeling: false,
    hypothesisCount: V33B_HYPOTHESIS_COUNT,
    publishedSeed: RANDOM_ELIGIBLE_SEED,
    universe: {
      uniqueTokens: universe.uniqueTokens,
      labeled: universe.labeled,
      median15m: universe.median15m,
      note: "Buy-and-hold from first visible price, token-grouped 15m. Null baseline, not a strategy.",
    },
    note:
      leakage > 0
        ? `Replay found ${leakage} leakage violations. Ready for replay YES. Ready for ML NO.`
        : `Warehouse-only replay. ${V33B_HYPOTHESIS_COUNT} published hypotheses (seed ${RANDOM_ELIGIBLE_SEED}). Beating universe (not claimed alpha): ${beating.join(", ") || "none"}. Ready for replay YES. Ready for ML NO.`,
    strategies: [...live, ...research],
  };
}
