import { derivedRouteCheckCoverage, researchHealth } from "./research-health.ts";
import { FEATURE_ENGINE_VERSION, LABEL_DEFINITION_VERSION } from "./versions.ts";
import { ML_TRAINING_LOCKED, PRODUCTION_EPOCH } from "./v34-lock.ts";
import type { DataQuality } from "./types.ts";
import type { DatasetManifest } from "./v34-dataset.ts";

export type CertStatus = "READY" | "NOT READY";

export type CertGate = {
  name: string;
  required: string;
  actual: string;
  pass: boolean;
};

export type CertificationReport = {
  status: CertStatus;
  training: "LOCKED";
  epoch: string;
  featureEngineVersion: string;
  labelDefinitionVersion: string;
  eligibleRows: number;
  uniqueTokens: number;
  leakedTokens: number;
  soakHours: number | null;
  gates: CertGate[];
  blockers: string[];
};

const HOUR = 3_600_000;

function gate(name: string, required: string, actual: string, pass: boolean): CertGate {
  return { name, required, actual, pass };
}

function pct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  return `${(n * 100).toFixed(1)}%`;
}

export function certifyCorpus(
  quality: DataQuality,
  opts?: {
    now?: number;
    leakedTokens?: number;
    eligibleRows?: number;
    uniqueTokens?: number;
    featureEngineVersion?: string;
    labelDefinitionVersion?: string;
    manifest?: DatasetManifest;
  },
): CertificationReport {
  const now = opts?.now ?? Date.now();
  const soakMs = quality.productionSoakStartedAtMs;
  const soakHours = soakMs == null ? null : (now - soakMs) / HOUR;
  const health = researchHealth(quality, { useEpoch: true });
  const holder =
    quality.holderCoverageAtDecisionPct ?? quality.epochHolderCoveragePct ?? quality.holderCoveragePct ?? 0;
  const highMed =
    (quality.epochHighConfidencePct ?? 0) + (quality.epochMediumConfidencePct ?? 0);
  const gradeAB = (quality.epochGradeA ?? 0) + (quality.epochGradeB ?? 0);
  const gradeN =
    gradeAB + (quality.epochGradeC ?? 0) + (quality.epochResearchOnly ?? 0);
  const gradePct = gradeN ? gradeAB / gradeN : 0;
  const route = derivedRouteCheckCoverage(quality, true);
  const tokens = opts?.uniqueTokens ?? quality.epochUniqueTokens ?? 0;
  const leakedKnown = opts?.leakedTokens != null;
  const leaked = opts?.leakedTokens ?? 0;
  const eligible = opts?.eligibleRows ?? opts?.manifest?.rowCount ?? 0;
  const gates: CertGate[] = [
    gate("SOAK", "72h", soakHours == null ? "not started" : `${soakHours.toFixed(2)}h`, soakHours != null && soakHours >= 72),
    gate("UNIQUE TOKENS", "500+", String(tokens), tokens >= 500),
    gate("HOLDER @ DECISION", "80%+", pct(holder), holder >= 0.8),
    gate("ROUTE CHECK", "90%+", pct(route), route >= 0.9),
    gate("HIGH + MEDIUM", "65%+", pct(highMed), highMed >= 0.65),
    gate("GRADE A+B", "50%+", pct(gradePct), gradePct >= 0.5),
    gate("LEAKAGE", "0", leakedKnown ? String(leaked) : "pending", leakedKnown && leaked === 0),
  ];
  const blockers = gates.filter((g) => !g.pass).map((g) => `${g.name} ${g.actual} < ${g.required}`);
  blockers.push(...health.blockers.filter((b) => !blockers.some((x) => x.includes(b.slice(0, 12)))));
  const status: CertStatus = gates.every((g) => g.pass) ? "READY" : "NOT READY";
  void ML_TRAINING_LOCKED;
  return {
    status,
    training: "LOCKED",
    epoch: quality.collectionEpoch ?? PRODUCTION_EPOCH,
    featureEngineVersion: opts?.featureEngineVersion ?? opts?.manifest?.featureEngineVersion ?? FEATURE_ENGINE_VERSION,
    labelDefinitionVersion:
      opts?.labelDefinitionVersion ?? opts?.manifest?.labelDefinitionVersion ?? LABEL_DEFINITION_VERSION,
    eligibleRows: eligible,
    uniqueTokens: tokens,
    leakedTokens: leaked,
    soakHours,
    gates,
    blockers: [...new Set(blockers)],
  };
}

export function formatCertification(report: CertificationReport): string {
  const lines = [
    `MERIDIAN DATA CERTIFICATION`,
    `status               ${report.status}`,
    `training             ${report.training}`,
    `epoch                ${report.epoch}`,
    `feature engine       ${report.featureEngineVersion}`,
    `label definition     ${report.labelDefinitionVersion}`,
    `eligible rows        ${report.eligibleRows}`,
    ...report.gates.map((g) => `${g.name.padEnd(20)} ${g.actual.padEnd(12)} ${g.pass ? "✅" : "❌"}  need ${g.required}`),
  ];
  if (report.blockers.length) {
    lines.push("blockers:");
    for (const b of report.blockers) lines.push(`  - ${b}`);
  }
  return lines.join("\n");
}
