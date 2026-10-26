import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/api/state/route";
const fixture = {
  mode: "PAPER",
  startedAt: 0,
  now: 100,
  health: {
    status: "fixture",
    source: "synthetic-unit-fixture",
    received: 0,
    decoded: 0,
    rejected: 0,
    errors: 0,
    lastEventAt: null,
    latencyMs: { p50: null, p95: null },
  },
  events: [],
  decisions: [],
  positions: [],
  trades: [],
  equity: [],
  cashLamports: "100",
  limitations: [],
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("read-only local dashboard proxy", () => {
  it("strips unknown configuration and secret properties from engine state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ...fixture,
          rpcSecret: "fixture-secret",
          health: { ...fixture.health, credential: "fixture-secret" },
        }),
      ),
    );
    const response = await GET();
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.rpcSecret).toBeUndefined();
    expect(json.health.credential).toBeUndefined();
  });
  it("rejects remote destinations before fetching", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("PHANTOM_ENGINE_URL", "https://example.com");
    expect((await GET()).status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects non-paper and malformed state instead of showing fabricated values", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ...fixture, mode: "LIVE" })),
    );
    expect((await GET()).status).toBe(503);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ...fixture, cashLamports: "NaN" })),
    );
    expect((await GET()).status).toBe(503);
  });
  it("accepts unknown transaction amounts as null rather than inventing values", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ...fixture,
          events: [
            {
              id: "fixture",
              protocol: "pump",
              kind: "launch",
              signature: "1".repeat(64),
              slot: 1,
              mint: "fixture",
              actor: "fixture",
              receivedAt: 0,
              processedAt: 0,
              commitment: "finalized",
              amountRaw: null,
              quoteAmountRaw: null,
            },
          ],
        }),
      ),
    );
    const response = await GET();
    expect(response.status).toBe(200);
    expect((await response.json()).events[0].amountRaw).toBeNull();
  });
  it("retains provider errors and unknown inventory marks without zero coercion", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ...fixture,
          health: {
            ...fixture.health,
            lastError: "RPC_RATE_LIMIT",
            queueDepth: 2,
            backfillGaps: 1,
          },
          equity: [{ at: 100, equityLamports: null }],
        }),
      ),
    );
    const response = await GET();
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.equity[0].equityLamports).toBeNull();
    expect(data.health.lastError).toBe("RPC_RATE_LIMIT");
    expect(data.health.backfillGaps).toBe(1);
  });
  it("preserves explicit typed event verification and separately measured feed latency", async () => {
    const event = {
      id: "fixture",
      protocol: "pump",
      kind: "buy",
      signature: "1".repeat(64),
      slot: 1,
      mint: "fixture",
      actor: "fixture",
      receivedAt: 0,
      processedAt: 1,
      commitment: "confirmed",
      amountRaw: null,
      quoteAmountRaw: null,
      verification: "TYPED_PROGRAM_EVENT",
      fullTransactionVerified: false,
      eventSchema: "fixture-hash",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ...fixture,
          events: [event],
          completedPositions: [],
          health: {
            ...fixture.health,
            typedObserved: 1,
            typedLogs: {
              received: 2,
              processed: 1,
              dropped: 1,
              errors: 0,
              queueDepth: 0,
              latencyMs: { p50: 1, p95: 1 },
            },
          },
        }),
      ),
    );
    const response = await GET();
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.events[0].verification).toBe("TYPED_PROGRAM_EVENT");
    expect(data.events[0].fullTransactionVerified).toBe(false);
    expect(data.health.typedLogs.latencyMs.p95).toBe(1);
    expect(data.completedPositions).toEqual([]);
  });
});
