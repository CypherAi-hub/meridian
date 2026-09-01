import type { Features, FeatureMeta, GovernorVerdict, Intent, Predictions, TokenSnapshot } from "./types.ts";

export type FrozenDecision = {
  frozen_at: number;
  immutable: true;
  market: TokenSnapshot;
  features: Features;
  feature_sources: FeatureMeta;
  strategy: {
    id: string;
    decision_time: number;
  };
  governor: GovernorVerdict;
  predictions: Predictions;
  proposed_trade: {
    approved: boolean;
    sized_usd: number;
    entry: number | null;
    stop: number | null;
  };
};

export function freezeDecisionSnapshot(intent: Intent): FrozenDecision {
  return {
    frozen_at: intent.decisionTs,
    immutable: true,
    market: structuredClone(intent.snapshot),
    features: { ...intent.features },
    feature_sources: { ...intent.featureMeta },
    strategy: {
      id: intent.strategyId,
      decision_time: intent.decisionTs,
    },
    governor: {
      ...intent.governor,
      reasons: [...intent.governor.reasons],
      layers: intent.governor.layers.map((l) => ({ ...l })),
    },
    predictions: { ...intent.predictions },
    proposed_trade: {
      approved: intent.governor.approved,
      sized_usd: intent.governor.sizedUsd,
      entry: intent.snapshot.priceUsd.value,
      stop:
        intent.snapshot.priceUsd.value != null
          ? intent.snapshot.priceUsd.value * (1 - intent.predictions.maeQ90)
          : null,
    },
  };
}

/** Warehouse rule: never replace a frozen snapshot. First writer wins. */
export function insertFrozenSnapshot<T>(store: Map<string, T>, id: string, value: T): boolean {
  if (store.has(id)) return false;
  store.set(id, value);
  return true;
}
