import { createHash } from "node:crypto";

export type TrialRecord = {
  trial: number;
  configHash: string;
  config: unknown;
  metric: number | null;
  at: number;
};

export type MultipleTestingLedger = {
  experimentId: string;
  trials: TrialRecord[];
};

export function createTrialLedger(experimentId: string): MultipleTestingLedger {
  return { experimentId, trials: [] };
}

export function registerTrial(ledger: MultipleTestingLedger, config: unknown, metric: number | null): MultipleTestingLedger {
  const configHash = createHash("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 16);
  const trial: TrialRecord = { trial: ledger.trials.length + 1, configHash, config, metric, at: Date.now() };
  return { ...ledger, trials: [...ledger.trials, trial] };
}

export function disclosedWinner(ledger: MultipleTestingLedger): {
  winner: TrialRecord | null;
  nTried: number;
  note: string;
} {
  const scored = ledger.trials.filter((t) => t.metric != null);
  const winner = scored.length
    ? scored.reduce((a, b) => ((a.metric ?? Infinity) <= (b.metric ?? Infinity) ? a : b))
    : null;
  return {
    winner,
    nTried: ledger.trials.length,
    note: `Winner is trial ${winner?.trial ?? "none"} of ${ledger.trials.length} registered configs. Not hypothesis #1 unless nTried=1.`,
  };
}
