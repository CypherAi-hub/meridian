import { useEffect, useRef, useState } from "react";
import {
  Search,
  ChevronDown,
  ArrowUpRight,
  Wallet,
  Star,
  Copy,
  Settings2,
  Layers3,
  LockKeyhole,
  Command,
  ArrowDownUp,
  Plus,
  X,
  Check,
  ExternalLink,
  PanelLeftClose,
  Menu,
} from "lucide-react";
import { MarketChart } from "./market-chart";
import { LiveBot } from "./live-bot";
import { SniperPanel } from "@/components/desk/sniper-panel";
import { CapitalPanel } from "@/components/desk/capital-panel";
import { DeskApp } from "@/components/desk/desk-app";
import type { TerminalToken } from "@/lib/desk/terminal-market";
import type { ManualBook } from "@/lib/desk/manual";
import type { DeskSnapshot } from "@/lib/desk/types";
import { WSOL } from "@/lib/desk/schema";

type ManualReport = {
  state: ManualBook;
  metrics: {
    cashUsdc: number;
    availableUsdc: number;
    equityUsdc: number;
    realizedUsdc: number;
    unvaluedPositions: number;
    pending: number;
  };
};
function useFeed<T>(url: string, interval: number) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState(""),
    [readOnly, setReadOnly] = useState(false),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true,
      busy = false;
    const controller = new AbortController();
    const refresh = async () => {
      if (busy) return;
      busy = true;
      try {
        const r = await fetch(url, { signal: controller.signal });
        if (!r.ok) throw Error(`Service ${r.status}`);
        const b = await r.json();
        if (active) {
          setData(b);
          setError("");
          setReadOnly(r.headers.get("x-meridian-preview") === "read-only");
        }
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : "Unavailable");
      } finally {
        busy = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), interval);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [url, interval, revision]);
  return { data, error, readOnly, refresh: () => setRevision((n) => n + 1) };
}
const money = (n: number | null | undefined): string =>
  n == null
    ? "—"
    : n < 0
      ? "−" + money(-n)
      : n >= 1e9
        ? "$" + (n / 1e9).toFixed(2) + "B"
        : n >= 1e6
          ? "$" + (n / 1e6).toFixed(2) + "M"
          : n >= 1e3
            ? "$" + (n / 1e3).toFixed(1) + "K"
            : "$" + n.toFixed(2);
const price = (n: number | null | undefined) =>
  n == null
    ? "—"
    : n >= 1
      ? "$" + n.toLocaleString("en-US", { maximumFractionDigits: 3 })
      : "$" + n.toPrecision(4);
const percent = (n: number | null | undefined) =>
  n == null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
const short = (x: string) => x.slice(0, 5) + "…" + x.slice(-4);
const qty = (raw: string, decimals: number) => Number(raw) / 10 ** decimals;
function TokenIcon({
  token,
  symbol,
  size = "",
}: {
  token?: TerminalToken | null;
  symbol: string;
  size?: string;
}) {
  return (
    <span className={"omni-token-icon " + size}>
      {token?.imageUrl ? (
        <img
          src={token.imageUrl}
          alt=""
          loading="lazy"
          onError={(e) => {
            e.currentTarget.style.display = "none";
          }}
        />
      ) : (
        symbol.slice(0, 2)
      )}
    </span>
  );
}
function SolanaIcon() {
  return (
    <span className="omni-solana">
      <i />
      <i />
      <i />
    </span>
  );
}
export function OmniApp() {
  const manual = useFeed<ManualReport>("/api/terminal", 4000),
    desk = useFeed<DeskSnapshot>("/api/desk", 10000);
  const [page, setPage] = useState<"live" | "terminal" | "automations" | "settings" | "research">(
      "live",
    ),
    [selected, setSelected] = useState(WSOL),
    [token, setToken] = useState<TerminalToken | null>(null),
    [tokenError, setTokenError] = useState(""),
    [query, setQuery] = useState(""),
    [results, setResults] = useState<TerminalToken[]>([]),
    [searchOpen, setSearchOpen] = useState(false),
    [searching, setSearching] = useState(false),
    [searchError, setSearchError] = useState(""),
    [watchMode, setWatchMode] = useState<"watchlist" | "discover">("watchlist"),
    [bottom, setBottom] = useState<"positions" | "orders" | "trades">("positions"),
    [side, setSide] = useState<"BUY" | "SELL">("BUY"),
    [amount, setAmount] = useState("25"),
    [sellPct, setSellPct] = useState(100),
    [submitting, setSubmitting] = useState(false),
    [notice, setNotice] = useState(""),
    [lastRequest, setLastRequest] = useState(""),
    [copied, setCopied] = useState(false),
    [sidebar, setSidebar] = useState(false),
    [localWatch, setLocalWatch] = useState<string[]>([]);
  const searchInput = useRef<HTMLInputElement>(null);
  const retryRequest = useRef<{ key: string; id: string } | null>(null);
  const book = manual.data?.state,
    metrics = manual.data?.metrics,
    readOnly = manual.readOnly;
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInput.current?.focus();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);
  useEffect(() => {
    if (book?.selectedMint)
      setSelected((current) => (current === WSOL ? book.selectedMint! : current));
  }, [book?.selectedMint]);
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    setToken(null);
    setTokenError("");
    const pull = async () => {
      try {
        const r = await fetch("/api/terminal?view=token&mint=" + encodeURIComponent(selected), {
          signal: controller.signal,
        });
        const b = await r.json();
        if (!r.ok) throw Error(b.error ?? "Token data unavailable");
        if (live) {
          setToken(b);
          setTokenError(b ? "" : "This token has no indexed DEX pool yet.");
        }
      } catch (e) {
        if (live) setTokenError(e instanceof Error ? e.message : "Token unavailable");
      }
    };
    void pull();
    const t = setInterval(() => void pull(), 15000);
    return () => {
      live = false;
      controller.abort();
      clearInterval(t);
    };
  }, [selected]);
  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      setSearching(false);
      setSearchError("");
      return;
    }
    setResults([]);
    setSearching(true);
    setSearchError("");
    let active = true;
    const c = new AbortController();
    const timer = setTimeout(() => {
      setSearching(true);
      void fetch("/api/terminal?view=search&q=" + encodeURIComponent(query), { signal: c.signal })
        .then(async (r) => {
          const b = await r.json();
          if (!r.ok) throw Error(b.error);
          if (active) setResults(b);
        })
        .catch((e) => {
          if (active) setSearchError(e instanceof Error ? e.message : "Token search unavailable");
        })
        .finally(() => {
          if (active) setSearching(false);
        });
    }, 500);
    return () => {
      active = false;
      clearTimeout(timer);
      c.abort();
    };
  }, [query]);
  async function action(body: Record<string, unknown>) {
    const r = await fetch("/api/terminal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "PAPER", ...body }),
    });
    const b = await r.json();
    if (!r.ok) throw Error(b.error ?? "Paper action failed");
    manual.refresh();
  }
  function choose(mint: string) {
    setPage("terminal");
    setSelected(mint);
    setSearchOpen(false);
    setQuery("");
    setNotice("");
    setLastRequest("");
    setSidebar(false);
    if (!readOnly) void action({ action: "select", mint }).catch((e) => setNotice(e.message));
  }
  async function watch(mint: string) {
    if (readOnly) {
      setLocalWatch((a) => (a.includes(mint) ? a.filter((x) => x !== mint) : [...a, mint]));
      return;
    }
    try {
      await action({ action: book?.watchlist.includes(mint) ? "unwatch" : "watch", mint });
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Watchlist update failed");
    }
  }
  async function order() {
    setSubmitting(true);
    setNotice("");
    try {
      const key = JSON.stringify([selected, side, side === "BUY" ? amount : sellPct]);
      if (retryRequest.current?.key !== key) {
        retryRequest.current = {
          key,
          id:
            globalThis.crypto?.randomUUID?.() ??
            `paper-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        };
      }
      const requestId = retryRequest.current.id;
      setLastRequest(requestId);
      await action({
        action: "order",
        side,
        mint: selected,
        requestId,
        ...(side === "BUY" ? { amountUsdc: amount } : { percent: sellPct }),
      });
      setNotice("Paper order submitted. Checking its status…");
      retryRequest.current = null;
      setBottom("orders");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Paper order failed");
    } finally {
      setSubmitting(false);
    }
  }
  const watched = [...new Set([...(book?.watchlist ?? [WSOL]), ...localWatch])],
    position = book?.positions.find((p) => p.mint === selected),
    pendingSelected = book?.orders.some((o) => o.mint === selected && o.status === "PENDING"),
    alive = !!desk.data?.worker.lastTickAt && Date.now() - desk.data.worker.lastTickAt < 90000;
  const submitted = book?.orders.find((o) => o.requestId === lastRequest);
  const orderNotice = submitted
    ? submitted.status === "FILLED"
      ? `Paper ${submitted.side.toLowerCase()} filled using an indicative quote.`
      : submitted.status === "EXPIRED"
        ? `Paper order expired. ${submitted.error ?? "No valid quote was available."}`
        : `Paper order pending. ${submitted.error ?? "Waiting for a fresh quote after the execution delay."}`
    : notice;
  const discovered = desk.data?.tokens ?? [];
  const rows =
    watchMode === "watchlist"
      ? watched.map((mint) => ({
          mint,
          symbol:
            mint === WSOL
              ? "SOL"
              : (discovered.find((t) => t.address === mint)?.symbol ??
                (mint === selected ? token?.symbol : undefined) ??
                short(mint)),
          price:
            mint === selected
              ? token?.priceUsd
              : mint === WSOL
                ? desk.data?.solPrice
                : discovered.find((t) => t.address === mint)?.priceUsd.value,
          change: mint === selected ? token?.change24h : null,
        }))
      : discovered.map((t) => ({
          mint: t.address,
          symbol: t.symbol,
          price: t.priceUsd.value,
          change: null,
        }));
  const total = token ? token.buys5m + token.sells5m : 0,
    buyShare = total ? token!.buys5m / total : 0;
  return (
    <div className="omni-app">
      <header className="omni-header">
        <button
          className="omni-mobile-menu"
          aria-label="Toggle watchlist"
          onClick={() => setSidebar((s) => !s)}
        >
          <Menu size={18} />
        </button>
        <button className="omni-brand" onClick={() => setPage("live")} aria-label="Omni terminal">
          <span className="omni-mark">
            <i />
          </span>
          <span>
            omni<span className="omni-brand-dot">.</span>
          </span>
        </button>
        <div className="omni-network">
          <SolanaIcon />
          Solana
          <ChevronDown size={11} />
        </div>
        <nav className="omni-nav">
          {[
            ["live", "Live bot"],
            ["terminal", "Terminal"],
            ["automations", "Automations"],
            ["research", "Research"],
          ].map(([id, label]) => (
            <button
              key={id}
              className={page === id ? "active" : ""}
              onClick={() => setPage(id as typeof page)}
            >
              {label}
              {id === "automations" && <span className="omni-nav-count">3</span>}
            </button>
          ))}
        </nav>
        <div className="omni-search">
          <Search size={15} />
          <input
            ref={searchInput}
            aria-label="Search tokens or paste a Solana contract address"
            placeholder="Search tokens or paste contract address"
            value={query}
            onFocus={() => setSearchOpen(true)}
            onChange={(e) => {
              setQuery(e.target.value);
              setSearchOpen(true);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") setSearchOpen(false);
              if (e.key === "Enter" && results[0]) choose(results[0].mint);
            }}
          />
          <span className="omni-search-key">
            <Command size={10} /> K
          </span>
          {searchOpen && query.length > 1 && (
            <div className="omni-search-results">
              <div className="omni-search-results-title">
                {searching ? "Searching Solana markets…" : "Solana token markets"}
                <button aria-label="Close search" onClick={() => setSearchOpen(false)}>
                  <X size={13} />
                </button>
              </div>
              {results.map((t) => (
                <button key={t.mint} onClick={() => choose(t.mint)}>
                  <TokenIcon token={t} symbol={t.symbol} />
                  <span>
                    <b>{t.symbol}</b>
                    <small>
                      {t.name} · {short(t.mint)}
                    </small>
                  </span>
                  <strong>
                    {money(t.liquidityUsd)}
                    <small>liquidity</small>
                  </strong>
                </button>
              ))}
              {searchError && <p>{searchError}</p>}
              {!searching && !searchError && !results.length && (
                <p>No indexed pool found. Try the full contract address.</p>
              )}
            </div>
          )}
        </div>
        <div className="omni-header-right">
          <span className="omni-paper-badge">
            <span />
            PAPER
          </span>
          <button
            className="omni-wallet"
            title="Manual paper account cash; separate from automatic strategies"
            onClick={() => setPage("settings")}
          >
            <Wallet size={14} />
            <span>{metrics ? "$" + metrics.cashUsdc.toFixed(2) : "—"}</span>
          </button>
          <button
            className="omni-settings"
            aria-label="Funding and settings"
            onClick={() => setPage("settings")}
          >
            <Settings2 size={17} />
          </button>
        </div>
      </header>
      <div className="omni-status-strip">
        <span className="omni-market-live">
          <i className={alive ? "status-dot" : "status-dot warn"} />
          {alive ? "DATA CONNECTED" : "CONNECTING DATA"}
        </span>
        <span>
          SOL <b>{price(desk.data?.solPrice || null)}</b>
        </span>
        <span>{discovered.length} markets tracked</span>
        <div />
        <span className="omni-strip-note">
          {page === "live"
            ? "Autonomous paper strategies · worker runs outside the browser"
            : "Manual paper orders · no wallet connected"}
        </span>
        <span className="omni-strip-paper">SIMULATED FUNDS</span>
      </div>
      {page === "live" ? (
        <LiveBot
          selected={selected}
          token={token}
          tokenError={tokenError}
          onSelect={setSelected}
          onTerminal={() => setPage("terminal")}
          onControls={() => setPage("automations")}
        />
      ) : page === "terminal" ? (
        <div className="omni-workspace">
          <aside className={"omni-sidebar " + (sidebar ? "open" : "")}>
            <div className="omni-sidebar-heading">
              <h2>Markets</h2>
              <button aria-label="Close watchlist" onClick={() => setSidebar(false)}>
                <PanelLeftClose size={14} />
              </button>
            </div>
            <div className="omni-list-tabs">
              <button
                className={watchMode === "watchlist" ? "active" : ""}
                onClick={() => setWatchMode("watchlist")}
              >
                <Star size={12} />
                Watchlist <span>{watched.length}</span>
              </button>
              <button
                className={watchMode === "discover" ? "active" : ""}
                onClick={() => setWatchMode("discover")}
              >
                Discover
              </button>
            </div>
            <div className="omni-list-caption">
              <span>TOKEN</span>
              <span>PRICE / 24H</span>
            </div>
            <div className="omni-market-list">
              {rows.map((t) => (
                <button
                  key={t.mint}
                  className={"omni-market-row " + (selected === t.mint ? "selected" : "")}
                  onClick={() => choose(t.mint)}
                >
                  <TokenIcon token={t.mint === selected ? token : null} symbol={t.symbol} />
                  <span className="omni-market-row-name">
                    <b>{t.symbol}</b>
                    <small>
                      <SolanaIcon />
                      Solana
                    </small>
                  </span>
                  <span className="omni-market-row-price">
                    <b>{price(t.price)}</b>
                    <small className={(t.change ?? 0) >= 0 ? "positive" : "negative"}>
                      {percent(t.change)}
                    </small>
                  </span>
                </button>
              ))}
            </div>
            <button
              className="omni-add-token"
              onClick={() => {
                setSearchOpen(true);
                searchInput.current?.focus();
              }}
            >
              <Plus size={14} />
              Add token by contract
            </button>
            <div className="omni-sidebar-bottom">
              <Layers3 size={17} />
              <div>
                <b>Let the strategies work.</b>
                <p>3 automated paper experiments.</p>
                <button onClick={() => setPage("automations")}>
                  View experiments <ArrowUpRight size={12} />
                </button>
              </div>
            </div>
          </aside>
          <main className="omni-main">
            <div className="omni-token-bar">
              <TokenIcon token={token} symbol={token?.symbol ?? "SOL"} size="large" />
              <div className="omni-token-name">
                <h1>
                  {token?.symbol ?? (selected === WSOL ? "SOL" : short(selected))}
                  <span>{token?.quoteSymbol ?? "USD"}</span>
                  <button
                    className={watched.includes(selected) ? "star active" : "star"}
                    aria-label="Toggle token watchlist"
                    onClick={() => void watch(selected)}
                  >
                    <Star size={15} fill={watched.includes(selected) ? "currentColor" : "none"} />
                  </button>
                </h1>
                <p>
                  {token?.name ?? (tokenError ? "Token data unavailable" : "Loading token")}
                  <span>·</span>
                  <button
                    onClick={() => {
                      void navigator.clipboard
                        ?.writeText(selected)
                        .then(() => {
                          setCopied(true);
                          setTimeout(() => setCopied(false), 1500);
                        })
                        .catch(() =>
                          setNotice(
                            "Copy unavailable. Select the full address from the Solscan page.",
                          ),
                        );
                    }}
                    title={selected}
                  >
                    {short(selected)}
                    {copied ? <Check size={10} /> : <Copy size={10} />}
                  </button>
                  <a
                    href={`https://solscan.io/token/${selected}`}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="View token on Solscan"
                  >
                    <ExternalLink size={10} />
                  </a>
                </p>
              </div>
              <div className="omni-spot-price">
                <strong>{price(token?.priceUsd)}</strong>
                <span className={(token?.change24h ?? 0) >= 0 ? "positive" : "negative"}>
                  {percent(token?.change24h)} <small>24h</small>
                </span>
              </div>
            </div>
            <div className="omni-market-stats">
              {[
                ["Market cap", money(token?.marketCap)],
                ["Liquidity", money(token?.liquidityUsd)],
                ["24h volume", money(token?.volume24h)],
                ["Pool", token?.dex ?? "—"],
              ].map(([label, value]) => (
                <div key={label}>
                  <span>{label}</span>
                  <b>{value}</b>
                </div>
              ))}
              <div>
                <span>5m buys / sells</span>
                <b>
                  <em className="positive">{token?.buys5m ?? "—"}</em> /{" "}
                  <em className="negative">{token?.sells5m ?? "—"}</em>
                </b>
              </div>
            </div>
            <MarketChart
              pair={token?.pair ?? ""}
              symbol={token?.symbol ?? "SOL"}
              mint={selected}
              pending={!token && !tokenError}
            />
            {tokenError && <div className="omni-data-note">{tokenError}</div>}
            <section className="omni-portfolio">
              <div className="omni-portfolio-tabs">
                {(["positions", "orders", "trades"] as const).map((t) => (
                  <button
                    className={bottom === t ? "active" : ""}
                    key={t}
                    onClick={() => setBottom(t)}
                  >
                    {t === "trades" ? "Paper trades" : t[0].toUpperCase() + t.slice(1)}{" "}
                    <span>
                      {t === "positions"
                        ? (book?.positions.length ?? 0)
                        : t === "orders"
                          ? (book?.orders.filter((o) => o.status === "PENDING").length ?? 0)
                          : (book?.fills.length ?? 0)}
                    </span>
                  </button>
                ))}
                <div />
                <span className="omni-portfolio-pnl">
                  Realized P&amp;L{" "}
                  <b className={(metrics?.realizedUsdc ?? 0) >= 0 ? "positive" : "negative"}>
                    {money(metrics?.realizedUsdc)}
                  </b>
                </span>
              </div>
              <div className="omni-table-wrap">
                <table>
                  <thead>
                    <tr>
                      {(bottom === "positions"
                        ? ["Token", "Quantity", "Cost basis", "Exit quote value", "Action"]
                        : bottom === "orders"
                          ? ["Token", "Side", "Status", "Time", "Detail"]
                          : ["Token", "Side", "Paper cash flow", "Realized P&L", "Time"]
                      ).map((h) => (
                        <th key={h}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {bottom === "positions" &&
                      book?.positions.map((p) => (
                        <tr key={p.mint}>
                          <td>
                            <button onClick={() => choose(p.mint)}>{p.symbol}</button>
                          </td>
                          <td>
                            {qty(p.rawQty, p.decimals).toLocaleString(undefined, {
                              maximumFractionDigits: 5,
                            })}
                          </td>
                          <td>{money(Number(p.costAtomic) / 1e6)}</td>
                          <td>
                            {p.markedAt && Date.now() - p.markedAt < 45000
                              ? money(Number(p.markAtomic) / 1e6)
                              : "Awaiting quote"}
                          </td>
                          <td>
                            <button
                              className="omni-table-sell"
                              onClick={() => {
                                choose(p.mint);
                                setSide("SELL");
                                setSellPct(100);
                              }}
                            >
                              Sell
                            </button>
                          </td>
                        </tr>
                      ))}
                    {bottom === "orders" &&
                      book?.orders
                        .slice()
                        .reverse()
                        .map((o) => (
                          <tr key={o.id}>
                            <td>{o.symbol}</td>
                            <td className={o.side === "BUY" ? "positive" : "negative"}>{o.side}</td>
                            <td>
                              <span className={"omni-order-status " + o.status.toLowerCase()}>
                                {o.status}
                              </span>
                            </td>
                            <td>{new Date(o.createdAt).toLocaleTimeString()}</td>
                            <td title={o.error}>
                              {o.error ??
                                (o.status === "PENDING"
                                  ? "Waiting for fresh quote"
                                  : "Exact-size indicative quote")}
                            </td>
                          </tr>
                        ))}
                    {bottom === "trades" &&
                      book?.fills
                        .slice()
                        .reverse()
                        .map((f) => (
                          <tr key={f.id}>
                            <td>{f.symbol}</td>
                            <td className={f.side === "BUY" ? "positive" : "negative"}>{f.side}</td>
                            <td>
                              {f.side === "BUY" ? "−" : "+"}
                              {money(Number(f.cashAtomic) / 1e6)}
                            </td>
                            <td className={BigInt(f.pnlAtomic) >= 0 ? "positive" : "negative"}>
                              {f.side === "SELL" ? money(Number(f.pnlAtomic) / 1e6) : "—"}
                            </td>
                            <td>{new Date(f.at).toLocaleTimeString()}</td>
                          </tr>
                        ))}
                  </tbody>
                </table>
                {!(bottom === "positions"
                  ? book?.positions.length
                  : bottom === "orders"
                    ? book?.orders.length
                    : book?.fills.length) && (
                  <div className="omni-empty-portfolio">
                    <span>
                      <ArrowDownUp size={20} />
                    </span>
                    <strong>
                      {bottom === "positions"
                        ? "Your next idea starts here."
                        : bottom === "orders"
                          ? "No paper orders yet."
                          : "No paper trades yet."}
                    </strong>
                    <p>
                      {bottom === "positions"
                        ? "Search a token, watch the chart, and test a paper entry."
                        : "Every paper fill keeps its quote, timing, and modeled costs."}
                    </p>
                  </div>
                )}
              </div>
            </section>
          </main>
          <aside className="omni-ticket">
            <div className="omni-ticket-heading">
              <h2>Trade</h2>
              <span>
                <i />
                Paper account
              </span>
            </div>
            <div className="omni-order-tabs">
              <button
                className={side === "BUY" ? "active buy" : ""}
                onClick={() => {
                  setSide("BUY");
                  setNotice("");
                  setLastRequest("");
                }}
              >
                Buy
              </button>
              <button
                className={side === "SELL" ? "active sell" : ""}
                onClick={() => {
                  setSide("SELL");
                  setNotice("");
                  setLastRequest("");
                }}
              >
                Sell
              </button>
            </div>
            <div className="omni-order-type">
              <span>Market order</span>
              <span>
                USDC <ChevronDown size={10} />
              </span>
            </div>
            <label className="omni-amount-label" htmlFor="paper-amount">
              {side === "BUY" ? "Amount" : "Sell position"}
              <span>
                {side === "BUY"
                  ? "Available " + money(metrics?.availableUsdc)
                  : position
                    ? qty(position.rawQty, position.decimals).toLocaleString() +
                      " " +
                      position.symbol
                    : "No position"}
              </span>
            </label>
            {side === "BUY" ? (
              <>
                <div className="omni-amount-input">
                  <input
                    id="paper-amount"
                    aria-label="Paper buy amount in USDC"
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                  <span>USDC</span>
                </div>
                <div className="omni-size-presets">
                  {["10", "25", "50", "100"].map((a) => (
                    <button
                      key={a}
                      className={amount === a ? "active" : ""}
                      onClick={() => setAmount(a)}
                    >
                      ${a}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <div className="omni-amount-input">
                  <input
                    id="paper-amount"
                    aria-label="Percentage of paper position to sell"
                    inputMode="numeric"
                    value={sellPct}
                    onChange={(e) => setSellPct(Number(e.target.value))}
                  />
                  <span>%</span>
                </div>
                <div className="omni-size-presets">
                  {[25, 50, 75, 100].map((a) => (
                    <button
                      key={a}
                      className={sellPct === a ? "active" : ""}
                      onClick={() => setSellPct(a)}
                    >
                      {a}%
                    </button>
                  ))}
                </div>
              </>
            )}
            <div className="omni-execution-info">
              <div>
                <span>Execution</span>
                <b>Delayed quote simulation</b>
              </div>
              <div>
                <span>Adverse slippage</span>
                <b>1.00%</b>
              </div>
              <div>
                <span>Additional modeled cost</span>
                <b>0.25% + $0.02</b>
              </div>
              <div>
                <span>Minimum delay</span>
                <b>2 seconds</b>
              </div>
            </div>
            <button
              className={"omni-submit-order " + (side === "SELL" ? "sell" : "")}
              disabled={
                submitting || readOnly || !book || pendingSelected || (side === "SELL" && !position)
              }
              onClick={() => void order()}
            >
              {submitting
                ? "Queuing paper order…"
                : readOnly
                  ? "Read-only remote preview"
                  : pendingSelected
                    ? "Paper order pending…"
                    : side === "BUY"
                      ? `Paper buy ${token?.symbol ?? "token"}`
                      : `Paper sell ${token?.symbol ?? "token"}`}
              <ArrowUpRight size={16} />
            </button>
            {orderNotice && (
              <p className="omni-order-notice" role="status">
                {orderNotice}
              </p>
            )}
            {manual.error && <p className="omni-order-notice">{manual.error}</p>}
            <div className="omni-paper-disclaimer">
              <LockKeyhole size={13} />
              <p>
                Simulated funds. Quotes do not guarantee a live fill. No wallet signing or real
                swaps.
              </p>
            </div>
            <div className="omni-flow">
              <div>
                <h3>5m market activity</h3>
                <span>Buy / sell count</span>
              </div>
              <div className="omni-flow-bar">
                <i style={{ width: total ? `${buyShare * 100}%` : "50%" }} />
              </div>
              <div>
                <b className="positive">{total ? `${(buyShare * 100).toFixed(0)}% buys` : "—"}</b>
                <b className="negative">
                  {total ? `${((1 - buyShare) * 100).toFixed(0)}% sells` : "—"}
                </b>
              </div>
            </div>
            <div className="omni-account-card">
              <div>
                <Wallet size={14} />
                <h3>Manual paper account</h3>
              </div>
              <dl>
                <div>
                  <dt>Cash</dt>
                  <dd>{money(metrics?.cashUsdc)}</dd>
                </div>
                <div>
                  <dt>Conservative equity</dt>
                  <dd>{money(metrics?.equityUsdc)}</dd>
                </div>
                <div>
                  <dt>Realized P&amp;L</dt>
                  <dd className={(metrics?.realizedUsdc ?? 0) >= 0 ? "positive" : "negative"}>
                    {money(metrics?.realizedUsdc)}
                  </dd>
                </div>
              </dl>
              {!!metrics?.unvaluedPositions && (
                <p>{metrics.unvaluedPositions} positions awaiting a fresh exit quote.</p>
              )}
              <button onClick={() => setPage("settings")}>
                Future funding &amp; payouts
                <ArrowUpRight size={12} />
              </button>
            </div>
          </aside>
        </div>
      ) : (
        <main className="omni-secondary-page">
          <div className="omni-page-heading">
            <span>
              {page === "automations"
                ? "STRATEGY LAB"
                : page === "settings"
                  ? "ACCOUNT & CONTROLS"
                  : "RESEARCH DESK"}
            </span>
            <h1>
              {page === "automations"
                ? "Three hypotheses. Real observations."
                : page === "settings"
                  ? "Your capital, under your control."
                  : "Follow the evidence."}
            </h1>
            <p>
              {page === "automations"
                ? "Automated paper experiments run separately from your manual trades."
                : page === "settings"
                  ? "Payout preferences are saved. Funded execution remains locked."
                  : "Collection, data quality, and strategy diagnostics from the existing research engine."}
            </p>
          </div>
          {page === "automations" ? (
            <SniperPanel />
          ) : page === "settings" ? (
            <CapitalPanel />
          ) : (
            <DeskApp />
          )}
        </main>
      )}
      <footer className="omni-footer">
        <span>
          <i className={alive ? "status-dot" : "status-dot warn"} />
          {alive ? "Collector online" : "Collector connecting"}
        </span>
        <span>Solana mainnet data</span>
        <span>Paper execution only</span>
        <div />
        <a href="https://dexscreener.com/solana" target="_blank" rel="noreferrer">
          Market data: DEX Screener <ArrowUpRight size={10} />
        </a>
        <span>OMNI / 01</span>
      </footer>
    </div>
  );
}
