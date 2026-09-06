import { barrierResult, labelConfidence, pathGaps } from "./labels.ts";
import { SNIPER_LABEL_VERSION } from "./v35-lock.ts";
import { EXECUTION_ASSUMPTION_VERSION } from "./versions.ts";
import type { PathTick } from "./types.ts";
import type { SniperOutcome, SniperSession } from "./v35-types.ts";

function slice(path: PathTick[], from: number, horizonMs: number) {
  return path.filter((p) => p.ts >= from && p.ts <= from + horizonMs);
}

function mfe(entry: number, ticks: PathTick[]) {
  if (!ticks.length || !entry) return null;
  return Math.max(...ticks.map((t) => t.px / entry - 1));
}
function mae(entry: number, ticks: PathTick[]) {
  if (!ticks.length || !entry) return null;
  return Math.min(...ticks.map((t) => t.px / entry - 1));
}

export function labelSniperSession(
  session: SniperSession,
  path: PathTick[],
  entryPrice: number,
  now: number,
): SniperOutcome {
  const from = session.triggerTime;
  const usable = path.filter((p) => p.ts >= from && p.ts <= now);
  const g = pathGaps(usable);
  const conf = labelConfidence(g.max === Number.POSITIVE_INFINITY ? 999 : g.max, g.count);
  const h30 = slice(usable, from, 30_000);
  const h60 = slice(usable, from, 60_000);
  const h5 = slice(usable, from, 5 * 60_000);
  const h15 = slice(usable, from, 15 * 60_000);
  const last = usable.at(-1);
  const pending = now - from < 15 * 60_000 && (!last || last.ts - from < 15 * 60_000);
  const b10 = barrierResult(entryPrice, h15, 0.1, 0.1);
  let status: SniperOutcome["outcomeStatus"] = "COMPLETE";
  if (pending && b10 === "NEITHER") status = "PENDING";
  if (b10 === "AMBIGUOUS") status = "AMBIGUOUS";
  if (b10 === "INSUFFICIENT_DATA" || conf === "UNKNOWN") status = "INSUFFICIENT_DATA";
  const theo = last && entryPrice ? last.px / entryPrice - 1 : null;
  return {
    sessionId: session.id,
    maxReturn30s: mfe(entryPrice, h30),
    maxReturn60s: mfe(entryPrice, h60),
    maxReturn5m: mfe(entryPrice, h5),
    maxReturn15m: mfe(entryPrice, h15),
    maxDrawdown5m: mae(entryPrice, h5),
    upper5BeforeLower5: barrierResult(entryPrice, h15, 0.05, 0.05),
    upper10BeforeLower10: b10,
    upper20BeforeLower10: barrierResult(entryPrice, h15, 0.2, 0.1),
    liquidityCollapse: null,
    routeLost: null,
    rugOutcome: null,
    theoreticalReturn: theo,
    executionAdjustedReturn: theo,
    barrierConfidence: conf,
    outcomeStatus: status,
  };
}

void SNIPER_LABEL_VERSION;
void EXECUTION_ASSUMPTION_VERSION;
