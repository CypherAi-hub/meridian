import { useEffect, useState } from "react";
import { ArrowUpRight, Radio, TriangleAlert } from "lucide-react";
import type { PoolActivity } from "@/lib/desk/pool-activity";
export function OnchainFeed({ pair }: { pair: string }) {
  const [data, setData] = useState<PoolActivity | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true,
      busy = false;
    const controller = new AbortController();
    setData(null);
    setError("");
    setLoading(true);
    const pull = async () => {
      if (busy) return;
      busy = true;
      try {
        if (!pair) throw Error("Select a token with an indexed market pool.");
        const r = await fetch("/api/terminal?view=chain&pair=" + encodeURIComponent(pair), {
          signal: controller.signal,
          cache: "no-store",
        });
        const b = await r.json();
        if (!r.ok) throw Error(b.error ?? "Chain feed unavailable");
        if (alive) {
          setData(b);
          setError("");
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "Chain feed unavailable");
      } finally {
        busy = false;
        if (alive) setLoading(false);
      }
    };
    void pull();
    const timer = setInterval(() => void pull(), 30000);
    return () => {
      alive = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [pair]);
  return (
    <>
      <div className="omni-chain-explainer">
        <span>
          <Radio size={12} />
          SOLANA MAINNET · READ ONLY
        </span>
        <p>
          Real transaction signatures referencing the selected pool. These are public pool
          transactions; the paper bot has no on-chain orders. Swaps and trade direction are not
          decoded here.
        </p>
      </div>
      {error && (
        <p className="omni-chain-error" role="alert">
          <TriangleAlert size={12} />
          {error}
          {data ? " Showing the last successful sample." : ""}
        </p>
      )}
      <div className="omni-feed-events omni-chain-events">
        {data?.transactions.map((t) => (
          <article key={t.signature} className="omni-chain-row">
            <div>
              <span className={"omni-chain-result " + t.status}>
                {t.status === "succeeded"
                  ? "SUCCESS"
                  : t.status === "failed"
                    ? "FAILED"
                    : "UNKNOWN"}
              </span>
              <time>
                {t.blockTime
                  ? new Date(t.blockTime * 1000).toLocaleTimeString(undefined, { hour12: false })
                  : "Time unknown"}
              </time>
            </div>
            <a
              href={`https://solscan.io/tx/${t.signature}`}
              target="_blank"
              rel="noreferrer"
              title={t.signature}
            >
              {t.signature.slice(0, 16)}…{t.signature.slice(-8)}
              <ArrowUpRight size={12} />
            </a>
            <p>
              Slot {t.slot.toLocaleString()}
              <span>{t.confirmation}</span>
            </p>
            {t.error && <small>{t.error}</small>}
          </article>
        ))}
        {!data?.transactions.length && (
          <div className="omni-feed-empty">
            <Radio size={24} />
            <strong>
              {loading
                ? "Reading mainnet pool activity"
                : error
                  ? "Transaction data unavailable"
                  : "No transactions in this sample"}
            </strong>
            <p>Waiting for the public Solana RPC to return confirmed pool activity.</p>
          </div>
        )}
      </div>
      <div className="omni-feed-footer">
        <span>
          {data ? "Sample " + new Date(data.fetchedAt).toLocaleTimeString() : "Awaiting RPC data"}
        </span>
        <span>30s polling · recent sample · gaps possible</span>
      </div>
    </>
  );
}
