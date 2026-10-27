import { useState } from "react";
import { FlaskConical, TriangleAlert } from "lucide-react";
import { phantomSol, type PhantomResearchPaper } from "@/lib/desk/phantom";

const short = (value: string) => `${value.slice(0, 8)}…${value.slice(-6)}`;
const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour12: false });
const statusText = {
  WAITING_ENROLLMENT: "Waiting for enrollment",
  ACTIVE: "Collecting paper decisions",
  ENTRY_STOPPED: "Entries stopped",
  SUSPENDED: "Suspended",
  ENROLLMENT_CLOSED: "Enrollment closed",
};

export function ExperimentalPaperBook({
  book,
  availability,
  fresh,
  now,
  onSelect,
}: {
  book: PhantomResearchPaper | null | undefined;
  availability: "absent" | "invalid" | "available" | undefined;
  fresh: boolean;
  now: number;
  onSelect: (mint: string) => void;
}) {
  const [tab, setTab] = useState("positions");
  const a = book?.account,
    m = book?.manifest;
  const marksFresh =
    !!book &&
    fresh &&
    book.positions.every(
      (p) =>
        p.markLamports !== null &&
        p.markAt !== null &&
        p.markAt <= now &&
        now - p.markAt <= book.manifest.policy.maximumQuoteAgeMs,
    );
  const equity = marksFresh ? a?.equityLamports : null;
  const empty = (message: string) => <p className="omni-launch-note">{message}</p>;
  return (
    <section
      className="omni-launch-health"
      aria-label="Experimental paper SOL book"
      style={{ marginBottom: 22 }}
    >
      <div className="omni-launch-card-heading">
        <h2>
          <FlaskConical size={13} style={{ verticalAlign: "middle", marginRight: 7 }} />
          EXPERIMENTAL PAPER · separate SOL book
        </h2>
        <span>
          {book
            ? `${fresh ? "" : "Last snapshot · "}${a?.suspended ? "Suspended" : statusText[book.status]}`
            : availability === "invalid"
              ? "INCOMPATIBLE DATA"
              : "NOT ENABLED"}
        </span>
      </div>
      <div className="omni-live-warning" style={{ margin: 12 }} role="note">
        <TriangleAlert size={15} style={{ flexShrink: 0 }} />
        <span>
          UNKNOWN ASSOCIATIONS accepted for this experiment. A token position can lose 100%. Strict
          policy eligible: false. Live approved: false.
        </span>
      </div>
      {!book ? (
        empty(
          availability === "invalid"
            ? "Experimental account data is incompatible or inconsistent. Balances and results are unavailable."
            : "No experimental paper account is reported by this worker. No balances or results are inferred.",
        )
      ) : (
        <>
          <p>
            This experimental SOL book is separate from the strict-policy SOL book and the manual
            USDC account.
            {!fresh
              ? " Showing a paused, stale or disconnected snapshot; fresh equity is unavailable."
              : " Values below are from the latest worker snapshot."}
          </p>
          <div className="omni-live-kpis" style={{ marginBottom: 0 }}>
            <Metric label="Paper cash" value={phantomSol(a!.cashLamports)} unit="SOL" />
            <Metric
              label="Reserved for entries"
              value={phantomSol(a!.reservedLamports)}
              unit="SOL"
            />
            <Metric
              label="Available paper cash"
              value={phantomSol(a!.availableCashLamports)}
              unit="SOL"
            />
            <Metric
              label="Fresh liquidation equity"
              value={phantomSol(equity)}
              unit="SOL"
              note={
                equity === null
                  ? "Unknown · fresh marks required"
                  : "Quote minimums less modeled exit fees"
              }
            />
            <Metric
              label="Reported realized modeled P&L"
              value={phantomSol(a!.realizedPnlLamports)}
              unit="SOL"
              negative={a!.realizedPnlLamports.startsWith("-")}
              note="Includes realized partial exit legs"
            />
            <Metric
              label="Modeled settled network fees"
              value={phantomSol(a!.modeledSettledFeesLamports)}
              unit="SOL"
              note="Fixed model · not measured fees"
            />
            <Metric
              label="Open / pending entries"
              value={`${a!.openPositions} / ${a!.pendingEntries}`}
              note={`${a!.pendingExits} pending exits`}
            />
            <Metric
              label="Completed positions"
              value={String(book.completedPositions.length)}
              note={`${book.trades.length} recent realized exit legs`}
            />
          </div>
          <div className="omni-launch-tabs" role="group" aria-label="Experimental book views">
            {[
              ["positions", "Positions"],
              ["orders", "Pending intents"],
              ["realized", "Realized exit legs"],
              ["journal", "Journal"],
            ].map(([value, label]) => (
              <button
                key={value}
                className={tab === value ? "active" : ""}
                onClick={() => setTab(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <div style={{ maxHeight: 280, overflow: "auto" }}>
            {tab === "positions" &&
              (book.positions.length ? (
                <div className="omni-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Token / strategy</th>
                        <th>Entry cost</th>
                        <th>Quantity (raw)</th>
                        <th>Fresh mark</th>
                      </tr>
                    </thead>
                    <tbody>
                      {book.positions.map((p) => {
                        const mark =
                          fresh &&
                          p.markAt !== null &&
                          p.markAt <= now &&
                          now - p.markAt <= m!.policy.maximumQuoteAgeMs
                            ? p.markLamports
                            : null;
                        return (
                          <tr key={p.id}>
                            <td>
                              <button onClick={() => onSelect(p.mint)}>{short(p.mint)}</button>
                              <small style={{ display: "block" }}>{p.strategy}</small>
                            </td>
                            <td>{phantomSol(p.costLamports)} SOL</td>
                            <td title={p.quantityRaw}>{p.quantityRaw}</td>
                            <td>
                              {phantomSol(mark)} SOL
                              {mark === null && <small style={{ display: "block" }}>Unknown</small>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                empty("No open experimental paper positions are reported.")
              ))}
            {tab === "orders" &&
              (book.pending.length || book.pendingExits.length ? (
                <div className="omni-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Intent</th>
                        <th>Token</th>
                        <th>Amount / quantity</th>
                        <th>Ready time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {book.pending.map((p) => (
                        <tr key={p.id}>
                          <td>Paper entry</td>
                          <td>
                            <button onClick={() => onSelect(p.mint)}>{short(p.mint)}</button>
                          </td>
                          <td>{phantomSol(p.amountLamports)} SOL</td>
                          <td>{clock(p.readyAt)}</td>
                        </tr>
                      ))}
                      {book.pendingExits.map((p) => (
                        <tr key={p.id}>
                          <td>
                            Paper exit<small style={{ display: "block" }}>{p.reason}</small>
                          </td>
                          <td>
                            <button onClick={() => onSelect(p.mint)}>{short(p.mint)}</button>
                          </td>
                          <td>{p.quantityRaw} raw tokens</td>
                          <td>{clock(p.readyAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                empty("No pending experimental entry or exit intents are reported.")
              ))}
            {tab === "realized" &&
              (book.trades.length ? (
                <div className="omni-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Token / exit reason</th>
                        <th>Modeled net P&L</th>
                        <th>Allocated fees</th>
                        <th>Exit</th>
                      </tr>
                    </thead>
                    <tbody>
                      {book.trades
                        .slice(-100)
                        .reverse()
                        .map((t) => (
                          <tr key={t.id}>
                            <td>
                              <button onClick={() => onSelect(t.mint)}>{short(t.mint)}</button>
                              <small style={{ display: "block" }}>{t.reason}</small>
                            </td>
                            <td className={t.pnlLamports.startsWith("-") ? "negative" : "positive"}>
                              {phantomSol(t.pnlLamports)} SOL
                            </td>
                            <td>{phantomSol(t.feesLamports)} SOL</td>
                            <td>
                              {t.isFinalExit ? "Final exit" : "Partial exit"}
                              <small style={{ display: "block" }}>{clock(t.closedAt)}</small>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                empty(
                  "No realized experimental exit legs are reported. A quote is not a realized paper result.",
                )
              ))}
            {tab === "journal" &&
              (book.journal.length ? (
                <div className="omni-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Sequence / time</th>
                        <th>Recorded event</th>
                        <th>Paper reference</th>
                      </tr>
                    </thead>
                    <tbody>
                      {book.journal
                        .slice()
                        .reverse()
                        .map((j) => (
                          <tr key={j.sequence}>
                            <td>
                              {j.sequence} · {clock(j.at)}
                            </td>
                            <td>{j.kind.replaceAll("_", " ")}</td>
                            <td title={j.entryId}>{short(j.entryId)}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                empty("No experimental bookkeeping events are reported.")
              ))}
          </div>
          <p>
            Quote minimums model settlement; attainable fills are unproven. The fixed fee model
            includes priority fees, excludes token-account rent, and charges no on-chain failure fee
            because no transaction is submitted.
          </p>
          <details>
            <summary>Frozen run identity and model limits</summary>
            <dl>
              <div>
                <dt>Book</dt>
                <dd>{a!.bookId}</dd>
              </div>
              <div>
                <dt>Policy</dt>
                <dd>
                  {m!.policy.kind} · {m!.policy.strategy}
                </dd>
              </div>
              <div>
                <dt>Enrollment</dt>
                <dd>
                  {new Date(m!.enrollmentStart).toLocaleString()} →{" "}
                  {new Date(m!.enrollmentEnd).toLocaleString()}
                </dd>
              </div>
              <div>
                <dt>Initial modeled capital</dt>
                <dd>{phantomSol(m!.policy.initialCapitalLamports)} SOL</dd>
              </div>
              <div>
                <dt>Fee per settled leg</dt>
                <dd>{phantomSol(m!.policy.networkFeePerLegLamports)} SOL</dd>
              </div>
              <div>
                <dt>Slippage / cost budget</dt>
                <dd>
                  {m!.policy.slippageBps} / {m!.policy.maximumExecutionCostBps} bps
                </dd>
              </div>
              <div>
                <dt>Source hash</dt>
                <dd style={{ overflowWrap: "anywhere", minWidth: 0, textAlign: "right" }}>
                  {a!.sourceHash}
                </dd>
              </div>
              <div>
                <dt>Policy hash</dt>
                <dd style={{ overflowWrap: "anywhere", minWidth: 0, textAlign: "right" }}>
                  {a!.policyHash}
                </dd>
              </div>
              <div>
                <dt>Run hash</dt>
                <dd style={{ overflowWrap: "anywhere", minWidth: 0, textAlign: "right" }}>
                  {a!.runHash}
                </dd>
              </div>
              <div>
                <dt>Ledger version</dt>
                <dd>{a!.ledgerVersion}</dd>
              </div>
            </dl>
            <p style={{ margin: "0 0 12px" }}>
              Hashes are reported identifiers, not independent source or policy authentication.
              Journal and exit-leg tables are bounded recent samples.
            </p>
            <ul style={{ paddingLeft: 16 }}>
              {book.limitations.map((value, i) => (
                <li key={i}>{value}</li>
              ))}
            </ul>
          </details>
        </>
      )}
    </section>
  );
}

function Metric({
  label,
  value,
  unit,
  note,
  negative,
}: {
  label: string;
  value: string;
  unit?: string;
  note?: string;
  negative?: boolean;
}) {
  return (
    <div>
      <span>{label}</span>
      <strong className={negative ? "negative" : ""}>
        {value}
        {unit && <small> {unit}</small>}
      </strong>
      {note && <p>{note}</p>}
    </div>
  );
}
