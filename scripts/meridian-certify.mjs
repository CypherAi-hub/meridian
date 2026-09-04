#!/usr/bin/env node
/**
 * V3.4 PREP.1 dataset certification. Read-only. Does not train.
 * Prints READY / NOT READY. Training remains LOCKED.
 */
const { loadHealthPayload } = await import("../src/lib/desk/quality.server.ts");
const { exportRows } = await import("../src/lib/desk/repo.server.ts");
const { buildDataset } = await import("../src/lib/desk/v34-dataset.ts");
const { purgedEmbargoTokenSplit } = await import("../src/lib/desk/v34-splits.ts");
const { certifyCorpus, formatCertification } = await import("../src/lib/desk/v34-certify.ts");
const { freezeTrainingManifest } = await import("../src/lib/desk/v34-manifest.ts");
const { missingnessAudit, featureDistributionAudit, targetBalanceAudit, splitReport } = await import(
  "../src/lib/desk/v34-audit.ts"
);
const { toFeatureMatrix } = await import("../src/lib/desk/v34-matrix.ts");

const health = await loadHealthPayload();
const rows = await exportRows();
const built = buildDataset(rows);
const times = built.rows.map((r) => r.decision_time).sort((a, b) => a - b);
const span = (times.at(-1) ?? 0) - (times[0] ?? 0);
const trainEnd = (times[0] ?? 0) + Math.floor(span * 0.6);
const validationEnd = (times[0] ?? 0) + Math.floor(span * 0.8);
const splits = purgedEmbargoTokenSplit(built.rows, { trainEnd, validationEnd });
const report = certifyCorpus(health.quality, {
  leakedTokens: splits.leakedTokens.length,
  eligibleRows: built.rows.length,
  uniqueTokens: built.manifest.uniqueTokens || health.quality.epochUniqueTokens,
  manifest: built.manifest,
});
const matrix = toFeatureMatrix(built.rows);
const miss = missingnessAudit(matrix.rows);
const dist = featureDistributionAudit(matrix.rows);
const targets = targetBalanceAudit(matrix.rows);
const folds = splitReport(splits, { trainEnd });
const frozen = freezeTrainingManifest({
  rows: built.rows,
  dataset: built.manifest,
  splits,
  trainEnd,
  validationEnd,
  codeCommit: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT ?? "local",
  certification: report,
});

console.log(formatCertification(report));
console.log("");
console.log("eligible-row count   ", built.rows.length);
console.log("dataset hash         ", built.manifest.hash);
console.log("frozen manifest      ", frozen.id);
console.log("certified            ", frozen.certified);
console.log("trainingAllowed      ", frozen.trainingAllowed);
console.log("missingness flagged  ", miss.flagged.join(",") || "none");
console.log("constant features    ", dist.constant.join(",") || "none");
console.log("target hit10         ", targets.hit10, "/", targets.n);
console.log("split train/val/test ", folds.folds.map((f) => `${f.name}:${f.tokens}tok`).join(" "));
console.log("purge/token-group    ", folds.purgeOk, folds.tokenGroupedOk);
process.exit(report.status === "READY" ? 0 : 2);
