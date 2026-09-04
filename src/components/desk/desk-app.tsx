import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Activity,
  Ban,
  BookOpen,
  Database,
  Download,
  Gauge,
  Pause,
  Play,
  RotateCcw,
  Shield,
  Waypoints,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spark } from "@/components/desk/spark";
import { bucketLabel, bucketOf, isResearchBucket } from "@/lib/desk/buckets";
import { inspect } from "@/lib/desk/engine";
import { ageLabel, clock, compact, pct, regimeLabel, shortAddr, usd } from "@/lib/desk/format";
import { meanOf } from "@/lib/desk/ledger";
import { STRATEGIES } from "@/lib/desk/strategies";
import { startDeskLoop, stopDeskLoop, useDesk } from "@/lib/desk/store";
import type { DataQuality, FeatureMeta, GateResult, LedgerRow, Regime, ResearchSummary, SourceHealth, UniverseBucket, WorkerHealth } from "@/lib/desk/types";
import type { MonotonicityReport } from "@/lib/desk/baseline";
import { emptyQuality } from "@/lib/desk/types";
import { researchHealth } from "@/lib/desk/research-health";
import { evaluateProductionAlerts } from "@/lib/desk/v34-alerts";
import { ML_TRAINING_LOCKED, PRODUCTION_EPOCH } from "@/lib/desk/v34-lock";
import { certifyCorpus } from "@/lib/desk/v34-certify";
import { cn } from "@/lib/utils";

const TABS = ["scan", "inspect", "book", "journal", "research"] as const;
type Tab = (typeof TABS)[number];

export function DeskApp() {
  const desk = useDesk();
  const [tab, setTab] = useState<Tab>("scan");
  const [showDsl, setShowDsl] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [scope, setScope] = useState<"research" | "all">("research");

  useEffect(() => {
    setMounted(true);
    startDeskLoop();
    return () => stopDeskLoop();
  }, []);

  const view = inspect(desk, desk.selected);
  const unreal = desk.positions.reduce((a, p) => {
    const t = desk.tokens.find((x) => x.address === p.tokenAddress);
    const px = t?.priceUsd.value ?? p.entry;
    return a + p.qty * px - p.notional;
  }, 0);
  const day = desk.equity - desk.startEquity;
  const quoteMs = view?.t.sellQuote?.latencyMs ?? view?.t.buyQuote?.latencyMs ?? null;
  const shown = desk.tokens.filter((t) => {
    if (scope === "all") return true;
    const age = t.createdAt ? (desk.now - t.createdAt) / 1000 : null;
    return isResearchBucket(bucketOf(age));
  });

  return (
    <div className="flex min-h-dvh flex-col bg-bg text-fg">
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3 sm:px-6">
        <div className="flex items-baseline gap-3">
          <h1 className="font-sans text-lg font-medium tracking-tight">Meridian</h1>
          <p className="hidden text-xs text-muted lg:block">V3.3B · warehouse replay</p>
        </div>
        <Badge variant={desk.worker.db === "neon" ? "up" : "warn"}>
          {(desk.quality?.environment ?? "preview").toUpperCase()} / {(desk.worker.db ?? "pglite").toUpperCase()}
        </Badge>
        <Badge variant={desk.worker.status === "live" ? "up" : desk.worker.status === "starting" ? "warn" : "down"}>
          {desk.worker.status === "live"
            ? "Worker live"
            : desk.worker.status === "starting"
              ? "Worker starting"
              : "Worker OFFLINE"}
        </Badge>
        {(() => {
          const rh = researchHealth(desk.quality ?? emptyQuality());
          return (
            <Badge variant={rh.status === "HEALTHY" ? "up" : "warn"} title={rh.blockers.join(" · ")}>
              Research {rh.status}
            </Badge>
          );
        })()}
        <Badge variant={desk.realData ? "up" : "warn"}>
          {desk.realData ? "Real data / paper" : "No tape / paper"}
        </Badge>
        <Badge variant={desk.running && !desk.halted ? "primary" : "warn"}>
          {desk.halted ? "Halted" : desk.running ? "Collecting" : "Paused"}
        </Badge>
        <RegimeChip regime={desk.regime} />
        <div className="ml-auto flex flex-wrap items-center gap-2 sm:gap-4">
          <Stat label="Equity" value={usd(desk.equity, 0)} />
          <Stat label="Day" value={usd(day, 0)} signed={day} />
          <Stat label="Obs" value={String(desk.research.considerations)} />
          <Button
            size="sm"
            variant={desk.running ? "secondary" : "default"}
            onClick={desk.toggle}
            className="min-w-11"
          >
            {desk.running ? <Pause /> : <Play />}
            <span className="hidden sm:inline">{desk.running ? "Pause" : "Run"}</span>
          </Button>
        </div>
      </header>

      <SourceStrip
        sources={desk.sources}
        tapeAgeMs={desk.tapeAgeMs}
        fetchMs={desk.feedLagMs}
        quoteMs={quoteMs}
        error={desk.feedError}
        worker={desk.worker}
      />
      <ConfigStrip />

      <div className="flex items-center gap-1 overflow-x-auto border-b border-border px-2 sm:hidden">
        {TABS.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={cn(
              "h-11 min-w-14 flex-1 px-2 text-xs font-medium capitalize",
              tab === id ? "text-fg border-b border-primary" : "text-muted",
            )}
          >
            {id}
          </button>
        ))}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(280px,0.9fr)]">
        <section className={cn("min-h-0 border-b border-border lg:border-b-0 lg:border-r", hide(tab, "scan"))}>
          <SectionHead
            icon={<Activity className="size-3.5" />}
            title="Universe"
            meta={`${shown.length}/${desk.tokens.length} · ${desk.feedLagMs}ms`}
          />
          <div className="flex gap-2 border-b border-border px-4 py-2 sm:px-5">
            <button
              type="button"
              onClick={() => setScope("research")}
              className={cn("h-8 px-2 text-xs", scope === "research" ? "text-fg" : "text-muted")}
            >
              New / early / emerging
            </button>
            <button
              type="button"
              onClick={() => setScope("all")}
              className={cn("h-8 px-2 text-xs", scope === "all" ? "text-fg" : "text-muted")}
            >
              All tape
            </button>
          </div>
          <div className="max-h-[42vh] overflow-auto lg:max-h-[calc(100dvh-18rem)]">
            {desk.tokens.length === 0 ? (
              <p className="px-5 py-8 text-sm text-muted">
                {desk.feedError ??
                  "Ingesting Solana pools. Research universe is new, early, and emerging. Established names stay off the candidate set."}
              </p>
            ) : shown.length === 0 ? (
              <p className="px-5 py-8 text-sm text-muted">
                No new / early / emerging names on this tape. Switch to All tape to see established coins.
              </p>
            ) : (
              shown.map((t) => {
                const px = t.priceUsd.value ?? 0;
                const up = px >= (t.history[0] ?? px);
                const selected = t.address === desk.selected;
                const age = t.createdAt ? (desk.now - t.createdAt) / 1000 : null;
                const bucket = bucketOf(age);
                return (
                  <button
                    key={t.address}
                    type="button"
                    onClick={() => {
                      desk.select(t.address);
                      setTab("inspect");
                    }}
                    className={cn(
                      "grid w-full grid-cols-[4.5rem_1fr_auto] items-center gap-3 border-b border-border px-4 py-3 text-left sm:px-5",
                      selected ? "bg-elevated" : "hover:bg-surface",
                      t.rugged && "opacity-50",
                    )}
                  >
                    <div>
                      <div className="font-mono text-sm">{t.symbol}</div>
                      <div className="truncate text-xs text-subtle">{bucketLabel(bucket)}</div>
                    </div>
                    <Spark data={t.history} up={up} className="h-8 w-full" />
                    <div className="text-right">
                      <div className={cn("font-mono text-sm tabular-nums", up ? "text-up" : "text-down")}>
                        {px ? px.toPrecision(3) : "—"}
                      </div>
                      <div className="font-mono text-xs text-muted tabular-nums">
                        {ageLabel(age)} · {usd(t.liquidityUsd.value ?? 0, 0)}
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </section>

        <section className={cn("min-h-0 border-b border-border lg:border-b-0 lg:border-r", hide(tab, "inspect"))}>
          <SectionHead
            icon={<Gauge className="size-3.5" />}
            title="Decision"
            meta={view ? shortAddr(view.t.address) : "—"}
          />
          {view ? (
            <div className="space-y-5 px-4 py-4 sm:px-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-xl font-medium tracking-tight">{view.t.symbol}</h2>
                    <RouteBadge t={view.t} />
                    <Badge variant={isResearchBucket(view.f.bucket) ? "primary" : "default"}>
                      {bucketLabel(view.f.bucket)}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    Age {ageLabel(view.f.tokenAgeS)} · mcap {usd(view.t.mcapUsd.value ?? 0, 0)} ·{" "}
                    {view.t.priceUsd.source}
                  </p>
                </div>
                <Spark data={view.t.history} up={view.f.ret1m >= 0} className="h-10 w-28" />
              </div>

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Metric label="Entry impact" value={fmtImp(view.gov.entryImpactPct)} tone={failImp(view.gov.entryImpactPct)} />
                <Metric label="Exit impact" value={fmtImp(view.gov.exitImpactPct)} tone={failImp(view.gov.exitImpactPct)} />
                <Metric
                  label="Stressed exit"
                  value={pct(view.gov.stressedExitPct)}
                  tone={view.gov.stressedExitPct > 0.07 ? "down" : "up"}
                />
                <Metric label="Quote lag" value={quoteMs != null ? `${quoteMs}ms` : "—"} />
              </div>

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Metric label="Momentum" value={view.pred.momentumScore.toFixed(0)} />
                <Metric label="Flow" value={view.pred.flowScore.toFixed(0)} />
                <Metric label="Safety" value={view.pred.safetyScore.toFixed(0)} />
                <Metric label="Edge" value={view.pred.edgeScore.toFixed(0)} />
              </div>

              {view.frozen ? (
                <p className="text-xs text-muted">
                  Last consideration {clock(view.frozen.decisionTs)} · frozen edge{" "}
                  {view.frozen.predictions.edgeScore.toFixed(0)} ·{" "}
                  {view.frozen.governor.approved ? "authorized" : "vetoed"}. Live numbers above are now; the
                  ledger never rewrites the frozen vector.
                </p>
              ) : null}

              <GovernorCard gov={view.gov} />

              <FeatureGrid f={view.f} meta={view.meta} />
            </div>
          ) : (
            <p className="px-5 py-8 text-sm text-muted">No token on the tape yet.</p>
          )}
        </section>

        <section className={cn("min-h-0", hide(tab, "book"))}>
          <SectionHead icon={<BookOpen className="size-3.5" />} title="Book" meta={`${desk.positions.length}/${desk.maxPositions}`} />
          <div className="space-y-4 px-4 py-4 sm:px-5">
            {desk.positions.length === 0 ? (
              <p className="text-sm text-muted">
                No paper inventory. Fills only after a Jupiter sell route and a passing governor.
              </p>
            ) : (
              desk.positions.map((p) => {
                const t = desk.tokens.find((x) => x.address === p.tokenAddress);
                const px = t?.priceUsd.value ?? p.entry;
                const pnl = p.qty * px - p.notional;
                return (
                  <div key={p.tokenAddress} className="rounded-md bg-surface px-3 py-3">
                    <div className="flex items-baseline justify-between">
                      <span className="font-mono text-sm">{p.symbol}</span>
                      <span className={cn("font-mono text-sm tabular-nums", pnl >= 0 ? "text-up" : "text-down")}>
                        {usd(pnl)}
                      </span>
                    </div>
                    <div className="mt-1 flex justify-between font-mono text-xs text-muted tabular-nums">
                      <span>{usd(p.notional, 0)}</span>
                      <span>
                        {pct(px / p.entry - 1)} · exit {fmtImp(p.exitQuoteImpactPct)}
                      </span>
                    </div>
                  </div>
                );
              })
            )}

            <div className="rounded-lg bg-elevated p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs uppercase tracking-wider text-subtle">Risk / name</span>
                <span className="font-mono text-xs tabular-nums">{desk.riskBps} bps</span>
              </div>
              {mounted ? (
                <input
                  type="range"
                  min={8}
                  max={60}
                  value={desk.riskBps}
                  onChange={(e) => desk.setRisk(Number(e.target.value))}
                  className="mt-3 w-full accent-primary"
                  aria-label="Risk per name in basis points"
                />
              ) : (
                <div className="mt-3 h-4" />
              )}
              <div className="mt-4 flex items-center justify-between gap-2">
                <span className="text-xs uppercase tracking-wider text-subtle">Slippage</span>
                <span className="font-mono text-xs tabular-nums">{desk.slippageBps} bps</span>
              </div>
              {mounted ? (
                <input
                  type="range"
                  min={10}
                  max={150}
                  value={desk.slippageBps}
                  onChange={(e) => desk.setSlippage(Number(e.target.value))}
                  className="mt-3 w-full accent-primary"
                  aria-label="Paper slippage in basis points"
                />
              ) : (
                <div className="mt-3 h-4" />
              )}
              <Button size="sm" variant="secondary" className="mt-4 w-full" onClick={desk.resetBook}>
                <RotateCcw />
                Reset book
              </Button>
              <p className="mt-3 text-xs leading-relaxed text-subtle">
                Reset book clears paper inventory only. Research rows stay in the warehouse. Pause stops new
                entries; the worker keeps labeling.
              </p>
            </div>

            <button
              type="button"
              onClick={() => setShowDsl((v) => !v)}
              className="flex h-11 w-full items-center gap-2 rounded-md bg-surface px-3 text-left text-sm text-muted hover:text-fg"
            >
              <Waypoints className="size-4" />
              {showDsl ? "Hide strategy DSL" : "Show strategy DSL"}
            </button>
            {showDsl ? (
              <pre className="max-h-48 overflow-auto rounded-md bg-bg p-3 font-mono text-xs leading-relaxed text-muted">
                {JSON.stringify(
                  STRATEGIES.find((x) => x.id === (view?.def.id ?? "launch_velocity_pullback")),
                  null,
                  2,
                )}
              </pre>
            ) : null}
          </div>
        </section>
      </div>

      <footer className={cn("border-t border-border", hide(tab, "journal"))}>
        <SectionHead
          icon={<Ban className="size-3.5" />}
          title="Journal"
          meta={`${desk.winCount}W / ${desk.lossCount}L · ${desk.fills} fills`}
        />
        <div className="flex max-h-36 flex-col overflow-auto lg:max-h-44">
          {desk.journal.map((e) => (
            <div
              key={e.id}
              className="grid grid-cols-[4.8rem_5.5rem_1fr] gap-3 border-b border-border px-4 py-2.5 text-xs sm:grid-cols-[5.5rem_7rem_1fr_auto] sm:px-5"
            >
              <span className="font-mono text-subtle tabular-nums">{clock(e.ts)}</span>
              <span className="text-muted">{e.kind}</span>
              <span>
                <span className="text-fg">{e.title}</span>
                <span className="hidden text-muted sm:inline"> — {e.detail}</span>
              </span>
              {typeof e.pnl === "number" ? (
                <span className={cn("hidden font-mono tabular-nums sm:inline", e.pnl >= 0 ? "text-up" : "text-down")}>
                  {usd(e.pnl)}
                </span>
              ) : (
                <span className="hidden sm:inline" />
              )}
            </div>
          ))}
        </div>
      </footer>

      <section className={cn("border-t border-border", hide(tab, "research"))}>
        <SectionHead
          icon={<Database className="size-3.5" />}
          title="Research"
          meta={`${desk.research.considerations} obs · ${desk.research.labeled} labeled`}
        />
        <ResearchPanel
          summary={desk.research}
          rows={desk.ledger}
          worker={desk.worker}
          quality={desk.quality ?? emptyQuality()}
          onExport={(format) => {
            void desk.dumpResearch(format).then((payload) => {
              const blob =
                format === "csv"
                  ? new Blob([payload as string], { type: "text/csv" })
                  : new Blob([JSON.stringify(payload)], { type: "application/json" });
              const a = document.createElement("a");
              a.href = URL.createObjectURL(blob);
              a.download = `meridian-ledger-${new Date().toISOString().slice(0, 10)}.${format}`;
              a.click();
              URL.revokeObjectURL(a.href);
            });
          }}
        />
      </section>
    </div>
  );
}

function hide(tab: Tab, id: Tab) {
  if (id === "research") return tab === "research" ? "block" : "hidden lg:block";
  return tab === id ? "block" : "hidden lg:block";
}

function SectionHead({ icon, title, meta }: { icon: ReactNode; title: string; meta: string }) {
  return (
    <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 sm:px-5">
      <span className="text-muted">{icon}</span>
      <h2 className="text-xs font-medium uppercase tracking-wider text-muted">{title}</h2>
      <span className="ml-auto font-mono text-xs text-subtle tabular-nums">{meta}</span>
    </div>
  );
}

function Stat({ label, value, signed }: { label: string; value: string; signed?: number }) {
  const tone = signed == null ? "text-fg" : signed > 0 ? "text-up" : signed < 0 ? "text-down" : "text-fg";
  return (
    <div className="min-w-16">
      <div className="text-xs uppercase tracking-wider text-subtle">{label}</div>
      <div className={cn("font-mono text-sm tabular-nums", tone)}>{value}</div>
    </div>
  );
}

function RegimeChip({ regime }: { regime: Regime }) {
  const variant = regime === "risk_off" ? "warn" : regime === "meme_mania" ? "primary" : "default";
  return <Badge variant={variant}>{regimeLabel(regime)}</Badge>;
}

function Metric({
  label,
  value,
  tone = "fg",
}: {
  label: string;
  value: string;
  tone?: "fg" | "up" | "down";
}) {
  return (
    <div className="rounded-md bg-surface px-3 py-2">
      <div className="text-xs uppercase tracking-wider text-subtle">{label}</div>
      <div
        className={cn(
          "mt-1 font-mono text-sm tabular-nums",
          tone === "up" && "text-up",
          tone === "down" && "text-down",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function fmtImp(n: number | null | undefined) {
  if (n == null) return "—";
  const v = n > 1 ? n / 100 : n;
  return `${(v * 100).toFixed(2)}%`;
}

function failImp(n: number | null | undefined): "fg" | "up" | "down" {
  if (n == null) return "fg";
  const v = n > 1 ? n / 100 : n;
  return v > 0.07 ? "down" : "up";
}

function RouteBadge({ t }: { t: NonNullable<ReturnType<typeof inspect>>["t"] }) {
  if (t.sellQuote?.available) return <Badge variant="up">Jupiter route</Badge>;
  if (t.sellQuote && !t.sellQuote.available) return <Badge variant="down">No exit</Badge>;
  return <Badge variant="warn">Unquoted</Badge>;
}

function GovernorCard({ gov }: { gov: NonNullable<ReturnType<typeof inspect>>["gov"] }) {
  return (
    <div
      className={cn(
        "rounded-lg bg-elevated px-4 py-3",
        gov.approved
          ? "shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-up)_35%,transparent)]"
          : "shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-down)_35%,transparent)]",
      )}
    >
      <div className="flex items-center gap-2">
        <Shield className="size-4 text-muted" />
        <span className="text-sm font-medium">{gov.approved ? "Trade authorized" : "Trade vetoed"}</span>
        <span className="ml-auto font-mono text-xs text-muted tabular-nums">size {usd(gov.sizedUsd, 0)}</span>
      </div>
      <ul className="mt-3 space-y-1">
        {gov.layers.map((g, i) => (
          <GateRow key={`${g.name}-${i}`} gate={g} />
        ))}
      </ul>
      {!gov.approved ? (
        <p className="mt-3 text-xs text-muted">UNKNOWN is not a pass. Strategy cannot override a veto.</p>
      ) : (
        <p className="mt-3 text-xs text-muted">Sized from stressed exit, not model confidence.</p>
      )}
    </div>
  );
}

function GateRow({ gate }: { gate: GateResult }) {
  const tone =
    gate.status === "PASS" ? "text-up" : gate.status === "FAIL" ? "text-down" : "text-warn";
  return (
    <li className="grid grid-cols-[1fr_auto] gap-2 font-mono text-xs">
      <span className="text-muted">
        {gate.name}
        <span className="hidden text-subtle sm:inline"> · {gate.reason}</span>
      </span>
      <span className={cn("tabular-nums", tone)}>{gate.status}</span>
    </li>
  );
}

function FeatureGrid({
  f,
  meta,
}: {
  f: NonNullable<ReturnType<typeof inspect>>["f"];
  meta: FeatureMeta;
}) {
  const rows: [string, string][] = [
    ["bucket", bucketLabel(f.bucket)],
    ["ret", pct(f.ret1m)],
    ["vol accel", f.volAccel.toFixed(2) + "x"],
    ["imbalance", pct(f.usdImbalance)],
    ["age", ageLabel(f.tokenAgeS)],
    ["top 10", f.top10Pct == null ? "UNKNOWN" : pct(f.top10Pct, 0)],
    ["liq Δ", pct(f.liqChange1m)],
    ["liq/mcap", pct(f.liqMcapRatio, 0)],
  ];
  const freshness = ["price", "liquidity", "top10", "mint", "uniqueBuyers", "exitQuote"]
    .map((k) => {
      const m = meta[k];
      if (!m) return null;
      const unknown = k === "top10" && f.top10Pct == null ? " unknown" : "";
      return `${k} ${m.source}${unknown} ${((Date.now() - m.ingestedAt) / 1000).toFixed(0)}s`;
    })
    .filter(Boolean)
    .join(" · ");
  return (
    <div>
      <p className="mb-2 text-xs uppercase tracking-wider text-subtle">Live vector — ledger freezes on consider</p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-4">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-2 font-mono text-xs">
            <span className="text-subtle">{k}</span>
            <span className="tabular-nums text-muted">{v}</span>
          </div>
        ))}
      </div>
      {freshness ? <p className="mt-3 font-mono text-xs text-subtle">{freshness}</p> : null}
    </div>
  );
}

function SourceStrip({
  sources,
  tapeAgeMs,
  fetchMs,
  quoteMs,
  error,
  worker,
}: {
  sources: SourceHealth[];
  tapeAgeMs: number;
  fetchMs: number;
  quoteMs: number | null;
  error: string | null;
  worker: WorkerHealth;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-4 py-2 font-mono text-xs uppercase tracking-wider sm:px-6">
      <span className="flex items-center gap-1.5">
        <span className={cn("size-1.5 rounded-full", worker.status === "live" ? "bg-up" : "bg-down")} />
        <span className="text-subtle">worker</span>
        <span className="text-muted">{worker.status}</span>
      </span>
      <span className="text-muted">db {worker.db}</span>
      <span className="text-muted">up {(worker.uptimeMs / 1000).toFixed(0)}s</span>
      <span className="text-muted">ticks {worker.tickCount}</span>
      <span className="text-muted">pending {worker.pendingLabels}</span>
      <span className="text-muted">
        last mkt {worker.lastMarketEventAt ? `${((Date.now() - worker.lastMarketEventAt) / 1000).toFixed(0)}s` : "—"}
      </span>
      <span className="text-muted">prov err {worker.providerErrors}</span>
      {sources.map((s) => (
        <span key={s.id} className="flex items-center gap-1.5">
          <span
            className={cn(
              "size-1.5 rounded-full",
              s.status === "live"
                ? "bg-up"
                : s.status === "degraded" || s.status === "unconfigured"
                  ? "bg-warn"
                  : "bg-down",
            )}
          />
          <span className="text-subtle">{s.id}</span>
          <span className="text-muted">{s.status}</span>
        </span>
      ))}
      <span className="text-muted">age {(tapeAgeMs / 1000).toFixed(0)}s</span>
      <span className="text-muted">ingest {fetchMs}ms</span>
      {quoteMs != null ? <span className="text-muted">quote {quoteMs}ms</span> : null}
      {error ? <span className="text-down">{error}</span> : null}
    </div>
  );
}

function ConfigStrip() {
  const [cfg, setCfg] = useState<{
    environment?: string;
    collectionEpoch?: string;
    configured?: {
      birdeye?: boolean;
      helius?: boolean;
      jupiterMode?: string;
      rpc?: string;
      database?: string;
    };
    migrationsPending?: number;
    neonStep?: string;
    jupiterRate?: number | null;
    jupiterSkipped?: number | null;
    rugcheckRate?: number | null;
  } | null>(null);
  useEffect(() => {
    let alive = true;
    void fetch("/api/health", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((payload) => {
        if (!alive || !payload?.public) return;
        const budgets = Array.isArray(payload.rateBudgets) ? payload.rateBudgets : [];
        const jup = budgets.find((b: { name?: string }) => b.name === "jupiter");
        const rug = budgets.find((b: { name?: string }) => b.name === "rugcheck");
        setCfg({
          ...payload.public,
          migrationsPending: payload.migrations?.pending?.length ?? 0,
          neonStep: payload.migrations?.currentStep ?? payload.migrations?.steps?.find((s: { status?: string }) => s.status === "current")?.name,
          jupiterRate: typeof jup?.rate === "number" ? jup.rate : null,
          jupiterSkipped: typeof jup?.skipped === "number" ? jup.skipped : null,
          rugcheckRate: typeof rug?.rate === "number" ? rug.rate : null,
        });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  if (!cfg) return null;
  const c = cfg.configured ?? {};
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-4 py-1.5 font-mono text-[10px] uppercase tracking-wider text-muted sm:px-6">
      <span>birdeye {c.birdeye ? "configured" : "unconfigured"}</span>
      <span>helius {c.helius ? "configured" : "unconfigured"}</span>
      <span>jupiter {c.jupiterMode ?? "keyless"}</span>
      <span>rpc {c.rpc ?? "public"}</span>
      <span>db {c.database ?? "PGLITE"}</span>
      <span>epoch {cfg.collectionEpoch ?? "—"}</span>
      <span>schema {cfg.migrationsPending ? `${cfg.migrationsPending} pending` : "current"}</span>
      <span>neon {cfg.neonStep ?? "preview"}</span>
      {cfg.jupiterRate != null ? (
        <span>
          jup {cfg.jupiterRate.toFixed(2)}/s
          {cfg.jupiterSkipped ? ` · skip ${cfg.jupiterSkipped}` : ""}
        </span>
      ) : null}
      {cfg.rugcheckRate != null ? <span>rug {cfg.rugcheckRate.toFixed(2)}/s</span> : null}
    </div>
  );
}

function ResearchPanel({
  summary,
  rows,
  worker,
  quality,
  onExport,
}: {
  summary: ResearchSummary;
  rows: LedgerRow[];
  worker: WorkerHealth;
  quality: DataQuality;
  onExport: (format: "json" | "csv") => void;
}) {
  const [edge, setEdge] = useState<MonotonicityReport | null>(null);
  const [replay, setReplay] = useState<{
    tapeFingerprint?: string;
    readyForModeling?: boolean;
    readyForReplay?: boolean;
    hypothesisCount?: number;
    publishedSeed?: number;
    leakageViolations?: number;
    universe?: { median15m: number | null; labeled: number; uniqueTokens: number };
    strategies?: Array<{
      id: string;
      authorized: number;
      labeled: number;
      median15mAuthorizedToken: number | null;
      vsUniverseDelta: number | null;
      beatsUniverse: boolean | null;
      liveWired: boolean;
      published?: boolean;
      seed?: number | null;
      stats?: { expectancy: number | null; meanR: number | null; profitFactor: number | null };
    }>;
  } | null>(null);
  useEffect(() => {
    let alive = true;
    void fetch("/api/research?view=edge", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((payload: MonotonicityReport | null) => {
        if (alive && payload && typeof payload.verdict === "string") setEdge(payload);
      })
      .catch(() => undefined);
    void fetch("/api/research?view=replay-baselines", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((payload) => {
        if (alive && payload && typeof payload.tapeFingerprint === "string") setReplay(payload);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  const slice = useMemo(() => rows.slice(0, 40), [rows]);
  const net = meanOf(
    summary.byRegime.meme_mania.sumNet +
      summary.byRegime.trend.sumNet +
      summary.byRegime.chop.sumNet +
      summary.byRegime.risk_off.sumNet,
    summary.byRegime.meme_mania.nNet +
      summary.byRegime.trend.nNet +
      summary.byRegime.chop.nNet +
      summary.byRegime.risk_off.nNet,
  );
  const buckets: UniverseBucket[] = ["new_launch", "early", "emerging", "established", "mature", "unknown"];
  const regimes: Regime[] = ["meme_mania", "trend", "chop", "risk_off"];
  const researchBuckets: UniverseBucket[] = ["new_launch", "early", "emerging"];
  const rh = researchHealth(quality);
  return (
    <div>
      <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-3 lg:grid-cols-5">
        <StatBox label="Considered" value={compact(summary.considerations)} />
        <StatBox label="Vetoed" value={compact(summary.vetoed)} />
        <StatBox label="Authorized" value={compact(summary.authorized)} />
        <StatBox label="Paper takes" value={compact(summary.taken)} />
        <StatBox label="Labeled" value={compact(summary.labeled)} />
        <StatBox label="Incomplete" value={compact(summary.incomplete)} />
        <StatBox label="Errors" value={compact(summary.errors ?? 0)} />
        <StatBox label="Mean exec" value={net == null ? "…" : pct(net)} />
        <div className="flex flex-col justify-center gap-1 bg-bg px-3 py-2">
          <button type="button" onClick={() => onExport("json")} className="flex h-8 items-center gap-2 text-xs text-muted hover:text-fg">
            <Download className="size-3.5" />
            JSON
          </button>
          <button type="button" onClick={() => onExport("csv")} className="flex h-8 items-center gap-2 text-xs text-muted hover:text-fg">
            <Download className="size-3.5" />
            CSV
          </button>
        </div>
      </div>
      <div className="border-b border-border px-4 py-3 sm:px-5">
        <p className="mb-2 text-xs uppercase tracking-wider text-subtle">Coverage · V1 buckets × regime</p>
        <table className="w-full max-w-xl text-left font-mono text-xs">
          <thead className="text-subtle">
            <tr>
              <th className="py-1 font-medium"> </th>
              {regimes.map((r) => (
                <th key={r} className="py-1 font-medium">
                  {regimeLabel(r)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {researchBuckets.map((b) => (
              <tr key={b} className="border-t border-border">
                <td className="py-1 text-subtle">{bucketLabel(b)}</td>
                {regimes.map((r) => (
                  <td key={r} className="py-1 tabular-nums text-muted">
                    {summary.coverage?.[b]?.[r] ?? 0}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-subtle">
          Worker {worker.status} · {worker.db}
          {worker.db === "offline" ? " · DB down" : ""} · pending labels {worker.pendingLabels}
          {worker.oldestPendingAt ? ` · oldest ${clock(worker.oldestPendingAt)}` : ""}
          {worker.lastError ? ` · ${worker.lastError}` : ""}
        </p>
      </div>
      <div className="border-b border-border px-4 py-3 sm:px-5">
        <p className="mb-2 text-xs uppercase tracking-wider text-subtle">Data quality</p>
        <p className="mb-2 font-mono text-xs text-muted">
          Research {rh.status}
          {rh.blockers.length ? ` · ${rh.blockers[0]}` : ""}
          {rh.blockers.length > 1 ? ` · +${rh.blockers.length - 1} more` : ""}
        </p>
        <p className="mb-2 font-mono text-xs text-subtle">
          epoch {quality.collectionEpoch ?? "—"} · env {quality.environment ?? "preview"} · soak{" "}
          {quality.productionSoakStartedAtMs ? "production" : "preview-not-counted"}
        </p>
        <p className="mb-1 text-[10px] uppercase tracking-wider text-subtle">
          Current epoch · GO gates (not lifetime)
        </p>
        <div className="mb-3 grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-xs sm:grid-cols-3">
          <QualityRow label="epoch tokens" value={compact(quality.epochUniqueTokens ?? 0)} />
          <QualityRow label="epoch A/B" value={`${(quality.epochGradeA ?? 0) + (quality.epochGradeB ?? 0)}`} />
          <QualityRow
            label="epoch HIGH+MED"
            value={
              quality.epochHighConfidencePct == null && quality.epochMediumConfidencePct == null
                ? "—"
                : pct((quality.epochHighConfidencePct ?? 0) + (quality.epochMediumConfidencePct ?? 0), 0)
            }
          />
          <QualityRow
            label="holder @ decision"
            value={quality.holderCoverageAtDecisionPct == null ? "—" : pct(quality.holderCoverageAtDecisionPct, 0)}
          />
          <QualityRow
            label="active miss"
            value={quality.activeDeadlineMissPct == null ? "—" : pct(quality.activeDeadlineMissPct, 0)}
          />
          <QualityRow label="veto holder unk" value={compact(quality.vetoHolderUnknown ?? 0)} />
          <QualityRow label="veto holder conc" value={compact(quality.vetoHolderConcentration ?? 0)} />
          <QualityRow label="veto route" value={compact(quality.vetoRoute ?? 0)} />
          <QualityRow label="veto security" value={compact(quality.vetoSecurity ?? 0)} />
        </div>
        <p className="mb-1 text-[10px] uppercase tracking-wider text-subtle">
          V3.4 PREP · intelligence · training {ML_TRAINING_LOCKED ? "LOCKED" : "OPEN"}
        </p>
        <div className="mb-3 grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-xs sm:grid-cols-3">
          <QualityRow label="target epoch" value={PRODUCTION_EPOCH} />
          <QualityRow label="train switch" value="LOCKED" />
          <QualityRow
            label="certify"
            value={certifyCorpus(quality, {
              uniqueTokens: quality.epochUniqueTokens ?? 0,
              eligibleRows: 0,
            }).status}
          />
          <QualityRow label="eval lab" value="PREP.2 · synthetic" />
          <QualityRow
            label="ops alerts"
            value={String(
              evaluateProductionAlerts({
                workerStatus: worker.status,
                lastTickAtMs: worker.lastTickAt,
                holderAtDecisionPct: quality.holderCoverageAtDecisionPct,
                routeCheckPct: quality.epochRouteCheckCoveragePct ?? quality.routeCheckCoveragePct,
                activeMedianGapMs: quality.activeMedianGapMs,
              }).length,
            )}
          />
        </div>
        <p className="mb-1 text-[10px] uppercase tracking-wider text-subtle">
          Lifetime corpus · keep · do not mix into training
        </p>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-xs sm:grid-cols-3">
          <QualityRow label="tokens observed" value={compact(quality.tokensObserved)} />
          <QualityRow label="raw observations" value={compact(quality.rawObservations)} />
          <QualityRow label="feature vectors" value={compact(quality.featureVectors)} />
          <QualityRow label="path samples" value={compact(quality.pathSamples)} />
          <QualityRow
            label="avg obs interval"
            value={quality.avgObservationIntervalMs == null ? "—" : `${(quality.avgObservationIntervalMs / 1000).toFixed(0)}s`}
          />
          <QualityRow
            label="universe avg gap"
            value={quality.universeAvgGapMs == null ? "—" : `${(quality.universeAvgGapMs / 1000).toFixed(0)}s`}
          />
          <QualityRow
            label="active avg gap"
            value={quality.activeAvgGapMs == null ? "—" : `${(quality.activeAvgGapMs / 1000).toFixed(1)}s`}
          />
          <QualityRow
            label="active p95 gap"
            value={quality.activeP95GapMs == null ? "—" : `${(quality.activeP95GapMs / 1000).toFixed(0)}s`}
          />
          <QualityRow
            label="largest gap"
            value={quality.largestGapMs == null ? "—" : `${(quality.largestGapMs / 1000).toFixed(0)}s`}
          />
          <QualityRow
            label="unknown holder"
            value={quality.unknownHolderPct == null ? "—" : pct(quality.unknownHolderPct, 0)}
          />
          <QualityRow
            label="holder coverage"
            value={quality.holderCoveragePct == null ? "—" : pct(quality.holderCoveragePct, 0)}
          />
          <QualityRow
            label="unknown contract"
            value={quality.unknownContractPct == null ? "—" : pct(quality.unknownContractPct, 0)}
          />
          <QualityRow
            label="jupiter routes"
            value={quality.jupiterRoutePct == null ? "—" : pct(quality.jupiterRoutePct, 0)}
          />
          <QualityRow
            label="labels complete"
            value={quality.labelsCompletedPct == null ? "—" : pct(quality.labelsCompletedPct, 0)}
          />
          <QualityRow label="unique tokens" value={compact(quality.uniqueTokens ?? quality.tokensObserved)} />
          <QualityRow
            label="holder new"
            value={quality.holderCoverageNewLaunchPct == null ? "—" : pct(quality.holderCoverageNewLaunchPct, 0)}
          />
          <QualityRow
            label="holder early"
            value={quality.holderCoverageEarlyPct == null ? "—" : pct(quality.holderCoverageEarlyPct, 0)}
          />
          <QualityRow
            label="holder emerging"
            value={quality.holderCoverageEmergingPct == null ? "—" : pct(quality.holderCoverageEmergingPct, 0)}
          />
          <QualityRow
            label="security"
            value={quality.securityCoveragePct == null ? "—" : pct(quality.securityCoveragePct, 0)}
          />
          <QualityRow
            label="price coverage"
            value={quality.priceCoveragePct == null ? "—" : pct(quality.priceCoveragePct, 0)}
          />
          <QualityRow
            label="HIGH conf"
            value={quality.highConfidencePct == null ? "—" : pct(quality.highConfidencePct, 0)}
          />
          <QualityRow
            label="MED conf"
            value={quality.mediumConfidencePct == null ? "—" : pct(quality.mediumConfidencePct, 0)}
          />
          <QualityRow
            label="LOW conf"
            value={quality.lowConfidencePct == null ? "—" : pct(quality.lowConfidencePct, 0)}
          />
          <QualityRow
            label="UNK conf"
            value={quality.unknownConfidencePct == null ? "—" : pct(quality.unknownConfidencePct, 0)}
          />
          <QualityRow label="grade A/B" value={`${quality.gradeA + quality.gradeB}`} />
          <QualityRow label="grade C" value={`${quality.gradeC}`} />
          <QualityRow label="research-only" value={`${quality.researchOnly}`} />
          <QualityRow
            label="jup routable"
            value={compact(quality.routeCoverage?.routable ?? 0)}
          />
          <QualityRow
            label="jup no-route"
            value={compact(quality.routeCoverage?.noRoute ?? 0)}
          />
          <QualityRow
            label="jup timeout"
            value={compact(quality.routeCoverage?.timeout ?? 0)}
          />
          <QualityRow
            label="not checked"
            value={compact(quality.routeCoverage?.notChecked ?? 0)}
          />
          <QualityRow
            label="p95 path gap"
            value={quality.p95PathGapMs == null ? "—" : `${(quality.p95PathGapMs / 1000).toFixed(0)}s`}
          />
          <QualityRow label="disagreements / h" value={compact(quality.disagreementsHour)} />
          <QualityRow label="provider fails / h" value={compact(quality.providerFailuresHour)} />
        </div>
      </div>
      {replay ? (
        <div className="border-b border-border px-4 py-3 sm:px-5">
          <p className="mb-2 text-xs uppercase tracking-wider text-subtle">Deterministic replay · V3.3B published hypotheses</p>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-xs sm:grid-cols-3">
            <QualityRow label="ready for replay" value={replay.readyForReplay ? "YES" : "NO"} />
            <QualityRow label="ready for ML" value={replay.readyForModeling ? "YES" : "NO"} />
            <QualityRow label="hypotheses" value={String(replay.hypothesisCount ?? 3)} />
            <QualityRow label="seed" value={String(replay.publishedSeed ?? 1337)} />
            <QualityRow label="leakage" value={compact(replay.leakageViolations ?? 0)} />
            <QualityRow label="tape fp" value={(replay.tapeFingerprint ?? "—").slice(0, 10)} />
            <QualityRow
              label="universe 15m"
              value={replay.universe?.median15m == null ? "—" : pct(replay.universe.median15m)}
            />
            {(replay.strategies ?? []).map((s) => (
              <QualityRow
                key={s.id}
                label={`${s.published ? "pub " : s.liveWired ? "live " : "diag "}${s.id.replaceAll("_", " ")}`}
                value={`${s.authorized} auth${
                  s.stats?.expectancy == null ? "" : ` · E ${pct(s.stats.expectancy)}`
                }${s.stats?.meanR == null ? "" : ` · ${s.stats.meanR.toFixed(2)}R`}${
                  s.median15mAuthorizedToken == null
                    ? ""
                    : ` · ${pct(s.median15mAuthorizedToken)}${s.vsUniverseDelta == null ? "" : s.beatsUniverse ? " > uni" : " ≤ uni"}`
                }`}
              />
            ))}
          </div>
        </div>
      ) : null}
      <div className="border-b border-border px-4 py-3 sm:px-5">
        <p className="mb-2 text-xs uppercase tracking-wider text-subtle">Edge score monotonicity · replay diagnostic</p>
        {edge ? (
          <div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-xs sm:grid-cols-3">
              <QualityRow label="verdict" value={edge.verdict.replaceAll("_", " ")} />
              <QualityRow label="labeled pairs" value={compact(edge.n)} />
              <QualityRow label="unique tokens" value={compact(edge.uniqueTokens)} />
              <QualityRow
                label="spearman 15m"
                value={edge.spearman15m == null ? "—" : edge.spearman15m.toFixed(2)}
              />
              <QualityRow
                label="kendall 15m"
                value={edge.kendall15m == null ? "—" : edge.kendall15m.toFixed(2)}
              />
              <QualityRow
                label="spearman exec"
                value={edge.spearmanExec == null ? "—" : edge.spearmanExec.toFixed(2)}
              />
            </div>
            {edge.wasserstein ? (
              <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-xs sm:grid-cols-3">
                <QualityRow
                  label="W1 token 20-40 vs 40-60"
                  value={edge.wasserstein.tokenLowVsMid.w1Body == null ? "—" : edge.wasserstein.tokenLowVsMid.w1Body.toFixed(4)}
                />
                <QualityRow
                  label="W1 permutation p"
                  value={edge.wasserstein.tokenLowVsMid.permutationPBody == null ? "—" : edge.wasserstein.tokenLowVsMid.permutationPBody.toFixed(3)}
                />
                <QualityRow
                  label="W1 / IQR (body)"
                  value={edge.wasserstein.tokenLowVsMid.w1OverIqr == null ? "—" : edge.wasserstein.tokenLowVsMid.w1OverIqr.toFixed(2)}
                />
                <QualityRow
                  label="W1 train vs holdout"
                  value={edge.wasserstein.trainVsHoldout.w1Body == null ? "—" : edge.wasserstein.trainVsHoldout.w1Body.toFixed(4)}
                />
                <QualityRow
                  label="holdout p"
                  value={edge.wasserstein.trainVsHoldout.permutationPBody == null ? "—" : edge.wasserstein.trainVsHoldout.permutationPBody.toFixed(3)}
                />
                <QualityRow
                  label="exec gap |theo-net|"
                  value={edge.wasserstein.executionGapMeanAbs == null ? "—" : pct(edge.wasserstein.executionGapMeanAbs)}
                />
              </div>
            ) : null}
            <div className="mt-2 grid max-w-xl grid-cols-5 gap-2 font-mono text-xs">
              {edge.bucketMedians15m.map((b) => (
                <div key={b.bucket}>
                  <div className="text-subtle">{b.bucket}</div>
                  <div className="tabular-nums text-muted">
                    {b.median == null ? "—" : pct(b.median)} · n {b.n}
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-2 text-xs text-subtle">{edge.note}</p>
            {edge.wasserstein ? <p className="mt-1 text-xs text-subtle">{edge.wasserstein.note}</p> : null}
          </div>
        ) : (
          <p className="text-xs text-subtle">Computing edge ordering from labeled warehouse rows…</p>
        )}
      </div>
      <div className="grid gap-4 border-b border-border px-4 py-3 sm:grid-cols-2 sm:px-5">
        <div>
          <p className="mb-2 text-xs uppercase tracking-wider text-subtle">By bucket</p>
          {buckets.map((b) => {
            const s = summary.byBucket[b];
            const m = meanOf(s.sum5m, s.n5m);
            return (
              <div key={b} className="flex justify-between gap-2 font-mono text-xs">
                <span className="text-subtle">{bucketLabel(b)}</span>
                <span className="tabular-nums text-muted">
                  {s.n} · {s.labeled} labeled{m == null ? "" : ` · 5m ${pct(m)}`}
                </span>
              </div>
            );
          })}
        </div>
        <div>
          <p className="mb-2 text-xs uppercase tracking-wider text-subtle">By regime / strategy</p>
          {regimes.map((r) => {
            const s = summary.byRegime[r];
            const m = meanOf(s.sumNet, s.nNet);
            return (
              <div key={r} className="flex justify-between gap-2 font-mono text-xs">
                <span className="text-subtle">{regimeLabel(r)}</span>
                <span className="tabular-nums text-muted">
                  {s.n} · taken {s.taken}
                  {m == null ? "" : ` · exec ${pct(m)}`}
                </span>
              </div>
            );
          })}
          {Object.entries(summary.byStrategy ?? {}).map(([id, s]) => (
            <div key={id} className="flex justify-between gap-2 font-mono text-xs">
              <span className="text-subtle">{id.replaceAll("_", " ")}</span>
              <span className="tabular-nums text-muted">
                {s.n} · {s.labeled} labeled
              </span>
            </div>
          ))}
        </div>
      </div>
      {!rows.length ? (
        <p className="px-5 py-6 text-sm text-muted">
          The worker writes every consideration to the warehouse, including vetoes. Closing this page does not stop
          collection. Outcomes fill in at 1m / 5m / 15m / 30m / 1h.
        </p>
      ) : (
        <div className="max-h-52 overflow-auto">
          <table className="w-full min-w-[720px] text-left font-mono text-xs">
            <thead className="sticky top-0 bg-bg text-subtle">
              <tr>
                {["time", "token", "bucket", "gov", "taken", "5m", "+10/-10", "exec"].map((h) => (
                  <th key={h} className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {slice.map((r) => (
                <tr key={r.decision_id} className="border-t border-border">
                  <td className="px-3 py-2 text-subtle tabular-nums">{clock(r.decision_time)}</td>
                  <td className="px-3 py-2">{r.token}</td>
                  <td className="px-3 py-2 text-muted">{bucketLabel(r.bucket)}</td>
                  <td className={cn("px-3 py-2", r.governor_result === "authorized" ? "text-up" : "text-down")}>
                    {r.governor_result === "authorized" ? "AUTH" : "VETO"}
                  </td>
                  <td className="px-3 py-2 text-muted">{r.trade_taken ? "yes" : "no"}</td>
                  <td className="px-3 py-2 tabular-nums text-muted">
                    {r.price_after_5m && r.price ? pct(r.price_after_5m / r.price - 1) : "…"}
                  </td>
                  <td className="px-3 py-2 text-muted">
                    {r.hit_plus_10_before_minus_10 == null ? "…" : r.hit_plus_10_before_minus_10 ? "yes" : "no"}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-muted">
                    {r.net_execution_return == null ? "…" : pct(r.net_execution_return)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-bg px-3 py-2">
      <div className="text-xs uppercase tracking-wider text-subtle">{label}</div>
      <div className="font-mono text-sm tabular-nums">{value}</div>
    </div>
  );
}

function QualityRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-subtle">{label}</span>
      <span className="tabular-nums text-muted">{value}</span>
    </div>
  );
}
