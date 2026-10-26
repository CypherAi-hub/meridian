"use client";
import { useEffect, useMemo, useState } from "react";
import type { EngineState, ChainEvent, ResearchState } from "./state";
import { completedSummary, verificationLabel } from "./analytics";
import Portfolio from "./portfolio";
import ResearchPanel from "./research-panel";
const short = (text: string | null | undefined, n = 5) =>
  text ? `${text.slice(0, n)}…${text.slice(-n)}` : "Unavailable";
const clock = (value: number | null | undefined) =>
  value == null ? "—" : new Date(value).toLocaleTimeString([], { hour12: false });
function sol(raw: string | null | undefined) {
  if (raw == null || !/^-?\d+$/.test(raw)) return "—";
  const value = BigInt(raw),
    sign = value < 0n ? "−" : "",
    abs = value < 0n ? -value : value;
  return `${sign}${abs / 1_000_000_000n}.${(abs % 1_000_000_000n).toString().padStart(9, "0").slice(0, 5)}`;
}
const since = (at: number | null | undefined, now: number) =>
  at == null ? "No events yet" : `${Math.max(0, Math.floor((now - at) / 1000))}s ago`;
function Signature({ event }: { event: ChainEvent }) {
  const verified = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(event.signature);
  return verified ? (
    <a
      title={event.signature}
      target="_blank"
      rel="noreferrer"
      href={`https://solscan.io/tx/${encodeURIComponent(event.signature)}`}
    >
      {short(event.signature, 7)} ↗
    </a>
  ) : (
    <span title="No valid on-chain signature">{short(event.signature, 7)}</span>
  );
}
function Equity({ points }: { points: EngineState["equity"] }) {
  const rows = points
    .filter((p): p is { at: number; equityLamports: string } => p.equityLamports !== null)
    .map((p) => ({ ...p, value: BigInt(p.equityLamports) }));
  if (rows.length < 2)
    return (
      <div className="chart-empty">
        <span>∿</span>
        <strong>Waiting for an equity history</strong>
        <p>Unknown inventory marks remain gaps, never zero values.</p>
      </div>
    );
  const min = rows.reduce((m, p) => (p.value < m ? p.value : m), rows[0].value),
    max = rows.reduce((m, p) => (p.value > m ? p.value : m), rows[0].value),
    range = max - min || 1n;
  const start = points[0].at,
    end = points.at(-1)!.at,
    period = Math.max(1, end - start);
  const segments: string[][] = [[]];
  for (const p of points) {
    if (p.equityLamports === null) {
      if (segments.at(-1)!.length) segments.push([]);
      continue;
    }
    segments
      .at(-1)!
      .push(
        `${20 + ((p.at - start) / period) * 760},${174 - Number(((BigInt(p.equityLamports) - min) * 150_000n) / range) / 1000}`,
      );
  }
  return (
    <div className="equity-plot">
      <svg
        viewBox="0 0 800 210"
        role="img"
        aria-label="Observed paper equity curve with gaps for unknown inventory marks"
      >
        {[24, 74, 124, 174].map((y) => (
          <line key={y} x1="20" x2="780" y1={y} y2={y} stroke="#223047" strokeDasharray="3 6" />
        ))}
        {segments
          .filter((s) => s.length > 0)
          .map((s, i) => (
            <polyline
              key={i}
              points={s.join(" ")}
              fill="none"
              stroke="#53e6ae"
              strokeWidth="2"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        <text x="20" y="203">
          {clock(start)}
        </text>
        <text x="780" y="203" textAnchor="end">
          {clock(end)}
        </text>
      </svg>
      <div className="range-labels">
        <span>{sol(max.toString())} SOL</span>
        <span>{sol(min.toString())} SOL</span>
      </div>
    </div>
  );
}
export default function Monitor() {
  const [research, setResearch] = useState<ResearchState | null>(null),
    [researchError, setResearchError] = useState<string | null>(null);
  const [state, setState] = useState<EngineState | null>(null),
    [error, setError] = useState<string | null>(null),
    [lastFetch, setLastFetch] = useState<number | null>(null),
    [now, setNow] = useState(Date.now()),
    [paused, setPaused] = useState(false),
    [kind, setKind] = useState("all"),
    [panel, setPanel] = useState("positions");
  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    const tick = setInterval(() => setNow(Date.now()), 1000);
    let inflight = false,
      researchInflight = false;
    async function loadResearch() {
      if (researchInflight) return;
      researchInflight = true;
      try {
        const response = await fetch("/api/research", {
          cache: "no-store",
          signal: controller.signal,
        });
        const data = await response.json();
        if (!response.ok) throw Error(data.error ?? "Stored research unavailable");
        if (alive) {
          setResearch(data);
          setResearchError(null);
        }
      } catch (e) {
        if (alive && !controller.signal.aborted)
          setResearchError(e instanceof Error ? e.message : "Research state request failed");
      } finally {
        researchInflight = false;
      }
    }
    async function load() {
      if (inflight || paused) return;
      inflight = true;
      void loadResearch();
      try {
        const response = await fetch("/api/state", {
          cache: "no-store",
          signal: controller.signal,
        });
        const data = await response.json();
        if (!response.ok) throw Error(data.error ?? "Engine unavailable");
        if (alive) {
          setState(data);
          setError(null);
          setLastFetch(Date.now());
        }
      } catch (e) {
        if (alive && !controller.signal.aborted)
          setError(e instanceof Error ? e.message : "State request failed");
      } finally {
        inflight = false;
      }
    }
    void load();
    const polling = setInterval(() => void load(), 2000);
    return () => {
      alive = false;
      controller.abort();
      clearInterval(polling);
      clearInterval(tick);
    };
  }, [paused]);
  const recent = useMemo(
    () =>
      [...(state?.events ?? [])]
        .filter(
          (e) =>
            kind === "all" ||
            (kind === "launch" ? /launch|create|pool/.test(e.kind) : e.kind === kind),
        )
        .sort((a, b) => b.receivedAt - a.receivedAt)
        .slice(0, 100),
    [state, kind],
  );
  const decisions = [...(state?.decisions ?? [])].sort((a, b) => b.at - a.at).slice(0, 35);
  const summary = completedSummary(state?.completedPositions),
    pnl = summary.netLamports == null ? null : BigInt(summary.netLamports);
  const equity = state?.equity?.at(-1)?.equityLamports ?? null;
  let peak = 0n,
    drawdown = 0n;
  for (const p of state?.equity ?? []) {
    if (p.equityLamports === null) continue;
    const v = BigInt(p.equityLamports);
    if (v > peak) peak = v;
    if (peak - v > drawdown) drawdown = peak - v;
  }
  const fresh = lastFetch != null && now - lastFetch < 8000 && !error && !paused;
  return (
    <main>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">P</span>PHANTOM<span className="version">/ 01</span>
        </div>
        <nav>
          <a href="#transactions" className="nav-active">
            Live transactions
          </a>
          <a href="#decisions">Decisions</a>
          <a href="#portfolio">Paper book</a>
        </nav>
        <div className="mode-tag">
          <i /> PAPER EXECUTION
        </div>
      </header>
      <div className="connection">
        <span className={fresh ? "live-dot" : "waiting-dot"} />
        <strong>
          {error
            ? "ENGINE UNAVAILABLE"
            : paused
              ? "DISPLAY PAUSED"
              : fresh
                ? "STATE CONNECTED"
                : "CONNECTING"}
        </strong>
        <span className="connection-source">
          {state?.health.source ?? "Awaiting source configuration"}
        </span>
        {state && (
          <span
            className={
              ["LIVE", "RUNNING", "CONNECTED"].includes(state.health.status.toUpperCase())
                ? "worker-status healthy"
                : "worker-status degraded"
            }
          >
            WORKER {state.health.status} · {state.health.backfillGaps ?? "—"} BACKFILL GAPS
          </span>
        )}
        <span className="connection-right">
          {lastFetch ? `Updated ${clock(lastFetch)}` : "No engine state received"} · Local observer
        </span>
      </div>
      <section className="page-heading">
        <div>
          <div className="eyebrow">SOLANA / REAL CHAIN DATA</div>
          <h1>
            On-chain activity.
            <br />
            <span>Every decision, explained.</span>
          </h1>
          <p>
            Watch verified on-chain activity alongside a separate, cost-aware paper trading engine.
          </p>
        </div>
        <div className="heading-actions">
          <span className="read-only">◈ Read-only monitor</span>
          <button onClick={() => setPaused(!paused)}>
            {paused ? "▶ Resume display" : "Ⅱ Pause display"}
          </button>
          <small>The worker continues when this display is paused.</small>
        </div>
      </section>
      {error && (
        <div className="warning">
          <strong>Connection interrupted.</strong> {error}{" "}
          {state && "Showing the last successful state; displayed values are stale."}
        </div>
      )}
      <section className="metrics">
        <article>
          <label>FULL-TX EVENTS DECODED</label>
          <strong>{state?.health.decoded?.toLocaleString() ?? "—"}</strong>
          <p>
            {state
              ? `${state.health.received.toLocaleString()} transaction notifications received`
              : "Waiting for verified input"}
          </p>
        </article>
        <article>
          <label>PAPER EQUITY</label>
          <strong>
            {sol(equity)}
            <small> SOL</small>
          </strong>
          <p>
            {state ? `${sol(state.cashLamports)} SOL simulated cash` : "No account state received"}
          </p>
        </article>
        <article>
          <label>CLOSED-POSITION NET / PAPER</label>
          <strong className={pnl != null && pnl < 0n ? "negative" : "positive"}>
            {sol(summary.netLamports)}
            <small> SOL</small>
          </strong>
          <p>
            {summary.count == null
              ? "Completed-position state unavailable"
              : `${summary.count} completed positions · ${summary.winRate == null ? "—" : (summary.winRate * 100).toFixed(1) + "%"} win rate`}
          </p>
        </article>
        <article>
          <label>TYPED FEED LATENCY / P95</label>
          <strong>
            {state?.health.typedLogs?.latencyMs.p95 == null
              ? "—"
              : state.health.typedLogs.latencyMs.p95.toFixed(1)}
            <small> ms</small>
          </strong>
          <p>
            {state?.health.lastEventAt
              ? `Last event ${since(state.health.lastEventAt, now)}`
              : "No transaction observed yet"}
          </p>
        </article>
      </section>
      <div className="main-grid">
        <section className="card transaction-card" id="transactions">
          <div className="card-heading">
            <div>
              <span className="section-index">01</span>
              <h2>On-chain transactions</h2>
              <span className={fresh ? "stream-badge" : "stream-badge muted"}>
                {paused ? "PAUSED" : fresh ? "OBSERVING" : "WAITING"}
              </span>
            </div>
            <span className="card-caption">Actual signatures · external wallets</span>
          </div>
          <div className="filters">
            {["all", "launch", "buy", "sell"].map((value) => (
              <button
                key={value}
                className={kind === value ? "selected" : ""}
                onClick={() => setKind(value)}
              >
                {value === "all"
                  ? "All activity"
                  : value === "launch"
                    ? "Launches"
                    : value === "buy"
                      ? "Buys"
                      : "Sells"}
              </button>
            ))}
            <span>{recent.length} shown</span>
          </div>
          <div className="event-scroll">
            {recent.length ? (
              <table>
                <thead>
                  <tr>
                    <th>EVENT / TOKEN</th>
                    <th>SOURCE</th>
                    <th>SLOT / FINALITY</th>
                    <th>TRANSACTION</th>
                    <th>RECEIVED</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((event) => (
                    <tr key={event.id}>
                      <td>
                        <span className={`event-kind ${event.kind}`}>
                          {event.kind.replaceAll("_", " ")}
                        </span>
                        <strong className="mono token" title={event.mint}>
                          {short(event.mint, 6)}
                        </strong>
                        <small title={event.actor}>Actor {short(event.actor)}</small>
                        <span
                          className={
                            event.verification === "TYPED_PROGRAM_EVENT" &&
                            event.fullTransactionVerified !== true
                              ? "verification-badge pending"
                              : "verification-badge"
                          }
                          title={event.eventSchema ?? event.instructionSchema}
                        >
                          {verificationLabel(event)}
                        </span>
                      </td>
                      <td className="mono">{event.protocol}</td>
                      <td className="mono">
                        {event.slot.toLocaleString()}
                        <small>{event.commitment}</small>
                      </td>
                      <td className="mono">
                        <Signature event={event} />
                      </td>
                      <td className="mono">
                        {clock(event.receivedAt)}
                        <small>
                          {Math.max(0, event.processedAt - event.receivedAt).toFixed(1)} ms
                          processing
                        </small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="empty">
                <span>⌁</span>
                <h3>No decoded transactions yet</h3>
                <p>
                  This feed waits for actual Solana signatures and protocol instructions. It never
                  substitutes scans or paper orders.
                </p>
              </div>
            )}
          </div>
          <footer className="card-footer">
            <span>↗ Signatures open the actual transaction on Solscan.</span>
            <span>Typed events await full verification before any paper entry.</span>
          </footer>
        </section>
        <section className="card decisions-card" id="decisions">
          <div className="card-heading">
            <div>
              <span className="section-index">02</span>
              <h2>Bot decisions</h2>
            </div>
            <span className="paper-small">PAPER</span>
          </div>
          <div className="decisions">
            {decisions.length ? (
              decisions.map((d, i) => (
                <article key={`${d.at}:${d.mint}:${d.strategy}:${i}`} className="decision">
                  <div className={d.accepted ? "decision-icon accepted" : "decision-icon"}>
                    {d.accepted ? "↗" : "−"}
                  </div>
                  <div>
                    <div className="decision-title">
                      <strong>{d.accepted ? "Entry approved" : "Entry rejected"}</strong>
                      <time>{clock(d.at)}</time>
                    </div>
                    <span className="decision-token mono">
                      {short(d.mint, 7)} <small>{d.strategy}</small>
                    </span>
                    <p>{d.reasons.join(" · ") || "No explanation supplied by the engine."}</p>
                    {d.score != null && <small>Opportunity score {d.score.toFixed(2)}</small>}
                    {d.organicDemandScore != null && (
                      <small>Cluster-adjusted demand {d.organicDemandScore.toFixed(2)}</small>
                    )}
                    {d.walletEvidence?.length ? (
                      <details>
                        <summary>Wallet evidence</summary>
                        <p>{d.walletEvidence.join(" · ")}</p>
                      </details>
                    ) : (
                      <small className="evidence-unknown">
                        Wallet relationship evidence not supplied
                      </small>
                    )}
                  </div>
                </article>
              ))
            ) : (
              <div className="empty">
                <span>◎</span>
                <h3>Waiting for a decision</h3>
                <p>
                  Risk-governor outcomes and their reasons appear as the engine evaluates real
                  observations.
                </p>
              </div>
            )}
          </div>
        </section>
      </div>
      <div className="secondary-grid">
        <section className="card equity-card">
          <div className="card-heading">
            <div>
              <span className="section-index">03</span>
              <h2>Paper equity</h2>
            </div>
            <span className="card-caption">Observed values only</span>
          </div>
          <div className="equity-numbers">
            <strong>
              {sol(equity)} <small>SOL</small>
            </strong>
            <span>
              Observed drawdown (gaps excluded){" "}
              <b>{state?.equity.length ? sol(drawdown.toString()) : "—"} SOL</b>
            </span>
          </div>
          <Equity points={state?.equity ?? []} />
        </section>
        <section className="card health-card">
          <div className="card-heading">
            <div>
              <span className="section-index">04</span>
              <h2>System health</h2>
            </div>
            <span className="card-caption">{state?.health.status ?? "Unknown"}</span>
          </div>
          <dl>
            <div>
              <dt>Received / decoded</dt>
              <dd>
                {state
                  ? `${state.health.received.toLocaleString()} / ${state.health.decoded.toLocaleString()}`
                  : "—"}
              </dd>
            </div>
            <div>
              <dt>Rejected / errors</dt>
              <dd>
                {state
                  ? `${state.health.rejected.toLocaleString()} / ${state.health.errors.toLocaleString()}`
                  : "—"}
              </dd>
            </div>
            <div>
              <dt>Full transaction fetch p50 / p95</dt>
              <dd>
                {state?.health.latencyMs.p50 == null
                  ? "—"
                  : `${state.health.latencyMs.p50.toFixed(1)} ms`}{" "}
                /{" "}
                {state?.health.latencyMs.p95 == null
                  ? "—"
                  : `${state.health.latencyMs.p95.toFixed(1)} ms`}
              </dd>
            </div>
            <div>
              <dt>Last chain event</dt>
              <dd>{since(state?.health.lastEventAt, now)}</dd>
            </div>
            <div>
              <dt>Queue depth / backfill gaps</dt>
              <dd>
                {state?.health.queueDepth ?? "—"} / {state?.health.backfillGaps ?? "—"}
              </dd>
            </div>
            <div>
              <dt>Last provider error</dt>
              <dd>{state?.health.lastError ?? "None reported"}</dd>
            </div>
            <div>
              <dt>Typed notifications / dropped</dt>
              <dd>
                {state?.health.typedLogs?.received ?? "—"} /{" "}
                {state?.health.typedLogs?.dropped ?? "—"}
              </dd>
            </div>
            <div>
              <dt>Typed events observed</dt>
              <dd>{state?.health.typedObserved ?? "—"}</dd>
            </div>
            <div>
              <dt>Typed-event latency p95</dt>
              <dd>
                {state?.health.typedLogs?.latencyMs.p95 == null
                  ? "—"
                  : state.health.typedLogs.latencyMs.p95.toFixed(1) + " ms"}
              </dd>
            </div>
          </dl>
          <p className="health-note">
            Typed feed latency starts at local receipt; full transaction enrichment is measured
            separately. Neither proves validator-to-observer latency or first-block execution.
          </p>
        </section>
      </div>
      <Portfolio state={state} panel={panel} setPanel={setPanel} />
      <ResearchPanel state={research} error={researchError} />
      {(state?.limitations?.length ?? 0) > 0 && (
        <section className="limitations">
          <h2>Current operating limits</h2>
          <ul>
            {state!.limitations.map((limit, i) => (
              <li key={i}>{limit}</li>
            ))}
          </ul>
        </section>
      )}
      <footer className="page-footer">
        <span>PHANTOM / EVIDENCE BEFORE EXECUTION</span>
        <span>Observed blockchain transactions are real. Every bot fill is paper.</span>
        <span>{state ? new Date(state.now).toLocaleDateString() : "Awaiting engine"}</span>
      </footer>
    </main>
  );
}
