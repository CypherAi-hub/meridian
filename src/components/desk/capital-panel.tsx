import { useEffect, useState } from "react";
import type { CapitalPolicy } from "@/lib/desk/capital";
type Report = {
  configured: boolean;
  policy: CapitalPolicy | null;
  checks: {
    checkedAt: number;
    recipientExists: boolean;
    recipientSystemAccount: boolean;
    mintSupported: boolean;
    routeAvailable: boolean;
    mintDecimals: number | null;
    error?: string;
  } | null;
  readiness: { state: string; blockers: string[] };
  previews: Array<{ name: string; amountUsdcAtomic: string; status: string }>;
};
export function CapitalPanel() {
  const [report, setReport] = useState<Report | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function load() {
    const r = await fetch("/api/capital");
    if (!r.ok) throw Error(`Capital settings ${r.status}`);
    setReport(await r.json());
  }
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    let loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try {
        const r = await fetch("/api/capital", { signal: controller.signal });
        if (!r.ok) throw Error(`Capital settings ${r.status}`);
        const data = await r.json();
        if (active) {
          setReport(data);
          setError("");
        }
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : "Unable to load capital settings");
      } finally {
        loading = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 30000);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, []);
  async function check() {
    setBusy(true);
    try {
      const r = await fetch("/api/capital", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "check-addresses" }),
      });
      if (!r.ok) throw Error(`Address check ${r.status}`);
      await load();
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Address check failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="border-b border-border px-4 py-4 sm:px-6"
      aria-label="Future funding and profit destination"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">
            Future funding &amp; profit destination{" "}
            <span className="ml-2 text-xs text-muted">PAPER ACTIVE · LIVE LOCKED</span>
          </h2>
          <p className="mt-1 text-xs text-muted">
            Future plan: convert realized net profit into your chosen token and send it to your
            recipient wallet. Trading principal and operating reserves stay protected.
          </p>
        </div>
        <button
          type="button"
          className="rounded border border-border px-3 py-2 text-xs"
          disabled={!report?.configured || busy}
          onClick={() => void check()}
        >
          {busy ? "Checking public data…" : "Check public addresses"}
        </button>
      </div>
      {error && (
        <p className="mt-2 text-xs text-down" role="alert">
          {error}
        </p>
      )}
      {report?.policy ? (
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <div>
            <p className="text-[10px] text-muted">Earnings recipient · Solana mainnet</p>
            <p className="mt-1 break-all font-mono text-xs">{report.policy.recipient}</p>
          </div>
          <div>
            <p className="text-[10px] text-muted">
              Profit token · {report.policy.profitLabel} (user-provided label)
            </p>
            <p className="mt-1 break-all font-mono text-xs">{report.policy.profitMint}</p>
          </div>
        </div>
      ) : (
        <p className="mt-3 text-xs text-muted">
          Payout preferences are not configured. Import your capital-plan.json with
          Configure-Payout.cmd.
        </p>
      )}
      <p className="mt-3 text-xs text-muted">
        Deposit address: unavailable. A dedicated trading wallet has not been linked. The earnings
        recipient above is not a bot deposit address. Paper earnings cannot be withdrawn.
      </p>
      {report?.checks && (
        <p className="mt-2 text-xs text-muted">
          Last public check: {new Date(report.checks.checkedAt).toLocaleString()} · recipient{" "}
          {report.checks.recipientSystemAccount ? "exists" : "unverified"} · mint{" "}
          {report.checks.mintSupported ? "supported legacy mint" : "unverified or unsupported"} ·
          indicative conversion route {report.checks.routeAvailable ? "available" : "unavailable"}.
          Public checks do not prove wallet ownership or guarantee a transfer.
        </p>
      )}
      <details className="mt-3">
        <summary className="cursor-pointer text-xs">
          Funded-mode requirements and paper payout previews
        </summary>
        <ul className="mt-2 space-y-1 text-xs text-muted">
          {report?.readiness.blockers.map((item) => (
            <li key={item}>• {item}</li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted">
          Passing paper metrics cannot automatically activate a signer or real trading. Token
          delivery will require the recipient’s correct associated token account and sufficient SOL
          for fees.
        </p>
        <div className="mt-2 space-y-1 text-xs">
          {report?.previews.map((p) => (
            <p key={p.name}>
              {p.name}: ${(Number(p.amountUsdcAtomic) / 1e6).toFixed(2)} simulated net profit
              available for a conversion preview. No conversion or payout occurs.
            </p>
          ))}
        </div>
      </details>
    </section>
  );
}
