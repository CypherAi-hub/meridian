/** Synthetic clocks/providers only. No real API key, network request, signing or submission. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JupiterQuoteClient, type QuotePriority } from "../src/execution.ts";
import { JupiterQuoteLane } from "../src/jupiter-quote-lane.ts";
const EPOCH = Date.UTC(2026, 9, 26);
const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(EPOCH);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
const result = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value, error: null }),
    (error) => ({ value: null, error: String(error.message) }),
  );
function data(url: string | URL | Request, output = 1000) {
  const params = new URL(String(url)).searchParams;
  return {
    inputMint: params.get("inputMint"),
    outputMint: params.get("outputMint"),
    inAmount: params.get("amount"),
    outAmount: String(output),
    otherAmountThreshold: String(Math.floor(output * 0.99)),
    priceImpact: -0.1,
    router: "SYNTHETIC_ROUTE",
  };
}
const response = (url: string | URL | Request, headers?: HeadersInit, output?: number) =>
  Response.json(data(url, output), { headers });
const quote = (client: JupiterQuoteClient, amount = 1, priority?: QuotePriority) =>
  result(client.quote({ inputMint: SOL, outputMint: USDC, amount: BigInt(amount), priority }));

describe("bounded local Jupiter quote pacing", () => {
  it("spaces request starts, serializes slow fetches and records actual request/response times", async () => {
    const starts: number[] = [];
    let active = 0,
      maximumActive = 0,
      release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      starts.push(Date.now());
      maximumActive = Math.max(maximumActive, ++active);
      if (starts.length === 1) await gate;
      active--;
      return response(url);
    });
    const client = new JupiterQuoteClient({
      apiKey: "synthetic",
      fetch: fetcher,
      timeoutMs: 10000,
    });
    const a = quote(client, 1),
      b = quote(client, 2),
      c = quote(client, 3);
    await vi.advanceTimersByTimeAsync(1200);
    expect(starts).toEqual([EPOCH]);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toEqual([EPOCH, EPOCH + 1200]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(starts).toEqual([EPOCH, EPOCH + 1200, EPOCH + 2200]);
    expect(maximumActive).toBe(1);
    expect((await a).value).toMatchObject({ requestedAt: EPOCH, observedAt: EPOCH + 1200 });
    expect((await b).value).toMatchObject({ requestedAt: EPOCH + 1200, observedAt: EPOCH + 1200 });
    expect((await c).value!.requestedAt).toBe(EPOCH + 2200);
  });
  it("admits protective exits by evicting pending lower priorities while preserving active and FIFO peers", async () => {
    const starts: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetcher = vi.fn<typeof fetch>(async (url, options) => {
      starts.push(Number(new URL(String(url)).searchParams.get("amount")));
      if (starts.length === 1) {
        await gate;
        expect(options!.signal!.aborted).toBe(false);
      }
      return response(url);
    });
    const client = new JupiterQuoteClient({
      apiKey: "synthetic",
      fetch: fetcher,
      maxPending: 2,
      timeoutMs: 10000,
    });
    const active = quote(client, 1),
      low1 = quote(client, 2),
      low2 = quote(client, 3);
    const protective1 = quote(client, 4, "protective_exit"),
      entry = quote(client, 5, "entry");
    const research = quote(client, 6, "research"),
      protective2 = quote(client, 7, "protective_exit"),
      peer = quote(client, 8, "protective_exit");
    expect((await low1).error).toBe("JUPITER_QUOTE_QUEUE_EVICTED_FOR_HIGHER_PRIORITY");
    expect((await low2).error).toBe("JUPITER_QUOTE_QUEUE_EVICTED_FOR_HIGHER_PRIORITY");
    expect((await entry).error).toBe("JUPITER_QUOTE_QUEUE_EVICTED_FOR_HIGHER_PRIORITY");
    expect((await research).error).toBe("JUPITER_QUOTE_QUEUE_FULL");
    expect((await peer).error).toBe("JUPITER_QUOTE_QUEUE_FULL");
    release();
    await vi.advanceTimersByTimeAsync(2000);
    expect(starts).toEqual([1, 4, 7]);
    expect((await active).error).toBeNull();
    expect((await protective1).error).toBeNull();
    expect((await protective2).error).toBeNull();
  });
  it("orders protective_exit, entry, research and analysis without reversing equal research callers", async () => {
    const starts: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      starts.push(Number(new URL(String(url)).searchParams.get("amount")));
      if (starts.length === 1) await gate;
      return response(url);
    });
    const client = new JupiterQuoteClient({
      apiKey: "synthetic",
      fetch: fetcher,
      timeoutMs: 10000,
    });
    const jobs = [
      quote(client, 1),
      quote(client, 2),
      quote(client, 3, "research"),
      quote(client, 4, "research"),
      quote(client, 5, "entry"),
      quote(client, 6, "protective_exit"),
    ];
    release();
    await vi.advanceTimersByTimeAsync(5000);
    expect(starts).toEqual([1, 6, 5, 3, 4, 2]);
    expect((await Promise.all(jobs)).every((job) => job.error === null)).toBe(true);
  });
  it("expires a queued request within its original timeout and never sends it later", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => response(url));
    const client = new JupiterQuoteClient({ apiKey: "synthetic", fetch: fetcher, timeoutMs: 500 });
    expect((await quote(client)).error).toBeNull();
    const waiting = quote(client, 2);
    await vi.advanceTimersByTimeAsync(500);
    expect((await waiting).error).toBe("JUPITER_QUOTE_QUEUE_TIMEOUT");
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("charges queue waiting against the active request deadline instead of restarting its timeout", async () => {
    let abortAt: number | null = null;
    const fetcher = vi.fn<typeof fetch>(async (url, options) => {
      if (fetcher.mock.calls.length === 1) return response(url);
      return new Promise((_resolve, reject) =>
        options!.signal!.addEventListener("abort", () => {
          abortAt = Date.now();
          reject(Error("SYNTHETIC_ABORT"));
        }),
      );
    });
    const client = new JupiterQuoteClient({ apiKey: "synthetic", fetch: fetcher, timeoutMs: 1500 });
    await quote(client);
    const waiting = quote(client, 2);
    await vi.advanceTimersByTimeAsync(1500);
    expect((await waiting).error).toBe("JUPITER_QUOTE_TIMEOUT");
    expect(abortAt).toBe(EPOCH + 1500); // Started at1000 with only500ms remaining.
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("does not start queued work exactly at its expired deadline", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => response(url));
    const client = new JupiterQuoteClient({ apiKey: "synthetic", fetch: fetcher, timeoutMs: 1000 });
    await quote(client);
    const pending = quote(client, 2);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await pending).error).toBe("JUPITER_QUOTE_QUEUE_TIMEOUT");
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("rejects a late completion even when the event loop has not delivered its timeout callback", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      vi.setSystemTime(EPOCH + 1000);
      return response(url);
    });
    const client = new JupiterQuoteClient({ apiKey: "synthetic", fetch: fetcher, timeoutMs: 1000 });
    expect((await quote(client)).error).toBe("JUPITER_QUOTE_TIMEOUT");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("aborts a provider at the deadline and sanitizes its abort exception", async () => {
    let signal: AbortSignal | undefined;
    const fetcher = vi.fn<typeof fetch>(async (_url, options) => {
      signal = options!.signal!;
      return new Promise((_resolve, reject) =>
        signal!.addEventListener("abort", () => reject(Error("SECRET_KEY_AND_PRIVATE_URL"))),
      );
    });
    const client = new JupiterQuoteClient({ apiKey: "synthetic", fetch: fetcher, timeoutMs: 50 });
    const pending = quote(client);
    await vi.advanceTimersByTimeAsync(50);
    expect(signal!.aborted).toBe(true);
    expect((await pending).error).toBe("JUPITER_QUOTE_TIMEOUT");
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("never overlaps an uncooperative timed-out fetch, and cannot turn its late response into success", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      if (fetcher.mock.calls.length === 1) await gate;
      return response(url);
    });
    const client = new JupiterQuoteClient({ apiKey: "synthetic", fetch: fetcher, timeoutMs: 500 });
    const active = quote(client);
    await vi.advanceTimersByTimeAsync(600);
    expect((await active).error).toBe("JUPITER_QUOTE_TIMEOUT");
    const protective = quote(client, 2, "protective_exit");
    await vi.advanceTimersByTimeAsync(500);
    expect((await protective).error).toBe("JUPITER_QUOTE_QUEUE_TIMEOUT");
    expect(fetcher).toHaveBeenCalledOnce();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect((await active).value).toBeNull();
    expect((await quote(client, 3)).error).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("includes response-body parsing in serialization and the total deadline", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      const value = response(url);
      value.json = async () => {
        await gate;
        return data(url);
      };
      return value;
    });
    const client = new JupiterQuoteClient({ apiKey: "synthetic", fetch: fetcher, timeoutMs: 500 });
    const active = quote(client),
      waiting = quote(client, 2);
    await vi.advanceTimersByTimeAsync(500);
    expect((await active).error).toBe("JUPITER_QUOTE_TIMEOUT");
    expect((await waiting).error).toBe("JUPITER_QUOTE_QUEUE_TIMEOUT");
    expect(fetcher).toHaveBeenCalledOnce();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect((await active).value).toBeNull();
  });
  it("sends identical callers separately and returns fresh response data instead of reusing a quote", async () => {
    let replies = 0;
    const fetcher = vi.fn<typeof fetch>(async (url) => response(url, undefined, 1000 + ++replies));
    const client = new JupiterQuoteClient({ apiKey: "synthetic", fetch: fetcher });
    const first = await quote(client),
      next = quote(client);
    await vi.advanceTimersByTimeAsync(1000);
    const second = await next;
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(first.value!.outAmount).toBe("1001");
    expect(second.value!.outAmount).toBe("1002");
    expect(second.value!.requestedAt).toBe(EPOCH + 1000);
    const url = new URL(String(fetcher.mock.calls[1][0]));
    expect(url.pathname).toBe("/swap/v2/order");
    expect(url.searchParams.has("taker")).toBe(false);
    expect(url.searchParams.has("priority")).toBe(false);
  });
  it("can share one explicitly supplied lane between local clients", async () => {
    const lane = new JupiterQuoteLane(),
      starts: number[] = [];
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      starts.push(Date.now());
      return response(url);
    });
    const a = new JupiterQuoteClient({ apiKey: "synthetic-a", fetch: fetcher, lane });
    const b = new JupiterQuoteClient({ apiKey: "synthetic-b", fetch: fetcher, lane });
    const first = quote(a),
      second = quote(b);
    await vi.advanceTimersByTimeAsync(1000);
    expect(starts).toEqual([EPOCH, EPOCH + 1000]);
    expect((await first).error).toBeNull();
    expect((await second).error).toBeNull();
  });
});

describe("Jupiter signed remaining and absolute reset headers", () => {
  it("rounds fractional reset seconds up rather than sending before the declared instant", async () => {
    const starts: number[] = [];
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      starts.push(Date.now());
      return response(
        url,
        starts.length === 1
          ? { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(EPOCH / 1000 + 5.0005) }
          : {},
      );
    });
    const client = new JupiterQuoteClient({
      apiKey: "synthetic",
      fetch: fetcher,
      timeoutMs: 10000,
    });
    await quote(client);
    const waiting = quote(client, 2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(starts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await waiting).error).toBeNull();
    expect(starts).toEqual([EPOCH, EPOCH + 5001]);
  });
  it("backs off after429 until the absolute Unix-second reset without retrying the rejected caller", async () => {
    const starts: number[] = [];
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      starts.push(Date.now());
      return starts.length === 1
        ? new Response("SYNTHETIC_PRIVATE_BODY", {
            status: 429,
            headers: {
              "x-ratelimit-remaining": "-1",
              "x-ratelimit-reset": String((EPOCH + 5000) / 1000),
            },
          })
        : response(url);
    });
    const client = new JupiterQuoteClient({
      apiKey: "synthetic",
      fetch: fetcher,
      timeoutMs: 10000,
    });
    expect((await quote(client)).error).toBe("JUPITER_HTTP_429");
    const second = quote(client, 2);
    await vi.advanceTimersByTimeAsync(4999);
    expect(starts).toEqual([EPOCH]);
    await vi.advanceTimersByTimeAsync(1);
    expect((await second).error).toBeNull();
    expect(starts).toEqual([EPOCH, EPOCH + 5000]);
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each(["0", "-1", "+0"])(
    "honors an exhausted200 window with signed remaining=%s",
    async (remaining) => {
      const starts: number[] = [];
      const fetcher = vi.fn<typeof fetch>(async (url) => {
        starts.push(Date.now());
        return response(
          url,
          starts.length === 1
            ? {
                "x-ratelimit-remaining": remaining,
                "x-ratelimit-reset": String((EPOCH + 5000) / 1000),
              }
            : {},
        );
      });
      const client = new JupiterQuoteClient({
        apiKey: "synthetic",
        fetch: fetcher,
        timeoutMs: 10000,
      });
      await quote(client);
      const second = quote(client, 2);
      await vi.advanceTimersByTimeAsync(4999);
      expect(starts).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect((await second).error).toBeNull();
      expect(starts).toEqual([EPOCH, EPOCH + 5000]);
    },
  );
  it.each([
    [{}, 1000],
    [{ "x-ratelimit-reset": String((EPOCH + 5000) / 1000) }, 1000],
    [{ "x-ratelimit-remaining": "junk", "x-ratelimit-reset": String((EPOCH + 5000) / 1000) }, 1000],
    [{ "x-ratelimit-remaining": "0.0", "x-ratelimit-reset": String((EPOCH + 5000) / 1000) }, 1000],
    [{ "x-ratelimit-remaining": "1", "x-ratelimit-reset": String((EPOCH + 5000) / 1000) }, 1000],
    [{ "x-ratelimit-remaining": "0" }, 1200],
    [{ "x-ratelimit-remaining": "-2", "x-ratelimit-reset": "junk" }, 1200],
    [{ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "" }, 1200],
    [{ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "Infinity" }, 1200],
    [{ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "999999999999999999999" }, 1200],
    [{ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(EPOCH / 1000 - 1) }, 1000],
  ] as const)(
    "does not treat missing/malformed remaining as zero and uses1s only for unknown exhausted resets %#",
    async (headers, nextAt) => {
      const starts: number[] = [];
      const fetcher = vi.fn<typeof fetch>(async (url) => {
        starts.push(Date.now());
        if (starts.length === 1) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return response(url, headers);
        }
        return response(url);
      });
      const client = new JupiterQuoteClient({ apiKey: "synthetic", fetch: fetcher });
      const first = quote(client);
      await vi.advanceTimersByTimeAsync(200);
      expect((await first).error).toBeNull();
      const second = quote(client, 2);
      await vi.advanceTimersByTimeAsync(nextAt - 201);
      expect(starts).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect((await second).error).toBeNull();
      expect(starts[1]).toBe(EPOCH + nextAt);
    },
  );
  it.each([undefined, "junk", "-1", "NaN"])(
    "uses a1s429 fallback for malformed/absent reset=%s",
    async (reset) => {
      const starts: number[] = [];
      const fetcher = vi.fn<typeof fetch>(async (url) => {
        starts.push(Date.now());
        if (starts.length === 1) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return new Response("SYNTHETIC_PRIVATE_BODY", {
            status: 429,
            headers: reset === undefined ? {} : { "x-ratelimit-reset": reset },
          });
        }
        return response(url);
      });
      const client = new JupiterQuoteClient({ apiKey: "synthetic", fetch: fetcher });
      const first = quote(client);
      await vi.advanceTimersByTimeAsync(200);
      expect((await first).error).toBe("JUPITER_HTTP_429");
      const second = quote(client, 2);
      await vi.advanceTimersByTimeAsync(999);
      expect(starts).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect((await second).error).toBeNull();
      expect(starts[1]).toBe(EPOCH + 1200);
    },
  );
  it("lets pending deadlines expire during a long provider reset without a late fetch", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      response(url, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String((EPOCH + 100 * 86400000) / 1000),
      }),
    );
    const client = new JupiterQuoteClient({ apiKey: "synthetic", fetch: fetcher, timeoutMs: 5000 });
    await quote(client);
    const waiting = quote(client, 2);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await waiting).error).toBe("JUPITER_QUOTE_QUEUE_TIMEOUT");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("Jupiter unavailable errors are secret-safe", () => {
  it.each(["transport", "json", "lookalike-code"])(
    "sanitizes unknown %s failures without leaking body/key/URL",
    async (failure) => {
      const secret = "SYNTHETIC_PRIVATE_KEY_MATERIAL";
      const fetcher = vi.fn<typeof fetch>(async () => {
        if (failure === "transport") throw Error(`https://synthetic.invalid/?api-key=${secret}`);
        if (failure === "lookalike-code") throw Error(`JUPITER_HTTP_429 ${secret}`);
        return new Response(secret, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
      const client = new JupiterQuoteClient({ apiKey: secret, fetch: fetcher });
      const answer = await quote(client);
      expect(answer.error).toBe("JUPITER_QUOTE_PROVIDER_UNAVAILABLE");
      expect(answer.error).not.toContain(secret);
      expect(answer.error).not.toContain("https://");
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );
  it("rejects unsafe queue configuration and unknown priority without sending a request", async () => {
    expect(() => new JupiterQuoteLane({ minimumIntervalMs: 999 })).toThrow(
      "INVALID_JUPITER_QUOTE_LANE_OPTIONS",
    );
    expect(() => new JupiterQuoteLane({ maxPending: 0 })).toThrow(
      "INVALID_JUPITER_QUOTE_LANE_OPTIONS",
    );
    const fetcher = vi.fn<typeof fetch>(async (url) => response(url));
    const client = new JupiterQuoteClient({ apiKey: "synthetic", fetch: fetcher });
    const answer = await quote(client, 1, "unknown" as QuotePriority);
    expect(answer.error).toBe("JUPITER_INVALID_QUOTE_PRIORITY");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
