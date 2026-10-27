import { completedSummary } from "./analytics";
import type { EngineState } from "./state";
const short = (s: string) => `${s.slice(0, 7)}…${s.slice(-7)}`;
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour12: false });
function sol(raw: string | null) {
  if (raw == null) return "—";
  const v = BigInt(raw),
    abs = v < 0n ? -v : v;
  return `${v < 0n ? "−" : ""}${abs / 1_000_000_000n}.${(abs % 1_000_000_000n).toString().padStart(9, "0").slice(0, 5)}`;
}
export default function Portfolio({
  state,
  panel,
  setPanel,
}: {
  state: EngineState | null;
  panel: string;
  setPanel: (panel: string) => void;
}) {
  const strategies = [
    ...new Set([
      ...(state?.decisions ?? []).map((d) => d.strategy),
      ...(state?.completedPositions ?? []).map((p) => p.strategy),
    ]),
  ];
  return (
    <section className="card portfolio" id="portfolio">
      <div className="card-heading">
        <div>
          <span className="section-index">05</span>
          <h2>Paper portfolio</h2>
        </div>
        <span className="card-caption">Simulated inventory · no real funds</span>
      </div>
      <div className="filters">
        {["positions", "completed", "legs", "strategies"].map((value) => (
          <button
            className={panel === value ? "selected" : ""}
            key={value}
            onClick={() => setPanel(value)}
          >
            {value === "positions"
              ? `Active positions${state ? ` · ${state.positions.length}` : ""}`
              : value === "completed"
                ? `Completed positions${state?.completedPositions ? ` · ${state.completedPositions.length}` : ""}`
                : value === "legs"
                  ? `Realized exit legs${state ? ` · ${state.trades.length} recent` : ""}`
                  : "Strategy performance"}
          </button>
        ))}
      </div>
      <div className="table-wrap">
        {panel === "positions" ? (
          state?.positions.length ? (
            <table>
              <thead>
                <tr>
                  <th>TOKEN / STRATEGY</th>
                  <th>RAW INVENTORY</th>
                  <th>ENTRY COST</th>
                  <th>SELL QUOTE VALUE</th>
                  <th>OPENED</th>
                </tr>
              </thead>
              <tbody>
                {state.positions.map((p) => (
                  <tr key={p.id}>
                    <td className="mono">
                      {short(p.mint)}
                      <small>{p.strategy}</small>
                    </td>
                    <td className="mono">{p.quantityRaw}</td>
                    <td>{sol(p.costLamports)} SOL</td>
                    <td>{sol(p.markLamports)} SOL</td>
                    <td>{clock(p.openedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="inline-empty">
              {state ? "No active paper positions." : "Position state unavailable."}
            </div>
          )
        ) : panel === "completed" ? (
          state?.completedPositions?.length ? (
            <table>
              <thead>
                <tr>
                  <th>TOKEN / STRATEGY</th>
                  <th>POSITION NET</th>
                  <th>TOTAL FEES</th>
                  <th>EXIT LEGS</th>
                  <th>FINAL EXIT</th>
                </tr>
              </thead>
              <tbody>
                {state.completedPositions.map((p) => (
                  <tr key={p.positionId}>
                    <td className="mono">
                      {short(p.mint)}
                      <small>
                        {p.strategy} · {short(p.positionId)}
                      </small>
                    </td>
                    <td className={BigInt(p.pnlLamports) < 0n ? "negative" : "positive"}>
                      {sol(p.pnlLamports)} SOL
                    </td>
                    <td>{sol(p.feesLamports)} SOL</td>
                    <td>{p.exitLegs}</td>
                    <td>
                      {clock(p.closedAt)}
                      <small>{p.finalReason}</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="inline-empty">
              {state?.completedPositions
                ? "No fully closed, attributable positions. Partial exit legs are not completed wins."
                : "Completed-position attribution unavailable; exit legs are never substituted as positions."}
            </div>
          )
        ) : panel === "legs" ? (
          state?.trades.length ? (
            <table>
              <thead>
                <tr>
                  <th>TOKEN / STRATEGY</th>
                  <th>LEG NET REALIZED</th>
                  <th>LEG FEES</th>
                  <th>CLOSURE EVIDENCE</th>
                  <th>EXIT REASON / TIME</th>
                </tr>
              </thead>
              <tbody>
                {state.trades.map((t) => (
                  <tr key={t.id}>
                    <td className="mono">
                      {short(t.mint)}
                      <small>{t.strategy}</small>
                    </td>
                    <td className={BigInt(t.pnlLamports) < 0n ? "negative" : "positive"}>
                      {sol(t.pnlLamports)} SOL
                    </td>
                    <td>{sol(t.feesLamports)} SOL</td>
                    <td>
                      {t.isFinalExit === true
                        ? "Final exit"
                        : t.isFinalExit === false
                          ? "Partial exit"
                          : "Legacy closure unknown"}
                      <small>
                        {t.positionId ? short(t.positionId) : "Position identity unknown"}
                      </small>
                    </td>
                    <td>
                      {t.reason}
                      <small>{clock(t.closedAt)}</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="inline-empty">
              {state ? "No realized paper exit legs." : "Realized exit-leg history unavailable."}
            </div>
          )
        ) : strategies.length ? (
          <table>
            <thead>
              <tr>
                <th>STRATEGY</th>
                <th>DECISIONS / APPROVED</th>
                <th>COMPLETED POSITIONS</th>
                <th>POSITION WIN RATE</th>
                <th>CLOSED-POSITION NET</th>
              </tr>
            </thead>
            <tbody>
              {strategies.map((strategy) => {
                const decisions = state!.decisions.filter((d) => d.strategy === strategy),
                  summary = completedSummary(
                    state?.completedPositions?.filter((p) => p.strategy === strategy),
                  );
                return (
                  <tr key={strategy}>
                    <td>{strategy}</td>
                    <td>
                      {decisions.length} / {decisions.filter((d) => d.accepted).length}
                    </td>
                    <td>{summary.count ?? "—"}</td>
                    <td>
                      {summary.winRate == null ? "—" : `${(summary.winRate * 100).toFixed(1)}%`}
                    </td>
                    <td
                      className={
                        summary.netLamports != null && BigInt(summary.netLamports) < 0n
                          ? "negative"
                          : "positive"
                      }
                    >
                      {sol(summary.netLamports)} SOL
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="inline-empty">No strategy observations yet.</div>
        )}
      </div>
      <footer className="card-footer">
        <span>
          Completed positions aggregate every attributable leg from the engine's full ledger.
        </span>
        <span>Partial realizations and legacy unknowns are separate from win rate.</span>
      </footer>
    </section>
  );
}
