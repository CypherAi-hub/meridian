import { researchSummary, horizonSummary } from "./analytics";
import type { ResearchState } from "./state";
const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-6)}`;
export default function ResearchPanel({
  state,
  error,
}: {
  state: ResearchState | null;
  error: string | null;
}) {
  const stats = researchSummary(state?.observations),
    recent = state?.observations.filter((o) => o.phase !== "HORIZON").slice(0, 12) ?? [],
    horizons = horizonSummary(state?.observations);
  return (
    <section className="card quote-research" id="quote-research">
      <div className="card-heading">
        <div>
          <span className="section-index">06</span>
          <h2>Observed execution cost</h2>
        </div>
        <span className="paper-small">QUOTE RESEARCH / NO TRADES</span>
      </div>
      <div className="research-intro">
        <p>
          Two sequential exact-size quotes, including configured minimum outputs and modeled network
          fees. These samples measure quoted round-trip cost, not profit or future returns.
        </p>
        {error && (
          <div className="research-error">
            {error}
            {state && " Showing previously fetched samples."}
          </div>
        )}
      </div>
      <div className="research-kpis">
        <div>
          <label>Baseline samples shown</label>
          <strong>{stats.samples ?? "—"}</strong>
        </div>
        <div>
          <label>Baseline round trips quoted</label>
          <strong>{stats.quoted ?? "—"}</strong>
        </div>
        <div>
          <label>Unavailable baselines</label>
          <strong>{stats.unavailable ?? "—"}</strong>
        </div>
        <div>
          <label>Median round-trip cost</label>
          <strong>
            {stats.medianCostBps == null ? "—" : `${stats.medianCostBps.toFixed(1)} bps`}
          </strong>
        </div>
      </div>
      <div className="table-wrap">
        {recent.length ? (
          <table>
            <thead>
              <tr>
                <th>TOKEN / SOURCE TX</th>
                <th>SAMPLE STATUS</th>
                <th>ROUND-TRIP COST</th>
                <th>LATENCY</th>
                <th>OBSERVED</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((o) => (
                <tr key={o.id}>
                  <td className="mono">
                    {short(o.mint)}
                    <small>
                      {/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(o.signature) ? (
                        <a
                          href={`https://solscan.io/tx/${encodeURIComponent(o.signature)}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {short(o.signature)} ↗
                        </a>
                      ) : (
                        "Signature unavailable"
                      )}
                    </small>
                  </td>
                  <td>
                    {o.status === "QUOTED" ? "Quote pair observed" : "Quote unavailable"}
                    <small>
                      {o.error ?? `${o.slippageBpsPerLeg} bps slippage per leg · fees modeled`}
                    </small>
                  </td>
                  <td className="mono">
                    {o.status === "QUOTED" && o.conservativeRoundTripCostBps != null
                      ? `${o.conservativeRoundTripCostBps.toFixed(1)} bps`
                      : "Unknown"}
                  </td>
                  <td className="mono">{o.latencyMs.toFixed(0)} ms</td>
                  <td className="mono">
                    {new Date(o.completedAt).toLocaleTimeString([], { hour12: false })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="inline-empty">
            {state
              ? "No stored quote samples yet. Research collection runs only in the engine."
              : "Quote research state unavailable."}
          </div>
        )}
      </div>
      <div className="research-intro">
        <h3>Hypothetical quote horizons</h3>
        <p>
          Fresh exit quotes for the original hypothetical baseline token quantity at 30, 60, and 180
          second targets. Collection can be delayed; missing and expired quotes stay unavailable.
          These observations are separate from realized position P&amp;L. Profitability remains
          unproven.
        </p>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>HORIZON TARGET</th>
              <th>RECORDED ATTEMPTS</th>
              <th>QUOTED / UNAVAILABLE</th>
              <th>MEDIAN HYPOTHETICAL QUOTE OUTCOME</th>
              <th>MAXIMUM OBSERVATION DELAY</th>
            </tr>
          </thead>
          <tbody>
            {horizons.map((h) => (
              <tr key={h.horizonMs}>
                <td>{h.horizonMs / 1000}s</td>
                <td>{h.samples ?? "—"}</td>
                <td>
                  {h.quoted ?? "—"} / {h.unavailable ?? "—"}
                </td>
                <td>
                  {h.medianHypotheticalReturnBps == null
                    ? "Unknown"
                    : `${h.medianHypotheticalReturnBps.toFixed(1)} bps · not realized`}
                </td>
                <td>
                  {h.maximumDelayMs == null
                    ? "Unknown"
                    : `${(h.maximumDelayMs / 1000).toFixed(1)}s past target`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <footer className="card-footer">
        <span>
          At most 10,000 persisted observations. Baseline cost medians exclude horizon outcomes.
          Negative quote cost is not realized profit.
        </span>
        <span>Dashboard refresh does not request provider quotes.</span>
      </footer>
    </section>
  );
}
