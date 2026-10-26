import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
  createChart,
  ColorType,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Candle } from "@/lib/desk/terminal-market";
import { Expand, RefreshCw, ChartCandlestick, ChartLine } from "lucide-react";
export function MarketChart({
  pair,
  symbol,
  mint,
  pending = false,
}: {
  pair: string;
  symbol: string;
  mint: string;
  pending?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null),
    wrap = useRef<HTMLDivElement>(null),
    chart = useRef<IChartApi | null>(null),
    candles = useRef<ISeriesApi<"Candlestick"> | null>(null),
    volume = useRef<ISeriesApi<"Histogram"> | null>(null),
    line = useRef<ISeriesApi<"Line"> | null>(null);
  const [frame, setFrame] = useState("1m"),
    [style, setStyle] = useState<"candles" | "line">("candles"),
    [data, setData] = useState<Candle[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [revision, setRevision] = useState(0),
    [fetchedAt, setFetchedAt] = useState<number | null>(null),
    [hover, setHover] = useState<Candle | null>(null);
  const first = useRef("");
  useEffect(() => {
    if (!host.current) return;
    const c = createChart(host.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#0b1018" },
        textColor: "#79869b",
        fontFamily: "IBM Plex Mono",
        fontSize: 10,
        attributionLogo: true,
      },
      grid: { vertLines: { color: "#141d29" }, horzLines: { color: "#141d29" } },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "#758699", labelBackgroundColor: "#28354a" },
        horzLine: { color: "#758699", labelBackgroundColor: "#28354a" },
      },
      rightPriceScale: { borderColor: "#1b2635", scaleMargins: { top: 0.1, bottom: 0.23 } },
      timeScale: {
        borderColor: "#1b2635",
        timeVisible: true,
        secondsVisible: false,
        barSpacing: 7,
      },
      handleScroll: true,
      handleScale: true,
    });
    const cs = c.addSeries(CandlestickSeries, {
      upColor: "#16dba0",
      downColor: "#ef617b",
      wickUpColor: "#16dba0",
      wickDownColor: "#ef617b",
      borderVisible: false,
      priceFormat: { type: "price", precision: 8, minMove: 0.00000001 },
    });
    const ls = c.addSeries(LineSeries, {
      color: "#20dea9",
      lineWidth: 2,
      visible: false,
      priceFormat: { type: "price", precision: 8, minMove: 0.00000001 },
    });
    const vs = c.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
    });
    vs.priceScale().applyOptions({ scaleMargins: { top: 0.81, bottom: 0 } });
    chart.current = c;
    candles.current = cs;
    line.current = ls;
    volume.current = vs;
    c.subscribeCrosshairMove((p) => {
      const d = p.seriesData.get(cs);
      if (d && "open" in d)
        setHover({
          time: Number(p.time),
          open: d.open,
          high: d.high,
          low: d.low,
          close: d.close,
          volume: 0,
        });
      else setHover(null);
    });
    return () => {
      c.remove();
      chart.current = null;
    };
  }, []);
  useEffect(() => {
    candles.current?.applyOptions({ visible: style === "candles" });
    line.current?.applyOptions({ visible: style === "line" });
  }, [style]);
  useEffect(() => {
    let live = true,
      working = false;
    const controller = new AbortController();
    setData([]);
    setHover(null);
    setFetchedAt(null);
    setLoading(true);
    setError("");
    const pull = async () => {
      if (working || !pair) {
        if (!pair) {
          setLoading(pending);
          setError(pending ? "" : "No indexed pool for this token yet.");
        }
        return;
      }
      working = true;
      try {
        const r = await fetch(
          `/api/terminal?view=chart&pair=${encodeURIComponent(pair)}&frame=${frame}&mint=${encodeURIComponent(mint)}`,
          { signal: controller.signal },
        );
        const b = await r.json();
        if (!r.ok) throw Error(b.error ?? "Chart data is unavailable");
        if (live) {
          setData(b.candles);
          setFetchedAt(b.fetchedAt);
          setError(b.candles.length ? "" : "No candles returned for this pool.");
        }
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : "Chart unavailable");
      } finally {
        if (live) setLoading(false);
        working = false;
      }
    };
    void pull();
    const timer = setInterval(() => void pull(), 30000);
    return () => {
      live = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [pair, mint, frame, revision, pending]);
  useEffect(() => {
    const rows = data.map((d) => ({ ...d, time: d.time as UTCTimestamp }));
    candles.current?.setData(rows);
    line.current?.setData(rows.map((d) => ({ time: d.time, value: d.close })));
    volume.current?.setData(
      rows.map((d) => ({
        time: d.time,
        value: d.volume,
        color: d.close >= d.open ? "#15a77c55" : "#df577955",
      })),
    );
    if (first.current !== pair + frame && data.length) {
      chart.current?.timeScale().fitContent();
      first.current = pair + frame;
    }
    if (data.length) {
      const p = data.at(-1)!.close;
      const precision = p >= 100 ? 2 : p >= 1 ? 4 : p >= 0.01 ? 6 : 9;
      for (const s of [candles.current, line.current])
        s?.applyOptions({ priceFormat: { type: "price", precision, minMove: 10 ** -precision } });
    }
  }, [data, pair, frame]);
  const last = hover ?? data.at(-1);
  const fmt = (x: number) => (x >= 1 ? x.toFixed(3) : x.toPrecision(4));
  return (
    <div className="omni-chart-panel" ref={wrap}>
      <div className="omni-chart-toolbar">
        <div className="omni-timeframes">
          {["1m", "5m", "15m", "1h", "4h"].map((f) => (
            <button key={f} className={frame === f ? "active" : ""} onClick={() => setFrame(f)}>
              {f}
            </button>
          ))}
        </div>
        <span className="omni-toolbar-rule" />
        <button
          className={style === "candles" ? "active" : ""}
          aria-label="Candlestick chart"
          onClick={() => setStyle("candles")}
        >
          <ChartCandlestick size={15} />
        </button>
        <button
          className={style === "line" ? "active" : ""}
          aria-label="Line chart"
          onClick={() => setStyle("line")}
        >
          <ChartLine size={15} />
        </button>
        <div className="omni-chart-tools-right">
          <span>USD · UTC</span>
          <button
            aria-label="Refresh chart"
            onClick={() => {
              first.current = "";
              setRevision((n) => n + 1);
            }}
          >
            <RefreshCw size={13} />
          </button>
          <button
            aria-label="Expand chart"
            onClick={() => void wrap.current?.requestFullscreen?.()}
          >
            <Expand size={14} />
          </button>
        </div>
      </div>
      <div className="omni-chart-heading">
        <span>{symbol} / USD</span>
        <span className="omni-chart-dot">·</span>
        <span>{frame}</span>
        <span className="omni-chart-source">GeckoTerminal</span>
      </div>
      {last && (
        <div className="omni-ohlc">
          <span>
            O <b>{fmt(last.open)}</b>
          </span>
          <span>
            H <b>{fmt(last.high)}</b>
          </span>
          <span>
            L <b>{fmt(last.low)}</b>
          </span>
          <span>
            C <b className={last.close >= last.open ? "positive" : "negative"}>{fmt(last.close)}</b>
          </span>
        </div>
      )}
      <div className="omni-chart-canvas" ref={host} />
      {(loading || (!data.length && error)) && (
        <div className="omni-chart-empty">
          {loading ? (
            <>
              <span className="omni-loading-ring" />
              <strong>Loading market candles</strong>
              <p>Fetching real pool history.</p>
            </>
          ) : (
            <>
              <ChartCandlestick size={30} />
              <strong>Chart temporarily unavailable</strong>
              <p>{error}</p>
              <button onClick={() => setRevision((n) => n + 1)}>Retry data</button>
            </>
          )}
        </div>
      )}
      <div className="omni-chart-footer">
        <span>
          <i className={error ? "status-dot warn" : "status-dot"} />
          {data.length
            ? error
              ? `Refresh failed · showing ${data.length} earlier candles`
              : `${data.length} real candles · ${fetchedAt ? new Date(fetchedAt).toLocaleTimeString() : ""}`
            : "Awaiting market data"}
        </span>
        <a href="https://www.tradingview.com/lightweight-charts/" target="_blank" rel="noreferrer">
          TradingView Lightweight Charts™ ↗
        </a>
      </div>
    </div>
  );
}
