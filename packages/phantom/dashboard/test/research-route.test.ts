import { afterEach, describe, it, expect, vi } from "vitest";
import { GET } from "../app/api/research/route";
const unavailable = {
  id: "fixture",
  mint: "fixture",
  signature: "1".repeat(64),
  slot: 1,
  eventObservedAt: 0,
  startedAt: 1,
  scope: "RESEARCH_QUOTE_ONLY_NO_TRADE",
  amountLamports: "10000000",
  modeledNetworkFeesLamports: "20000",
  slippageBpsPerLeg: 100,
  status: "UNAVAILABLE",
  error: "SYNTHETIC_TEST_ERROR",
  completedAt: 2,
  latencyMs: 1,
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("persisted quote research proxy", () => {
  it("reads only the engine research endpoint and strips extra fields", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        observations: [{ ...unavailable, apiKey: "synthetic-secret" }],
        providerConfig: "synthetic-secret",
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const response = await GET();
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.observations[0].apiKey).toBeUndefined();
    expect(data.providerConfig).toBeUndefined();
    expect(String(fetch.mock.calls[0]?.[0])).toBe("http://127.0.0.1:8790/quote-research");
  });
  it("rejects malformed quote cost records rather than inventing samples", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          observations: [{ ...unavailable, status: "QUOTED", conservativeRoundTripCostBps: null }],
        }),
      ),
    );
    expect((await GET()).status).toBe(503);
  });
  it("cannot send requests to arbitrary external destinations", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("PHANTOM_ENGINE_URL", "https://external.invalid");
    expect((await GET()).status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("preserves quote-only horizon identity without inventing immediate baseline costs", async () => {
    const wsol = "So11111111111111111111111111111111111111112";
    const row = {
      ...unavailable,
      status: "QUOTED",
      phase: "HORIZON",
      episodeId: "fixture-episode",
      baselineAt: 1000,
      horizonMs: 30000,
      targetAt: 31000,
      observedAt: 32000,
      delayPastTargetMs: 1000,
      hypotheticalTokenQuantityRaw: "9900",
      baselineBuy: {
        inputMint: wsol,
        outputMint: "fixture",
        inAmount: "10000000",
        outAmount: "10000",
        minOutAmount: "9900",
        impactBps: 10,
        observedAt: 1000,
        contextSlot: null,
        route: ["SYNTHETIC_TEST_ROUTE"],
      },
      sell: {
        inputMint: "fixture",
        outputMint: wsol,
        inAmount: "9900",
        outAmount: "10100000",
        minOutAmount: "10090000",
        impactBps: 10,
        observedAt: 32000,
        contextSlot: null,
        route: ["SYNTHETIC_TEST_ROUTE"],
      },
      hypotheticalHorizonNetLamports: "70000",
      hypotheticalHorizonReturnBps: 70,
      assumptions: "Synthetic unit-test observations only",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ observations: [row] })),
    );
    const response = await GET();
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.observations[0].phase).toBe("HORIZON");
    expect(data.observations[0].conservativeRoundTripCostBps).toBeUndefined();
    expect(data.observations[0].hypotheticalHorizonNetLamports).toBe("70000");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ observations: [{ ...row, hypotheticalTokenQuantityRaw: "9800" }] }),
      ),
    );
    expect((await GET()).status).toBe(503);
  });
});
