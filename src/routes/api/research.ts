import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/research")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const format = url.searchParams.get("format") ?? "json";
        const view = url.searchParams.get("view");
        if (view === "stats") {
          const { loadHealthPayload } = await import("@/lib/desk/quality.server");
          return Response.json(await loadHealthPayload());
        }
        if (view === "baseline" || view === "edge" || view === "wasserstein") {
          const { exportRows } = await import("@/lib/desk/repo.server");
          const { buildBaselineReport, analyzeEdgeMonotonicity } = await import("@/lib/desk/baseline");
          const { analyzeWasserstein } = await import("@/lib/desk/wasserstein");
          const rows = await exportRows();
          if (view === "wasserstein") return Response.json(analyzeWasserstein(rows));
          if (view === "edge") {
            const mono = analyzeEdgeMonotonicity(rows);
            return Response.json({ ...mono, wasserstein: analyzeWasserstein(rows) });
          }
          const report = buildBaselineReport(rows);
          report.monotonicity = { ...report.monotonicity, wasserstein: analyzeWasserstein(rows) };
          return Response.json(report);
        }
        if (view === "replay") {
          const { runWarehouseReplay } = await import("@/lib/desk/replay.server");
          return Response.json(await runWarehouseReplay());
        }
        if (view === "replay-baselines" || view === "baselines") {
          const { runDeterministicBaselines } = await import("@/lib/desk/replay.server");
          return Response.json(await runDeterministicBaselines());
        }
        if (view === "v34-prep" || view === "intelligence" || view === "certify") {
          const { exportRows } = await import("@/lib/desk/repo.server");
          const { loadHealthPayload } = await import("@/lib/desk/quality.server");
          const { buildDataset } = await import("@/lib/desk/v34-dataset");
          const { purgedEmbargoTokenSplit } = await import("@/lib/desk/v34-splits");
          const { toFeatureMatrix } = await import("@/lib/desk/v34-matrix");
          const { evaluateProductionAlerts } = await import("@/lib/desk/v34-alerts");
          const { ML_TRAINING_LOCKED, canTrain, trainingUnlockReasons, PRODUCTION_EPOCH } = await import(
            "@/lib/desk/v34-lock"
          );
          const { certifyCorpus } = await import("@/lib/desk/v34-certify");
          const { freezeTrainingManifest } = await import("@/lib/desk/v34-manifest");
          const { missingnessAudit, featureDistributionAudit, targetBalanceAudit, splitReport } = await import(
            "@/lib/desk/v34-audit"
          );
          const health = await loadHealthPayload();
          const rows = await exportRows();
          const built = buildDataset(rows as Parameters<typeof buildDataset>[0]);
          const times = built.rows.map((r) => r.decision_time).sort((a, b) => a - b);
          const span = (times.at(-1) ?? 0) - (times[0] ?? 0);
          const trainEnd = (times[0] ?? 0) + Math.floor(span * 0.6);
          const validationEnd = (times[0] ?? 0) + Math.floor(span * 0.8);
          const splits = purgedEmbargoTokenSplit(built.rows, { trainEnd, validationEnd });
          const matrix = toFeatureMatrix(built.rows);
          const q = health.quality;
          const research = health.research as { worker?: string };
          const alerts = evaluateProductionAlerts({
            workerStatus: research?.worker,
            holderAtDecisionPct: q.holderCoverageAtDecisionPct,
            routeCheckPct: q.epochRouteCheckCoveragePct ?? q.routeCheckCoveragePct,
            activeMedianGapMs: q.activeMedianGapMs,
          });
          const certification = certifyCorpus(q, {
            leakedTokens: splits.leakedTokens.length,
            eligibleRows: built.rows.length,
            uniqueTokens: q.epochUniqueTokens ?? built.manifest.uniqueTokens,
            manifest: built.manifest,
          });
          const frozen = freezeTrainingManifest({
            rows: built.rows,
            dataset: built.manifest,
            splits,
            trainEnd,
            validationEnd,
            certification,
          });
          return Response.json({
            training: "LOCKED",
            trainingAllowed: canTrain(q),
            unlockReasons: trainingUnlockReasons(q),
            locked: ML_TRAINING_LOCKED,
            epoch: PRODUCTION_EPOCH,
            certification,
            frozen: {
              id: frozen.id,
              hash: frozen.hash,
              certified: frozen.certified,
              trainingAllowed: frozen.trainingAllowed,
              observationCount: frozen.observationIds.length,
              tokenCount: frozen.tokenIds.length,
            },
            audits: {
              missingness: missingnessAudit(matrix.rows),
              distribution: featureDistributionAudit(matrix.rows),
              targets: targetBalanceAudit(matrix.rows),
              splits: splitReport(splits, { trainEnd }),
            },
            dataset: built.manifest,
            splits: {
              train: splits.train.length,
              validation: splits.validation.length,
              test: splits.test.length,
              leakedTokens: splits.leakedTokens,
            },
            matrix: { columns: matrix.columns, schemaHash: matrix.schemaHash, rows: matrix.rows.length },
            alerts,
          });
        }
        if (view === "migrations") {
          const { loadMigrationStatus } = await import("@/lib/desk/neon-migrate");
          return Response.json(await loadMigrationStatus());
        }
        const { exportRows, rowsToCsv } = await import("@/lib/desk/repo.server");
        const rows = await exportRows();
        if (format === "csv") {
          return new Response(rowsToCsv(rows), {
            headers: {
              "content-type": "text/csv; charset=utf-8",
              "content-disposition": `attachment; filename="meridian-ledger.csv"`,
            },
          });
        }
        return Response.json(rows);
      },
    },
  },
});
