import { getSql, ensureDbReady } from "../db";
import { activityCursor, liveBookReport, type LiveBotReport } from "./sniper-activity.ts";
import { activityPage } from "./sniper-activity-store.ts";

export async function sniperLiveReport(after?: string | null): Promise<LiveBotReport> {
  const { sniperSuiteReport } = await import("./sniper.server");
  const cursor = activityCursor(after);
  await ensureDbReady();
  const sql = await getSql();
  const [page, reports, heartbeats, tapes, started] = await Promise.all([
    activityPage(sql, cursor),
    sniperSuiteReport(),
    sql.query<{ status: string; last_tick_ms: number; last_error: string | null }>(
      "select status,last_tick_ms,last_error from worker_heartbeat where worker_name='market'",
    ),
    sql.query<{ sources: LiveBotReport["sources"] }>(
      "select tape_json->'sources' as sources from desk_state where id=1",
    ),
    sql.query<{ at: number }>("select at_ms as at from paper_sniper_activity order by id limit 1"),
  ]);
  const now = Date.now(),
    h = heartbeats[0];
  return {
    mode: "PAPER",
    engine: "RULE_BASED",
    serverAt: now,
    ...page,
    recordingStartedAt: started[0]?.at ?? null,
    books: reports.map((r) => liveBookReport(r, now)),
    worker: {
      status: h?.status ?? "offline",
      lastTickAt: h?.last_tick_ms ?? null,
      error: h?.last_error ?? null,
      host: "Self-hosted collector",
    },
    sources: tapes[0]?.sources ?? [],
  };
}
