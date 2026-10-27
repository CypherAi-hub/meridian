import { useEffect, useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Clock3,
  ExternalLink,
  Pause,
  Play,
  Radio,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
  Waves,
} from "lucide-react";
import {
  phantomSol,
  type PhantomEvent,
  type PhantomReport,
  type PhantomState,
} from "@/lib/desk/phantom";
import { WSOL } from "@/lib/desk/schema";
import type { TerminalToken } from "@/lib/desk/terminal-market";
import { MarketChart } from "./market-chart";
import { ExperimentalPaperBook } from "./experimental-paper-book";

const short = (v: string) => v.slice(0, 6) + "…" + v.slice(-5);
const age = (at: number | null | undefined, now: number) =>
  at == null
    ? "unavailable"
    : now - at < 2000
      ? "just now"
      : now - at < 60000
        ? `${Math.max(0, Math.floor((now - at) / 1000))}s ago`
        : `${Math.floor((now - at) / 60000)}m ago`;
const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour12: false });
const count = (n: number | undefined | null) => (n == null ? "—" : n.toLocaleString());
const kind: Record<PhantomEvent["kind"], string> = {
  launch: "Token launched",
  pool: "Pool created",
  buy: "On-chain buy",
  sell: "On-chain sell",
  migrate: "Pool migration",
  swap: "On-chain swap",
};

export function usePhantomReport() {
  const [report, setReport] = useState<PhantomReport | null>(null),
    [snapshot, setSnapshot] = useState<PhantomState | null>(null),
    [error, setError] = useState(""),
    [receivedAt, setReceivedAt] = useState<number | null>(null),
    [now, setNow] = useState(Date.now()),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true,
      busy = false;
    const controller = new AbortController();
    const pull = async () => {
      if (busy) return;
      busy = true;
      try {
        const r = await fetch("/api/sniper?view=phantom", {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!r.ok) throw Error("Monitoring connection interrupted");
        const data = (await r.json()) as PhantomReport;
        if (active) {
          setReport(data);
          if (data.state) {
            setSnapshot(data.state);
            setReceivedAt(Date.now());
          }
          setError("");
        }
      } catch {
        if (active) setError("Monitoring connection interrupted");
      } finally {
        busy = false;
      }
    };
    void pull();
    const timer = setInterval(() => void pull(), 3000),
      clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
      clearInterval(clock);
    };
  }, [revision]);
  return { report, snapshot, error, receivedAt, now, refresh: () => setRevision((n) => n + 1) };
}
export type PhantomFeed = ReturnType<typeof usePhantomReport>;
export function LaunchEngine({
  feed,
  selected,
  token,
  tokenError,
  onSelect,
  onTerminal,
}: {
  feed: PhantomFeed;
  selected: string;
  token: TerminalToken | null;
  tokenError: string;
  onSelect: (mint: string) => void;
  onTerminal: () => void;
}) {
  const [tab, setTab] = useState("chain"),
    [eventFilter, setEventFilter] = useState("all"),
    [strategy, setStrategy] = useState("all"),
    [fullOnly, setFullOnly] = useState(false),
    [frozen, setFrozen] = useState<PhantomState | null>(null);
  const { report, snapshot: state, error, receivedAt, now } = feed,
    display = frozen ?? state;
  const connected =
    report?.connection === "connected" && !error && !!receivedAt && now - receivedAt < 12000;
  const status = connected ? report.status : "offline";
  const fresh = connected && status !== "stale";
  const health = state?.health;
  const events = (display?.events ?? []).filter(
    (e) =>
      (eventFilter === "all" || e.kind === eventFilter) &&
      (!fullOnly || e.verification === "FULL_TRANSACTION"),
  );
  const decisions = (display?.decisions ?? []).filter(
    (d) => strategy === "all" || d.strategy === strategy,
  );
  const strategies = [...new Set(display?.decisions.map((d) => d.strategy) ?? [])];
  const timeNow = state && receivedAt ? state.sampledAt + now - receivedAt : now;
  const statusLabel =
    status === "live"
      ? "Observing Solana"
      : status === "degraded"
        ? "Connected · degraded"
        : status === "stale"
          ? "Observation data stale"
          : status === "waiting"
            ? "Waiting for observations"
            : "Engine disconnected";
  return (
    <main className="omni-live omni-launch" aria-label="Solana launch engine">
      <div className="omni-live-heading">
        <div>
          <div className="omni-live-eyebrow">
            <span className={status === "live" ? "status-dot" : "status-dot warn"} />
            SOLANA LAUNCH ENGINE · PAPER
          </div>
          <h1>
            Watch the chain<span>.</span>
          </h1>
          <p>
            Observed chain activity, recorded signals, and distinct strict-policy and experimental
            paper books.
          </p>
        </div>
        <div className="omni-live-heading-right">
          <span className={"omni-live-status " + (status === "live" ? "running" : "waiting")}>
            <Radio size={13} />
            {statusLabel}
          </span>
          <button onClick={feed.refresh} aria-label="Refresh launch engine">
            <RefreshCw size={12} />
            Refresh feed
          </button>
          <small>Last observation {age(state?.lastObservationAt, timeNow)}</small>
        </div>
      </div>
      <div className="omni-live-kpis">
        <div>
          <span>Typed chain observations</span>
          <strong>{count(health?.typedObserved)}</strong>
          <p>{count(health?.decoded)} full transactions decoded</p>
        </div>
        <div>
          <span>Verification backlog</span>
          <strong>
            {count(health?.queueDepth)}
            <small> queued</small>
          </strong>
          <p>{count(health?.backfillGaps)} reported coverage gaps</p>
        </div>
        <div>
          <span>Strict-policy paper positions</span>
          <strong>
            {count(state?.positionCount)}
            <small> open · {count(state?.pendingCount)} queued</small>
          </strong>
          <p>Strict-policy SOL book · simulated inventory</p>
        </div>
        <div>
          <span>Completed position net</span>
          <strong
            className={
              state?.completedNetLamports == null
                ? ""
                : state.completedNetLamports.startsWith("-")
                  ? "negative"
                  : "positive"
            }
          >
            {phantomSol(state?.completedNetLamports)}
            <small> SOL</small>
          </strong>
          <p>{count(state?.completedCount)} reported completed positions · unproven</p>
        </div>
      </div>
      {(!fresh || status !== "live") && (
        <div className="omni-live-warning" role="status">
          <TriangleAlert size={14} />
          <span>
            {error || report?.message || "Connecting to the local paper engine."}
            {state && !connected ? " Showing the last received snapshot." : ""}
          </span>
        </div>
      )}
      <ExperimentalPaperBook
        book={display?.researchPaper}
        availability={display?.researchPaperStatus}
        fresh={fresh && !frozen}
        now={state && receivedAt ? state.now + Math.max(0, now - receivedAt) : now}
        onSelect={onSelect}
      />
      <div className="omni-live-layout">
        <section className="omni-bot-feed omni-launch-feed" aria-label="Launch engine activity">
          <div className="omni-feed-heading">
            <div>
              <Waves size={15} />
              <h2>Launch radar</h2>
              <span className={"omni-feed-live " + (status === "live" && !frozen ? "" : "muted")}>
                <i />
                {frozen
                  ? "VIEW PAUSED"
                  : fresh
                    ? "READ ONLY"
                    : state
                      ? "LAST SNAPSHOT"
                      : "NOT CONNECTED"}
              </span>
            </div>
            <button
              aria-label={frozen ? "Resume launch feed" : "Pause launch feed"}
              disabled={!state}
              onClick={() => setFrozen(frozen ? null : state)}
            >
              {frozen ? <Play size={13} /> : <Pause size={13} />}
            </button>
          </div>
          <div className="omni-launch-tabs" role="group" aria-label="Launch engine views">
            {[
              ["chain", "Chain activity"],
              ["decisions", "Decisions"],
              ["positions", "Paper positions"],
              ["closed", "Closed positions"],
            ].map(([v, label]) => (
              <button key={v} className={tab === v ? "active" : ""} onClick={() => setTab(v)}>
                {label}
              </button>
            ))}
          </div>
          {frozen && (
            <p className="omni-feed-paused">
              Display paused. The paper worker keeps collecting and managing positions.
            </p>
          )}
          {tab === "chain" && (
            <>
              <div className="omni-feed-filters">
                <div>
                  {[
                    ["all", "All"],
                    ["launch", "Launches"],
                    ["buy", "Buys"],
                    ["sell", "Sells"],
                    ["pool", "Pools"],
                  ].map(([v, label]) => (
                    <button
                      key={v}
                      className={eventFilter === v ? "active" : ""}
                      onClick={() => setEventFilter(v)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <label className="omni-full-only">
                  <input
                    type="checkbox"
                    checked={fullOnly}
                    onChange={(e) => setFullOnly(e.target.checked)}
                  />
                  Fully verified only
                </label>
              </div>
              <p className="omni-launch-note">
                External-wallet activity. A typed observation is awaiting full verification and
                cannot authorize a paper fill.
              </p>
              <div
                className="omni-feed-events"
                role="log"
                aria-label="Observed Solana launch events"
                aria-live="off"
              >
                {events.map((e) => (
                  <article key={e.id} className={"omni-feed-event " + e.kind}>
                    <div className="omni-event-marker">
                      {e.kind === "buy" ? (
                        <ArrowDownLeft size={14} />
                      ) : e.kind === "sell" ? (
                        <ArrowUpRight size={14} />
                      ) : (
                        <Radio size={14} />
                      )}
                    </div>
                    <div className="omni-event-body">
                      <div className="omni-event-title">
                        <strong>{kind[e.kind]}</strong>
                        <time title={`Local receipt ${new Date(e.receivedAt).toISOString()}`}>
                          {clock(e.receivedAt)}
                        </time>
                      </div>
                      <div className="omni-event-identity">
                        <button title={e.mint} onClick={() => onSelect(e.mint)}>
                          {short(e.mint)}
                          <ArrowUpRight size={10} />
                        </button>
                        <span>
                          {e.protocol.toUpperCase()} · {e.commitment}
                        </span>
                      </div>
                      <span
                        className={
                          "omni-verification " +
                          (e.verification === "FULL_TRANSACTION" ? "verified" : "pending")
                        }
                      >
                        {e.verification === "FULL_TRANSACTION"
                          ? "Full transaction verified"
                          : e.verification === "TYPED_PROGRAM_EVENT"
                            ? "Typed event · verification pending"
                            : "Verification unknown"}
                      </span>
                      <p>
                        {e.quoteAmountRaw == null
                          ? "Quote quantity unavailable"
                          : e.quoteMint === WSOL
                            ? `${phantomSol(e.quoteAmountRaw)} SOL observed`
                            : `${e.quoteAmountRaw} raw quote units${e.quoteMint ? " · " + short(e.quoteMint) : " · mint unknown"}`}
                      </p>
                      <div className="omni-launch-event-meta">
                        <span>Slot {e.slot.toLocaleString()}</span>
                        <a
                          href={`https://solscan.io/tx/${e.signature}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Transaction
                          <ExternalLink size={10} />
                        </a>
                      </div>
                      <details>
                        <summary>Observed quantities</summary>
                        <p>
                          Token raw amount: {e.amountRaw ?? "unknown"}
                          <br />
                          Quote raw amount: {e.quoteAmountRaw ?? "unknown"}
                          <br />
                          Quote mint: {e.quoteMint ?? "unknown"}
                          <br />
                          Quantity evidence: {e.quantityEvidence ?? "unknown"}
                          <br />
                          These are on-chain observations, not this bot’s fills.
                        </p>
                      </details>
                    </div>
                  </article>
                ))}
                {!events.length && (
                  <Empty
                    title={connected ? "No events in this view" : "Waiting for the launch engine"}
                    detail={
                      connected
                        ? "This is a recent sample. Adjust the filters to inspect other observed activity."
                        : "The local engine must be running on the same computer as Omni."
                    }
                  />
                )}
              </div>
            </>
          )}
          {tab === "decisions" && (
            <>
              <div className="omni-feed-filters">
                <span>Observed strategy evaluations</span>
                <select
                  aria-label="Filter launch decisions by strategy"
                  value={strategy}
                  onChange={(e) => setStrategy(e.target.value)}
                >
                  <option value="all">All strategies</option>
                  {strategies.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
              <div className="omni-feed-events" aria-label="Launch strategy decisions">
                {decisions.map((d, i) => (
                  <article
                    key={`${d.at}:${d.mint}:${d.strategy}:${i}`}
                    className={"omni-feed-event " + (d.accepted ? "eligible" : "skip")}
                  >
                    <div className="omni-event-marker">
                      <ShieldCheck size={14} />
                    </div>
                    <div className="omni-event-body">
                      <div className="omni-event-title">
                        <strong>
                          {d.accepted ? "Signal accepted for evaluation" : "Entry skipped"}
                        </strong>
                        <time>{clock(d.at)}</time>
                      </div>
                      <div className="omni-event-identity">
                        <button onClick={() => onSelect(d.mint)} title={d.mint}>
                          {short(d.mint)}
                        </button>
                        <span>{d.strategy}</span>
                      </div>
                      <p>
                        {d.reasons.length
                          ? d.reasons.join(" · ")
                          : "Evaluation passed. A signal is not a paper fill."}
                      </p>
                      {d.organicDemandScore != null && (
                        <p>
                          Observed organic-demand score {d.organicDemandScore}. This is not a
                          probability of profit.
                        </p>
                      )}
                      {!!d.walletEvidence?.length && (
                        <details>
                          <summary>Wallet evidence</summary>
                          <ul>
                            {d.walletEvidence.map((v, i) => (
                              <li key={i}>{v}</li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </div>
                  </article>
                ))}
                {!decisions.length && (
                  <Empty
                    title="Waiting for recorded decisions"
                    detail="The engine records a decision only when the required observed inputs are available."
                  />
                )}
              </div>
            </>
          )}
          {tab === "positions" && (
            <div className="omni-launch-ledger">
              <p className="omni-launch-note">
                Launch-engine paper account · {count(display?.positionCount)} positions ·{" "}
                {count(display?.pendingCount)} pending. Amounts are SOL; this account is separate
                from the manual USDC account.
              </p>
              {display?.positions.length ? (
                <div className="omni-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Token / strategy</th>
                        <th>Entry cost</th>
                        <th>Reported mark</th>
                      </tr>
                    </thead>
                    <tbody>
                      {display.positions.map((p) => (
                        <tr key={p.id}>
                          <td>
                            <button onClick={() => onSelect(p.mint)}>{short(p.mint)}</button>
                            <small>{p.strategy}</small>
                          </td>
                          <td>{phantomSol(p.costLamports)} SOL</td>
                          <td>{phantomSol(p.markLamports)} SOL</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty
                  title={
                    display?.positionCount === 0
                      ? "No open paper positions"
                      : "Position details unavailable"
                  }
                  detail="Missing or unsupported checks keep entries blocked. No fill is invented to populate this view."
                />
              )}
            </div>
          )}
          {tab === "closed" && (
            <div className="omni-launch-ledger">
              <p className="omni-launch-note">
                Completed positions group their partial exits. These are simulated results, never
                external-wallet trades or quote-research returns.
              </p>
              {display?.completed.length ? (
                <div className="omni-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Token / strategy</th>
                        <th>Net result</th>
                        <th>Exit legs</th>
                      </tr>
                    </thead>
                    <tbody>
                      {display.completed
                        .slice(-100)
                        .reverse()
                        .map((p) => (
                          <tr key={p.positionId}>
                            <td>
                              <button onClick={() => onSelect(p.mint)}>{short(p.mint)}</button>
                              <small>
                                {p.strategy} · {p.finalReason}
                              </small>
                            </td>
                            <td className={p.pnlLamports.startsWith("-") ? "negative" : "positive"}>
                              {phantomSol(p.pnlLamports)} SOL
                            </td>
                            <td>{p.exitLegs}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty
                  title={
                    display?.completedCount === 0
                      ? "No completed paper positions"
                      : "Completed-position evidence unavailable"
                  }
                  detail="A paper position must close and reconcile before it contributes to completed results."
                />
              )}
            </div>
          )}
          <div className="omni-feed-footer">
            <span>
              <i className={fresh ? "status-dot" : "status-dot warn"} />
              Updated {age(receivedAt, now)}
            </span>
            <span>Recent sample · 3s refresh</span>
          </div>
        </section>
        <div className="omni-live-market">
          <section className="omni-bot-market-window" aria-label="Launch market chart">
            <div className="omni-bot-market-heading">
              <div>
                {token?.imageUrl && <img src={token.imageUrl} alt="" />}
                <div>
                  <span>MARKET WINDOW</span>
                  <h2>
                    {token?.symbol ?? short(selected)}
                    <small> / USD</small>
                  </h2>
                </div>
              </div>
              <button className="omni-launch-terminal" onClick={onTerminal}>
                Open terminal
                <ArrowUpRight size={12} />
              </button>
            </div>
            <div className="omni-bot-contract">
              <span>Select an observed token to inspect its indexed market.</span>
              <a href={`https://solscan.io/token/${selected}`} target="_blank" rel="noreferrer">
                {short(selected)}
                <ExternalLink size={10} />
              </a>
            </div>
            <MarketChart
              pair={token?.pair ?? ""}
              symbol={token?.symbol ?? short(selected)}
              mint={selected}
              pending={!token && !tokenError}
            />
            {tokenError && <p className="omni-data-note">{tokenError}</p>}
          </section>
          <section className="omni-launch-health">
            <div className="omni-launch-card-heading">
              <h2>Pipeline health</h2>
              <span>{health?.source ?? "unavailable"}</span>
            </div>
            <dl>
              <div>
                <dt>Typed-event processing p95</dt>
                <dd>
                  {health?.typedLogs?.latencyMs.p95 == null
                    ? "—"
                    : health.typedLogs.latencyMs.p95 + " ms"}
                </dd>
              </div>
              <div>
                <dt>Full verification p95</dt>
                <dd>
                  {health?.latencyMs.p95 == null
                    ? "—"
                    : (health.latencyMs.p95 / 1000).toFixed(1) + " s"}
                </dd>
              </div>
              <div>
                <dt>Typed events dropped</dt>
                <dd>{count(health?.typedLogs?.dropped)}</dd>
              </div>
              <div>
                <dt>Provider / decode errors</dt>
                <dd>{count(health?.errors)}</dd>
              </div>
            </dl>
            <p>
              Processing timers start at local receipt. They exclude chain finality and do not prove
              first-block execution.
            </p>
            {health?.lastError && (
              <details>
                <summary>Latest source issue</summary>
                <p>
                  {health.lastError === "RPC_PROVIDER_USAGE_EXHAUSTED"
                    ? "The data provider has reached its usage allowance. Restore provider access and restart the worker after review. New observations are unavailable; existing books and history are retained."
                    : health.lastError}
                </p>
              </details>
            )}
          </section>
          <section className="omni-launch-health">
            <div className="omni-launch-card-heading">
              <h2>Strict-policy SOL paper book</h2>
              <ShieldCheck size={13} />
            </div>
            <dl>
              <div>
                <dt>Paper cash</dt>
                <dd>{phantomSol(state?.cashLamports)} SOL</dd>
              </div>
              <div>
                <dt>Fresh reported equity</dt>
                <dd>{phantomSol(state?.equityLamports)} SOL</dd>
              </div>
            </dl>
            <p>
              Unknown or stale equity stays unavailable. Real funds and wallet signing remain
              disabled.
            </p>
          </section>
        </div>
      </div>
      <div className="omni-launch-limitations">
        <details>
          <summary>Source coverage and evidence</summary>
          <ul>
            <li>Recent event samples are incomplete views of the stream.</li>
            <li>
              Typed observations await full transaction verification. Chain activity is separate
              from simulated fills.
            </li>
            {!!state?.discardedRows && (
              <li>
                {state.discardedRows} unsupported or malformed rows were omitted; portfolio totals
                may be unavailable.
              </li>
            )}
            {state?.limitations.map((v, i) => (
              <li key={i}>{v}</li>
            ))}
          </ul>
        </details>
        {connected && (
          <a href="http://127.0.0.1:8791" target="_blank" rel="noreferrer">
            Open detailed engine monitor
            <ExternalLink size={11} />
          </a>
        )}
      </div>
      <div className="omni-bot-bottom">
        <span>
          <Clock3 size={11} />
          Watching the feed does not place an order.
        </span>
        <span>Rule-based paper research · profitability unproven</span>
      </div>
    </main>
  );
}
function Empty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="omni-feed-empty">
      <Radio size={24} />
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}
