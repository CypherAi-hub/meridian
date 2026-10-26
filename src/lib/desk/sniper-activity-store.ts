import { activityCursor, type ActivityDraft, type ActivityEvent } from "./sniper-activity.ts";
export type ActivitySql = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
};

export async function writeSniperActivity(sql: ActivitySql, events: ActivityDraft[]) {
  if (!events.length) return;
  await sql.query(
    `insert into paper_sniper_activity(event_key,session_id,at_ms,kind,mint,symbol,detail)
    select x.key,x.session,x.at,x.kind,x.mint,x.symbol,x.detail
    from jsonb_to_recordset($1::jsonb) as x(key text,session text,at bigint,kind text,mint text,symbol text,detail jsonb)
    on conflict(event_key) do nothing`,
    [JSON.stringify(events)],
  );
}

export async function activityPage(sql: ActivitySql, after?: string | null) {
  const cursor = activityCursor(after);
  const rows = await sql.query<ActivityEvent>(
    `select id::text as id,event_key as key,session_id as session,at_ms as at,kind,mint,symbol,detail
    from paper_sniper_activity ${cursor == null ? "" : "where paper_sniper_activity.id>$1::bigint"} order by paper_sniper_activity.id ${cursor == null ? "desc" : "asc"} limit 151`,
    cursor == null ? [] : [cursor],
  );
  const events = rows.slice(0, 150);
  if (cursor == null) events.reverse();
  return {
    events,
    cursor: events.at(-1)?.id ?? cursor ?? "0",
    hasMore: cursor != null && rows.length > 150,
  };
}
