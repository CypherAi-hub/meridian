import { useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  CircleDot,
  Clock3,
  ExternalLink,
  Eye,
  Pause,
  Play,
  Radio,
  ShieldCheck,
  SlidersHorizontal,
  TriangleAlert,
  Workflow,
} from "lucide-react";
import { MarketChart } from "./market-chart";
import { OnchainFeed } from "./onchain-feed";
import { LaunchEngine, usePhantomReport } from "./launch-engine";
import {
  reasonLabel,
  type ActivityEvent,
  type LiveBotReport,
  type ActivityKind,
} from "@/lib/desk/sniper-activity";
import type { TerminalToken } from "@/lib/desk/terminal-market";

const usd = (n: number) =>
  `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const elapsed = (at: number | null | undefined, now: number) =>
  !at
    ? "awaiting first tick"
    : now - at < 2000
      ? "just now"
      : now - at < 60000
        ? `${Math.floor((now - at) / 1000)}s ago`
        : `${Math.floor((now - at) / 60000)}m ago`;
const short = (mint: string) => mint.slice(0, 5) + "…" + mint.slice(-4);
const titles: Record<ActivityKind, string> = {
  WATCH: "Token added to scan",
  SKIP: "Entry skipped",
  ELIGIBLE: "Checks passed",
  SIGNAL: "Paper entry queued",
  BUY: "Paper buy filled",
  EXIT_SIGNAL: "Paper exit queued",
  SELL: "Paper sell filled",
  EXPIRED: "Paper entry expired",
  QUOTE_ISSUE: "Quote needs retry",
  SCAN: "Market scan completed",
  CONTROL: "Entry controls changed",
};
const tradeKinds: ActivityKind[] = [
  "SIGNAL",
  "BUY",
  "EXIT_SIGNAL",
  "SELL",
  "EXPIRED",
  "QUOTE_ISSUE",
];
function eventDetail(e: ActivityEvent) {
  const d = e.detail;
  switch (e.kind) {
    case "WATCH":
      return "Observed by the collector. Checking launch, liquidity, contract and holder data.";
    case "SKIP":
      return (
        (d.reasons ?? []).slice(0, 2).map(reasonLabel).join(" · ") +
        ((d.reasons?.length ?? 0) > 2 ? ` · +${d.reasons!.length - 2} more checks` : "")
      );
    case "ELIGIBLE":
      return "Current data checks pass. The strategy still requires an available slot and paper cash.";
    case "SIGNAL":
      return `${usd(d.costUsd ?? 0)} paper entry. Waiting at least two seconds for a fresh exact-size quote.`;
    case "BUY":
      return `${usd(d.costUsd ?? 0)} including modeled costs. Indicative quote fill; no on-chain transaction.`;
    case "EXIT_SIGNAL":
      return reasonLabel(d.reason ?? "") + ". Waiting for a new quote after the execution delay.";
    case "SELL":
      return `${usd(d.proceedsUsd ?? 0)} paper proceeds · ${usd(d.pnlUsd ?? 0)} realized P&L · ${reasonLabel(d.reason ?? "")}`;
    case "EXPIRED":
      return reasonLabel(d.reason ?? "ENTRY_TIMEOUT");
    case "QUOTE_ISSUE":
      return reasonLabel(d.reason ?? "Quote unavailable") + ". No fill is assumed.";
    case "SCAN":
      return `${d.checked ?? 0} tokens checked · ${d.eligible ?? 0} passed data checks · ${d.enabled ? "entries enabled" : "entries paused"}`;
    case "CONTROL":
      return d.enabled
        ? "New paper entries enabled. The worker applies the existing strategy rules."
        : "New entries paused. The worker continues processing existing exposure.";
  }
}
function EventIcon({ kind }: { kind: ActivityKind }) {
  const Icon =
    kind === "BUY"
      ? ArrowDownLeft
      : kind === "SELL"
        ? ArrowUpRight
        : kind === "WATCH"
          ? Eye
          : kind === "SCAN"
            ? Radio
            : kind === "SKIP"
              ? ShieldCheck
              : kind === "ELIGIBLE"
                ? Check
                : kind === "QUOTE_ISSUE" || kind === "EXPIRED"
                  ? TriangleAlert
                  : Clock3;
  return <Icon size={14} />;
}

function StrategyBooks({
  selected,
  token,
  tokenError,
  onSelect,
  onTerminal,
  onControls,
}: {
  selected: string;
  token: TerminalToken | null;
  tokenError: string;
  onSelect: (mint: string) => void;
  onTerminal: () => void;
  onControls: () => void;
}) {
  const [report, setReport] = useState<LiveBotReport | null>(null),
    [events, setEvents] = useState<ActivityEvent[]>([]),
    [error, setError] = useState(""),
    [receivedAt, setReceivedAt] = useState<number | null>(null),
    [now, setNow] = useState(Date.now()),
    [filter, setFilter] = useState("all"),
    [engine, setEngine] = useState("all"),
    [frozen, setFrozen] = useState<ActivityEvent[] | null>(null);
  const cursor = useRef<string | null>(null);
  const [stream, setStream] = useState<"paper" | "chain">("paper");
  useEffect(() => {
    let alive = true,
      busy = false;
    const controller = new AbortController();
    const pull = async () => {
      if (busy) return;
      busy = true;
      try {
        const r = await fetch(
          "/api/sniper?view=live" + (cursor.current == null ? "" : "&after=" + cursor.current),
          { signal: controller.signal, cache: "no-store" },
        );
        const data = await r.json();
        if (!r.ok) throw Error(data.error ?? `Activity service ${r.status}`);
        if (alive) {
          const b = data as LiveBotReport;
          setReport(b);
          setError("");
          setReceivedAt(Date.now());
          cursor.current = b.cursor;
          setEvents((old) => {
            const by = new Map(old.map((e) => [e.id, e]));
            for (const event of b.events) by.set(event.id, event);
            return [...by.values()]
              .sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? -1 : 1))
              .slice(0, 400);
          });
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "Feed unavailable");
      } finally {
        busy = false;
      }
    };
    void pull();
    const timer = setInterval(() => void pull(), 3000),
      clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      alive = false;
      controller.abort();
      clearInterval(timer);
      clearInterval(clock);
    };
  }, []);
  const books = report?.books ?? [];
  const observedNow = report && receivedAt ? report.serverAt + now - receivedAt : now;
  const workerFresh =
    !!report?.worker.lastTickAt &&
    observedNow - report.worker.lastTickAt < 90000 &&
    report.worker.status === "live";
  const booksFresh =
    !!books.length && books.every((b) => b.initialized && observedNow - b.updatedAt < 90000);
  const connected = !!receivedAt && now - receivedAt < 12000 && !error;
  const enabled = books.filter((b) => b.enabled).length;
  const running = workerFresh && booksFresh;
  const allChecks = books.reduce((n, b) => n + b.recentChecks, 0),
    eligible = books.reduce((n, b) => n + b.eligible, 0);
  const realized = books.reduce((n, b) => n + b.metrics.realizedUsd, 0),
    open = books.reduce((n, b) => n + b.metrics.open, 0),
    pending = books.reduce((n, b) => n + b.metrics.pending, 0),
    closed = books.reduce((n, b) => n + b.metrics.closed, 0);
  const activity = (frozen ?? events).filter(
    (e) =>
      (engine === "all" || e.session === engine) &&
      (filter === "all" ||
        (filter === "trades"
          ? tradeKinds.includes(e.kind)
          : filter === "decisions"
            ? ["WATCH", "SKIP", "ELIGIBLE"].includes(e.kind)
            : ["SCAN", "CONTROL"].includes(e.kind))),
  );
  const positions = books.flatMap((book) =>
    book.trades
      .filter((t) => t.status === "open" || t.status === "pending")
      .map((trade) => ({ book, trade })),
  );
  const constraints = new Map<string, number>();
  for (const b of books)
    for (const r of b.reasons) constraints.set(r.code, (constraints.get(r.code) ?? 0) + r.count);
  return (
    <main className="omni-live">
      <div className="omni-live-heading">
        <div>
          <div className="omni-live-eyebrow">
            <span className={running ? "status-dot" : "status-dot warn"} />
            {running ? "AUTONOMOUS PAPER BOT" : "WAITING FOR COLLECTOR"}
          </div>
          <h1>
            Watch the bot work<span>.</span>
          </h1>
          <p>Real scans. Recorded decisions. Simulated trades.</p>
        </div>
        <div className="omni-live-heading-right">
          <span className={"omni-live-status " + (running ? "running" : "waiting")}>
            <Workflow size={13} />
            {running ? (enabled ? "Scanning Solana" : "Entries paused") : "Worker data stale"}
          </span>
          <button onClick={onControls}>
            <SlidersHorizontal size={13} />
            Strategy controls
          </button>
          <small>Collector tick {elapsed(report?.worker.lastTickAt, observedNow)}</small>
        </div>
      </div>
      <div className="omni-live-kpis">
        <div>
          <span>Automation</span>
          <strong>
            {enabled}
            <small> / {books.length || 3} enabled</small>
          </strong>
          <p>Rule-based strategies · paper only</p>
        </div>
        <div>
          <span>Recent strategy checks</span>
          <strong>
            {allChecks}
            <small> / 90 sec</small>
          </strong>
          <p>{eligible} passed all current data checks</p>
        </div>
        <div>
          <span>Paper positions</span>
          <strong>
            {open}
            <small> open · {pending} queued</small>
          </strong>
          <p>Exact-size quotes with modeled costs</p>
        </div>
        <div>
          <span>Realized paper P&amp;L</span>
          <strong className={realized < 0 ? "negative" : "positive"}>{usd(realized)}</strong>
          <p>{closed} closed trades across separate books</p>
        </div>
      </div>
      {error && (
        <div className="omni-live-warning" role="alert">
          <TriangleAlert size={14} />
          Feed connection interrupted: {error}. Last successful update {elapsed(receivedAt, now)}.
        </div>
      )}
      {!running && report && (
        <div className="omni-live-warning">
          <Clock3 size={14} />
          Collector data is stale. Start Run-Omni.cmd on the computer running Omni, then wait for
          the next collector tick.
        </div>
      )}
      <div className="omni-live-layout">
        <section className="omni-bot-feed" aria-label="Live automated paper activity">
          <div className="omni-feed-heading">
            <div>
              <Radio size={15} />
              <h2>{stream === "paper" ? "Live activity" : "Pool transactions"}</h2>
              <span className={"omni-feed-live " + (connected && !frozen ? "" : "muted")}>
                <i />
                {stream === "chain"
                  ? "READ ONLY"
                  : frozen
                    ? "VIEW PAUSED"
                    : connected
                      ? report?.hasMore
                        ? "CATCHING UP"
                        : "LIVE"
                      : "CONNECTING"}
              </span>
            </div>
            {stream === "paper" && (
              <button
                aria-label={frozen ? "Resume activity feed" : "Pause activity feed"}
                onClick={() => setFrozen(frozen ? null : events)}
              >
                {frozen ? <Play size={13} /> : <Pause size={13} />}
              </button>
            )}
          </div>
          <div className="omni-feed-streams">
            <button
              className={stream === "paper" ? "active" : ""}
              onClick={() => setStream("paper")}
            >
              Paper bot
            </button>
            <button
              className={stream === "chain" ? "active" : ""}
              onClick={() => setStream("chain")}
            >
              On-chain pool
            </button>
            <span>{stream === "paper" ? "Simulated execution" : "Public mainnet activity"}</span>
          </div>
          {stream === "chain" ? (
            <OnchainFeed pair={token?.pair ?? ""} />
          ) : (
            <>
              <div className="omni-feed-filters">
                <div>
                  {[
                    ["all", "All"],
                    ["trades", "Trades"],
                    ["decisions", "Decisions"],
                    ["health", "Scans"],
                  ].map(([value, label]) => (
                    <button
                      key={value}
                      className={filter === value ? "active" : ""}
                      onClick={() => setFilter(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <select
                  value={engine}
                  onChange={(e) => setEngine(e.target.value)}
                  aria-label="Filter activity by strategy"
                >
                  <option value="all">All strategies</option>
                  {books.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </div>
              {frozen && (
                <p className="omni-feed-paused">
                  Display paused. The autonomous paper worker keeps running.
                </p>
              )}
              <div
                className="omni-feed-events"
                role="log"
                aria-label="Recorded bot events"
                aria-live="off"
              >
                {activity.slice(0, 150).map((e) => (
                  <article key={e.id} className={"omni-feed-event " + e.kind.toLowerCase()}>
                    <div className="omni-event-marker">
                      <EventIcon kind={e.kind} />
                    </div>
                    <div className="omni-event-body">
                      <div className="omni-event-title">
                        <strong>{titles[e.kind]}</strong>
                        <time title={new Date(e.at).toISOString()}>
                          {new Date(e.at).toLocaleTimeString(undefined, { hour12: false })}
                        </time>
                      </div>
                      <div className="omni-event-identity">
                        {e.mint && (
                          <button onClick={() => onSelect(e.mint!)} title={e.mint}>
                            {e.symbol ?? short(e.mint)}
                            <ArrowUpRight size={10} />
                          </button>
                        )}
                        <span>{books.find((b) => b.id === e.session)?.name ?? e.session}</span>
                      </div>
                      <p>{eventDetail(e)}</p>
                      {!!e.detail.reasons?.length && (
                        <details>
                          <summary>All checks ({e.detail.reasons.length})</summary>
                          <ul>
                            {e.detail.reasons.map((reason) => (
                              <li key={reason}>{reasonLabel(reason)}</li>
                            ))}
                          </ul>
                        </details>
                      )}
                      {e.kind === "SELL" && (
                        <span
                          className={
                            "omni-event-pnl " +
                            ((e.detail.pnlUsd ?? 0) < 0 ? "negative" : "positive")
                          }
                        >
                          {usd(e.detail.pnlUsd ?? 0)} net realized
                        </span>
                      )}
                    </div>
                  </article>
                ))}
                {!activity.length && (
                  <div className="omni-feed-empty">
                    <Activity size={25} />
                    <strong>
                      {filter === "trades"
                        ? "Waiting for a paper trade"
                        : "Waiting for recorded activity"}
                    </strong>
                    <p>
                      {filter === "trades"
                        ? "The bot enters only when its existing rules pass. Switch to Decisions to see what it is checking."
                        : "New worker events appear here automatically. This feed records activity from this release onward."}
                    </p>
                  </div>
                )}
              </div>
              <div className="omni-feed-footer">
                <span>
                  <i className={connected ? "status-dot" : "status-dot warn"} />
                  Updated {elapsed(receivedAt, now)}
                </span>
                <span>3s refresh · recent recorded events</span>
              </div>
            </>
          )}
        </section>
        <div className="omni-live-market">
          <section className="omni-bot-market-window" aria-label="Bot market chart">
            <div className="omni-bot-market-heading">
              <div>
                {token?.imageUrl && <img src={token.imageUrl} alt="" />}
                <div>
                  <span>MARKET WINDOW</span>
                  <h2>
                    {token?.symbol ?? short(selected)} <small>/ USD</small>
                  </h2>
                </div>
              </div>
              <div>
                <strong>
                  {token?.priceUsd == null
                    ? "—"
                    : token.priceUsd >= 1
                      ? "$" + token.priceUsd.toFixed(3)
                      : "$" + token.priceUsd.toPrecision(4)}
                </strong>
                <button onClick={onTerminal}>
                  Open terminal
                  <ArrowUpRight size={12} />
                </button>
              </div>
            </div>
            <div className="omni-bot-contract">
              <span>Click a token in the activity feed to inspect its chart.</span>
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
          <section className="omni-bot-positions" aria-label="Automatic paper positions">
            <div>
              <h2>Bot positions</h2>
              <span>
                {open} open · {pending} pending
              </span>
            </div>
            {positions.length ? (
              <div className="omni-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Token / strategy</th>
                      <th>State</th>
                      <th>Entry cost</th>
                      <th>Exit quote value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {positions.map(({ book, trade: t }) => (
                      <tr key={t.id}>
                        <td>
                          <button onClick={() => onSelect(t.mint)}>{t.symbol}</button>
                          <small>{book.name}</small>
                        </td>
                        <td>{t.status}</td>
                        <td>{t.costUsd == null ? "Queued" : usd(t.costUsd)}</td>
                        <td>
                          {t.markAt && observedNow - t.markAt < 45000
                            ? usd(t.markUsd ?? 0)
                            : "Awaiting quote"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="omni-bot-no-position">
                <ShieldCheck size={20} />
                <div>
                  <strong>No automatic paper positions yet</strong>
                  <p>Scanning continues. Missing checks keep the bot out of a trade.</p>
                </div>
              </div>
            )}
          </section>
          <section className="omni-bot-constraints">
            <div>
              <h2>What is holding entries back?</h2>
              <span>Recent checks across strategies</span>
            </div>
            {[...constraints]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 3)
              .map(([reason, count]) => (
                <p key={reason}>
                  <span>{reasonLabel(reason)}</span>
                  <b>{count}</b>
                </p>
              ))}
            {!constraints.size && (
              <p>
                <span>
                  {eligible
                    ? "Current data checks pass; waiting for a strategy signal."
                    : "Waiting for fresh token checks."}
                </span>
              </p>
            )}
          </section>
        </div>
      </div>
      <section className="omni-bot-books" aria-label="Independent paper strategy accounts">
        {books.map((b, i) => (
          <article key={b.id}>
            <div>
              <span className="omni-bot-number">0{i + 1}</span>
              <h3>{b.name}</h3>
              <span className={"omni-bot-book-status " + (b.enabled ? "enabled" : "")}>
                {b.enabled ? "ENABLED" : "PAUSED"}
              </span>
            </div>
            <strong>
              {usd(b.metrics.equityUsd)}
              <small>conservative paper equity</small>
            </strong>
            <p>
              <span>
                {b.metrics.open} open · {b.metrics.closed} closed
              </span>
              <b className={b.metrics.netUsd < 0 ? "negative" : "positive"}>
                {usd(b.metrics.netUsd)} net
              </b>
            </p>
            <footer>
              <span>
                {usd(b.orderUsd)} / entry · {b.maxPositions} slots
              </span>
              <span>Tick {elapsed(b.updatedAt, observedNow)}</span>
            </footer>
          </article>
        ))}
      </section>
      <div className="omni-bot-bottom">
        <span>
          <CircleDot size={11} />
          Worker runs outside this browser. Watching does not place an order.
        </span>
        <span>
          Live market data · rule-based paper simulation · strategy profitability unproven
        </span>
      </div>
    </main>
  );
}

export function LiveBot(props: Parameters<typeof StrategyBooks>[0]) {
  const feed = usePhantomReport();
  const [view, setView] = useState<"launch" | "books" | null>(null);
  useEffect(() => {
    if (view === null && feed.report?.connection === "connected" && !feed.error) setView("launch");
  }, [view, feed.report, feed.error]);
  const selected = view ?? "books";
  return (
    <>
      <div className="omni-engine-switch" role="group" aria-label="Choose paper engine">
        <button className={selected === "launch" ? "active" : ""} onClick={() => setView("launch")}>
          <Radio size={12} />
          Launch engine
        </button>
        <button className={selected === "books" ? "active" : ""} onClick={() => setView("books")}>
          <Workflow size={12} />
          Strategy books
        </button>
        <span>
          <i
            className={
              feed.report?.connection === "connected" && !feed.error
                ? "status-dot"
                : "status-dot warn"
            }
          />
          {feed.report?.connection === "connected" && !feed.error
            ? "Local launch engine connected"
            : "Local launch engine unavailable"}
        </span>
      </div>
      {selected === "launch" ? (
        <LaunchEngine {...props} feed={feed} />
      ) : (
        <StrategyBooks {...props} />
      )}
    </>
  );
}
