export function usd(n: number, digits = 2) {
  const sign = n < 0 ? "-" : "";
  const v = Math.abs(n);
  if (v >= 1_000_000) return `${sign}$${(v / 1_000_000).toFixed(2)}m`;
  if (v >= 10_000) return `${sign}$${(v / 1_000).toFixed(1)}k`;
  return `${sign}$${v.toFixed(digits)}`;
}

export function pct(n: number, digits = 1) {
  const sign = n > 0 ? "+" : "";
  return `${sign}${(n * 100).toFixed(digits)}%`;
}

export function compact(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toFixed(0);
}

export function bps(n: number) {
  return `${n.toFixed(0)} bps`;
}

export function shortAddr(a: string) {
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

export function regimeLabel(r: string) {
  switch (r) {
    case "meme_mania":
      return "Mania";
    case "trend":
      return "Trend";
    case "chop":
      return "Chop";
    case "risk_off":
      return "Risk off";
    default:
      return r;
  }
}

export function clock(ts: number) {
  const d = new Date(ts);
  return d.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function ageLabel(s: number | null | undefined) {
  if (s == null || !Number.isFinite(s)) return "—";
  if (s < 60) return `${s.toFixed(0)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86_400).toFixed(1)}d`;
}
