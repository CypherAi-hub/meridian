import { useEffect, useState } from "react";
import type { trainingReadiness } from "@/lib/desk/training-readiness";

export function TrainingReadinessPanel() {
  const [report, setReport] = useState<ReturnType<typeof trainingReadiness> | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let alive = true;
    const refresh = () => fetch("/api/research?view=training-readiness", { cache: "no-store" })
      .then(r => { if (!r.ok) throw new Error("audit unavailable"); return r.json(); })
      .then(value => { if (alive) { setReport(value); setError(false); } })
      .catch(() => { if (alive) setError(true); });
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 60_000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  return <section className="border-b border-border px-4 py-3 sm:px-5" aria-label="Training readiness">
    <h3 className="text-sm font-medium">Training locked · paper research</h3>
    {error ? <p className="mt-2 text-xs text-muted">Readiness audit unavailable. Training remains locked; retrying automatically.</p>
      : !report ? <p className="mt-2 text-xs text-muted">Checking the full collection epoch…</p>
      : <>
        <p className="mt-2 text-xs text-muted">{report.audit.completed} completed labels · {report.audit.qualifiedTokens} tokens with qualified v2 paths · {report.soakHours.toFixed(1)}h production soak</p>
        <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-muted">
          {report.blockers.map(reason => <li key={reason}>{reason}</li>)}
        </ul>
        <p className="mt-2 text-xs text-muted">{report.nextStep}</p>
        <p className="mt-2 text-xs text-muted">Quality counts use stored label grades. Dataset certification must independently verify complete price paths and feature provenance.</p>
      </>}
  </section>;
}
