import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { newSniper, sniperMetrics, type PaperTrade } from "./sniper.ts";
import {
  activityCursor,
  liveBookReport,
  sniperActivity,
  type ActivityDraft,
} from "./sniper-activity.ts";
import { activityPage, writeSniperActivity, type ActivitySql } from "./sniper-activity-store.ts";
import type { TokenSnapshot } from "./schema.ts";
const T = 1800000000000;
const token = { address: "mint-1" } as TokenSnapshot;

test("live feed records real candidate decisions without manufacturing paper buys", () => {
  const prior = newSniper(T);
  const next = structuredClone(prior);
  next.ticks = 1;
  next.updatedAt = T + 1000;
  next.candidates = [
    {
      mint: token.address,
      symbol: "TEST",
      firstSeen: T + 1000,
      lastSeen: T + 1000,
      createdAt: T,
      reasons: ["LOW_LIQUIDITY"],
      attempted: false,
    },
  ];
  const original = JSON.stringify(next);
  const events = sniperActivity(prior, next, [token]);
  assert.deepEqual(
    events.map((e) => e.kind),
    ["WATCH", "SKIP", "SCAN"],
  );
  assert.equal(events.find((e) => e.kind === "SKIP")!.detail.reasons![0], "LOW_LIQUIDITY");
  assert.equal(events.find((e) => e.kind === "SCAN")!.detail.eligible, 0);
  assert.equal(JSON.stringify(next), original);
  assert.equal(next.trades.length, 0);
  const repeat = structuredClone(next);
  repeat.ticks++;
  repeat.updatedAt += 1000;
  repeat.candidates[0].lastSeen = repeat.updatedAt;
  assert.deepEqual(sniperActivity(next, repeat, [token]), []);
});

test("activity distinguishes queued signals, fills, exit triggers, closes, and quote failures", () => {
  const before = newSniper(T);
  before.ticks = 10;
  const pending = {
    id: "trade-1",
    mint: "mint-1",
    symbol: "TEST",
    decimals: 6,
    signalAt: T + 100,
    dueAt: T + 2100,
    status: "pending",
    signal: token,
    attempts: 0,
  } as PaperTrade;
  let next = structuredClone(before);
  next.ticks++;
  next.updatedAt = T + 100;
  next.trades = [pending];
  assert.deepEqual(
    sniperActivity(before, next, []).map((e) => e.kind),
    ["SIGNAL"],
  );
  let prior = structuredClone(next);
  next = structuredClone(prior);
  next.ticks++;
  next.updatedAt = T + 2200;
  Object.assign(next.trades[0], {
    status: "open",
    entryAt: T + 2200,
    costUsd: 25.0825,
    rawQty: "123456",
  });
  const filled = sniperActivity(prior, next, []);
  assert.equal(filled[0].kind, "BUY");
  assert.equal(filled[0].detail.rawQty, "123456");
  prior = structuredClone(next);
  next = structuredClone(prior);
  next.ticks++;
  next.updatedAt = T + 3000;
  next.trades[0].error = "BUDGET";
  assert.equal(sniperActivity(prior, next, [])[0].kind, "QUOTE_ISSUE");
  assert.equal(sniperActivity(next, next, []).length, 0);
  prior = structuredClone(next);
  next = structuredClone(prior);
  next.ticks++;
  next.updatedAt = T + 4000;
  Object.assign(next.trades[0], { exitDueAt: T + 6000, exitReason: "STOP_LOSS", error: undefined });
  assert.equal(sniperActivity(prior, next, [])[0].kind, "EXIT_SIGNAL");
  prior = structuredClone(next);
  next = structuredClone(prior);
  next.ticks++;
  next.updatedAt = T + 6000;
  Object.assign(next.trades[0], {
    status: "closed",
    exitAt: T + 6000,
    proceedsUsd: 23,
    pnlUsd: -2.0825,
  });
  const closed = sniperActivity(prior, next, []);
  assert.equal(closed[0].kind, "SELL");
  assert.equal(closed[0].detail.pnlUsd, -2.0825);
  assert.deepEqual(sniperActivity(next, next, []), []);
});

test("older unresolved exposure remains visible and old candidate checks are not called current", () => {
  const s = newSniper(T);
  s.ticks = 10;
  const held = {
    id: "held",
    mint: "mint-1",
    symbol: "HELD",
    status: "open",
    signal: token,
    entryAt: T,
    rawQty: "100",
    costUsd: 25,
    attempts: 1,
  } as PaperTrade;
  s.trades = [
    held,
    ...Array.from(
      { length: 40 },
      (_, i) => ({ ...held, id: `closed-${i}`, status: "closed", pnlUsd: 0 }) as PaperTrade,
    ),
  ];
  s.candidates = [
    {
      mint: "mint-1",
      symbol: "HELD",
      firstSeen: T,
      lastSeen: T,
      createdAt: T,
      reasons: [],
      attempted: true,
    },
  ];
  const report = liveBookReport(
    { state: s, name: "TEST", initialized: true, metrics: sniperMetrics(s, T + 100000) },
    T + 100000,
  );
  assert.equal(report.recentChecks, 0);
  assert.equal(report.eligible, 0);
  assert.equal(report.trades[0].id, "held");
  assert.equal(report.trades.length, 21);
  assert.equal("signal" in report.trades[0], false);
});

test("activity cursors preserve 64-bit IDs and reject SQL fragments or overflow", () => {
  assert.equal(activityCursor("9007199254740993"), "9007199254740993");
  assert.equal(activityCursor(), null);
  for (const value of ["-1", "1e3", "1;drop table x", "9223372036854775808", "01"])
    assert.throws(() => activityCursor(value), /Invalid activity cursor/);
});

test("durable feed deduplicates retried writes and resumes every page without dropping events", async () => {
  const pg = new PGlite({ parsers: { 20: Number } });
  await pg.waitReady;
  try {
    await pg.exec(
      await readFile(
        new URL("../../../migrations/0016_sniper_activity.sql", import.meta.url),
        "utf8",
      ),
    );
    const sql: ActivitySql = {
      query: async <T>(text: string, params: unknown[] = []) =>
        (await pg.query<T>(text, params)).rows,
    };
    const draft = (i: number): ActivityDraft => ({
      key: `event-${i}`,
      session: "paper-sniper-v1",
      at: T + i,
      kind: "SCAN",
      detail: { checked: i },
    });
    await writeSniperActivity(sql, [draft(1)]);
    const initial = await activityPage(sql);
    assert.equal(initial.events.length, 1);
    assert.equal(typeof initial.events[0].id, "string");
    await writeSniperActivity(sql, [draft(1)]);
    await writeSniperActivity(
      sql,
      Array.from({ length: 305 }, (_, i) => draft(i + 2)),
    );
    const received = [];
    let cursor = initial.cursor;
    do {
      const page = await activityPage(sql, cursor);
      received.push(...page.events);
      cursor = page.cursor;
      if (!page.hasMore) break;
    } while (true);
    assert.equal(received.length, 305);
    assert.equal(new Set(received.map((e) => e.key)).size, 305);
    assert.equal(received[0].key, "event-2");
    assert.equal(received.at(-1)!.key, "event-306");
    assert.equal((await activityPage(sql, cursor)).events.length, 0);
    const latest = await activityPage(sql);
    assert.equal(latest.events.length, 150);
    assert.equal(latest.events.at(-1)!.key, "event-306");
    const transaction = pg.transaction(async (tx) => {
      await tx.query(
        "insert into paper_sniper_activity(event_key,session_id,at_ms,kind) values('rolled-back','paper-sniper-v1',1,'BUY')",
      );
      throw Error("rollback");
    });
    await assert.rejects(transaction, /rollback/);
    assert.equal((await activityPage(sql, cursor)).events.length, 0);
  } finally {
    await pg.close();
  }
});
