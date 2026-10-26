import { useEffect, useState } from "react";
import type { SniperState } from "@/lib/desk/sniper";
import { sniperMetrics } from "@/lib/desk/sniper";
import { usd } from "@/lib/desk/format";

type Report = {
  name: string;
  state: SniperState;
  metrics: ReturnType<typeof sniperMetrics>;
  initialized: boolean;
  discovery: string;
  fillEvidence: string;
};
export function SniperPanel() {
  const [reports, setReports] = useState<Report[]>([]),
    [selected, setSelected] = useState("paper-sniper-v1"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    let loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try {
        const r = await fetch("/api/sniper?view=experiments", { signal: controller.signal });
        if (!r.ok) throw Error(`Sniper API ${r.status}`);
        const data = await r.json();
        if (active) {
          setReports(data);
          setError("");
        }
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : "Unable to load sniper");
      } finally {
        loading = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 10000);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, []);
  const report =
    reports.find((r) => (r.state.experimentId ?? "paper-sniper-v1") === selected) ?? null;
  async function toggle() {
    if (!report) return;
    setBusy(true);
    try {
      const r = await fetch("/api/sniper", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !reports.some((r) => r.state.enabled), scope: "all" }),
      });
      if (!r.ok) throw Error(`Control failed ${r.status}`);
      const next = await fetch("/api/sniper?view=experiments");
      if (!next.ok) throw Error("Refresh failed");
      setReports(await next.json());
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Control failed");
    } finally {
      setBusy(false);
    }
  }
  const s = report?.state,
    m = report?.metrics;
  const recent = s?.trades.slice(-10).reverse() ?? [];
  const reasons = new Map<string, number>();
  for (const c of s?.candidates ?? [])
    for (const reason of c.reasons) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  return (
    <section
      className="border-b border-border px-4 py-4 sm:px-6"
      aria-label="Paper sniper experiment"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">
            Paper strategy lab{" "}
            <span className="ml-2 text-xs text-muted">PAPER ONLY · UNPROVEN</span>
          </h2>
          <p className="mt-1 text-xs text-muted">
            New-pool selection with delayed, exact-size quote simulation. Public API polling does
            not establish first-block execution.
          </p>
        </div>
        <div className="flex gap-3">
          <a
            className="text-xs underline"
            href="/api/sniper?view=experiments"
            target="_blank"
            rel="noreferrer"
          >
            View full evidence
          </a>
          <button
            className="rounded border border-border px-3 py-1 text-xs"
            disabled={!report || busy}
            onClick={() => void toggle()}
          >
            {busy
              ? "Saving…"
              : reports.some((r) => r.state.enabled)
                ? "Pause all entries"
                : "Resume all entries"}
          </button>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Select paper experiment">
        {reports.map((r) => (
          <button
            key={r.state.experimentId ?? "paper-sniper-v1"}
            type="button"
            aria-pressed={(r.state.experimentId ?? "paper-sniper-v1") === selected}
            onClick={() => setSelected(r.state.experimentId ?? "paper-sniper-v1")}
            className="rounded border border-border px-3 py-2 text-xs"
          >
            {r.name} · {usd(r.metrics.netUsd, 2)} · {r.metrics.closed} closed
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-down">
          {error}
        </p>
      )}
      {m && s && (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-6">
            {[
              ["Paper equity", usd(m.equityUsd, 2)],
              ["Net after modeled costs", usd(m.netUsd, 2)],
              ["Closed trades", String(m.closed)],
              ["Open / pending", `${m.open} / ${m.pending}`],
              ["Unresolved exits", String(m.blockedExits)],
              ["Recent candidates", String(s.candidates.length)],
            ].map(([label, value]) => (
              <div key={label}>
                <p className="text-[10px] text-muted">{label}</p>
                <p className="mt-1 font-mono text-sm">{value}</p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted">
            {report.initialized
              ? `Last experiment tick: ${new Date(s.updatedAt).toLocaleString()}`
              : "Waiting for the research worker. Start Collect-Meridian to collect data."}{" "}
            · {s.enabled ? "Entries enabled" : "Entries paused; exits continue while worker runs"} ·
            $25 per entry · 3 positions maximum
          </p>
          <details className="mt-3">
            <summary className="cursor-pointer text-xs">
              Execution assumptions and recent decisions
            </summary>
            <p className="mt-2 text-xs text-muted">
              2-second minimum execution delay; 1% adverse slippage; 0.25% modeled fee plus $0.02
              network cost on each side. Quote output already includes route price impact. These are
              assumptions, not measured live execution costs. Missing or stale exit quotes value the
              position at zero without closing it. No wallet is connected.
            </p>
            <p className="mt-2 text-xs text-muted">Evidence gaps: {m.blockers.join(" · ")}</p>
            {recent.length > 0 ? (
              <div className="mt-3 overflow-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr>
                      <th className="p-2">Token</th>
                      <th>Status</th>
                      <th>Entry cost</th>
                      <th>Net P&amp;L</th>
                      <th>Exit / issue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.map((t) => (
                      <tr key={t.id} className="border-t border-border">
                        <td className="p-2" title={t.mint}>
                          {t.symbol}
                        </td>
                        <td>{t.status}</td>
                        <td>{t.costUsd == null ? "—" : usd(t.costUsd, 2)}</td>
                        <td>{t.pnlUsd == null ? "Unrealized" : usd(t.pnlUsd, 2)}</td>
                        <td>{t.error ?? t.exitReason ?? "Waiting"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="mt-2 text-xs">
                No trades yet. Missing evidence never becomes an automatic buy.
              </p>
            )}
            <ul className="mt-2 text-xs text-muted">
              {[...reasons.entries()]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 6)
                .map(([reason, count]) => (
                  <li key={reason}>
                    {reason}: {count} candidates
                  </li>
                ))}
            </ul>
          </details>
        </>
      )}
    </section>
  );
}
