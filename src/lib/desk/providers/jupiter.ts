import { jupiterHeaders } from "../provider-headers";
import { USDC, WSOL, type QuoteObs } from "../schema";
import { blankQuote } from "./normalize";
import { breakerFor } from "../circuit";
import { classifyRouteFailure, routeStateFromFailure } from "../routes";
import { deskSettings } from "../config";
import { budgetFor, parseRetryAfter, JUPITER_KEYED_BUDGET } from "../rate-budget";
import { impliedQuotePrice } from "../quote-price.ts";

type JupQuote = {
  inputMint?: string;
  outputMint?: string;
  inAmount?: string;
  outAmount?: string;
  priceImpactPct?: string | number;
  routePlan?: { swapInfo?: { label?: string } }[];
  error?: string;
  errorCode?: number;
  errorMessage?: string;
};

const ENDPOINTS = ["https://api.jup.ag/swap/v1/quote"];

export const providerCounters = {
  jupiter429: 0,
  gecko429: 0,
};

type QuoteCacheEntry = { at: number; buy: QuoteObs; sell: QuoteObs };
const quoteCache = new Map<string, QuoteCacheEntry>();

export function cachedQuoteAge(mint: string): number | null {
  const hit = quoteCache.get(mint);
  return hit ? hit.at : null;
}

export function cachedQuote(mint: string): QuoteCacheEntry | null {
  return quoteCache.get(mint) ?? null;
}

function impactOf(body: JupQuote) {
  if (body.priceImpactPct == null) return null;
  const n = Number(body.priceImpactPct);
  if (!Number.isFinite(n)) return null;
  return n > 1 ? n / 100 : n;
}

function positiveRawU64(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[1-9]\d{0,19}$/.test(value) &&
    BigInt(value) <= 18446744073709551615n
  );
}

function failedQuote(
  opts: { inputMint: string; outputMint: string; amount: string; notionalUsd: number },
  message: string,
  latencyMs: number,
  httpStatus?: number,
): QuoteObs {
  const reason = classifyRouteFailure(message, httpStatus);
  const state = routeStateFromFailure(reason);
  const q = blankQuote(
    opts.inputMint,
    opts.outputMint,
    opts.amount,
    opts.notionalUsd,
    message,
    latencyMs,
  );
  q.available = false;
  q.routeState = state;
  q.failureReason = reason;
  q.error = message;
  return q;
}

export function skippedQuote(
  opts: { inputMint: string; outputMint: string; amount: string; notionalUsd: number },
  reason: string,
): QuoteObs {
  return failedQuote(opts, reason, 0);
}

async function quoteOnce(opts: {
  inputMint: string;
  outputMint: string;
  amount: string;
  inDecimals: number;
  outDecimals: number;
  solPriceUsd: number;
  notionalUsd: number;
}): Promise<QuoteObs> {
  const t0 = Date.now();
  const ingestedAt = t0;
  if (!positiveRawU64(opts.amount)) return failedQuote(opts, "invalid quote input amount", 0);
  const circuit = breakerFor("jupiter");
  const key = deskSettings().jupiterApiKey;
  const budget = budgetFor("jupiter", key ? JUPITER_KEYED_BUDGET : undefined);
  if (!circuit.canCall()) {
    return failedQuote(opts, "circuit open", 0);
  }
  if (!budget.take()) {
    return failedQuote(opts, "rate budget empty", 0);
  }
  let last = "quote failed";
  let lastStatus: number | undefined;
  const endpoints = ENDPOINTS;
  for (const base of endpoints) {
    const url = `${base}?inputMint=${opts.inputMint}&outputMint=${opts.outputMint}&amount=${opts.amount}&slippageBps=50`;
    try {
      const headers = jupiterHeaders(base, key);
      const r = await fetch(url, {
        headers,
        redirect: "error", // Never forward a custom credential through a redirect.
        signal: AbortSignal.timeout(7000),
      });
      const latencyMs = Date.now() - t0;
      const eventTime = Date.now();
      if (!r.ok) {
        last = `http ${r.status}`;
        lastStatus = r.status;
        if (r.status === 429) {
          providerCounters.jupiter429 += 1;
          circuit.failure("rate limit");
          budget.onRateLimit(parseRetryAfter(r.headers.get("retry-after")));
          return failedQuote(opts, last, latencyMs, r.status);
        }
        continue;
      }
      const body = (await r.json()) as JupQuote;
      if (body.inputMint !== opts.inputMint || body.outputMint !== opts.outputMint) {
        return failedQuote(opts, "quote token identity mismatch", latencyMs);
      }
      if (body.error || body.errorMessage || body.errorCode != null)
        return failedQuote(opts, "provider reported quote error", latencyMs);
      // Exact size must be confirmed by the response, never inferred from our request.
      if (!positiveRawU64(body.inAmount) || body.inAmount !== opts.amount)
        return failedQuote(opts, "quote input amount mismatch or missing", latencyMs);
      if (!positiveRawU64(body.outAmount))
        return failedQuote(opts, "invalid quote output amount", latencyMs);
      const inAmount = body.inAmount,
        outAmount = body.outAmount;
      const labels = (body.routePlan ?? [])
        .map((x) => x.swapInfo?.label)
        .filter((x): x is string => Boolean(x));
      circuit.success();
      budget.onSuccess();
      return {
        available: true,
        inMint: opts.inputMint,
        outMint: opts.outputMint,
        inAmount,
        outAmount,
        notionalUsd: opts.notionalUsd,
        priceImpactPct: impactOf(body),
        impliedPriceUsd: impliedQuotePrice({
          inMint: opts.inputMint,
          outMint: opts.outputMint,
          inAmount,
          outAmount,
          inDecimals: opts.inDecimals,
          outDecimals: opts.outDecimals,
          solPriceUsd: opts.solPriceUsd,
        }),
        routeLabels: labels,
        latencyMs,
        eventTime,
        ingestedAt,
        source: "jupiter",
        routeState: "QUOTE_ONLY",
        failureReason: null,
      };
    } catch (e) {
      last = e instanceof Error ? e.message : "quote failed";
    }
  }
  circuit.failure(last);
  return failedQuote(opts, last, Date.now() - t0, lastStatus);
}

export async function quoteToken(opts: {
  mint: string;
  decimals: number;
  priceUsd: number | null;
  solPriceUsd: number;
  notionalUsd: number;
}): Promise<{ buy: QuoteObs; sell: QuoteObs; lagMs: number }> {
  const t0 = Date.now();
  const solLamports = Math.max(
    1,
    Math.round((opts.notionalUsd / Math.max(opts.solPriceUsd, 1e-6)) * 1e9),
  );
  const tokenRaw =
    opts.priceUsd && opts.priceUsd > 0
      ? Math.max(1, Math.round((opts.notionalUsd / opts.priceUsd) * 10 ** opts.decimals))
      : 0;

  const sellP =
    tokenRaw > 0
      ? quoteOnce({
          inputMint: opts.mint,
          outputMint: WSOL,
          amount: String(tokenRaw),
          inDecimals: opts.decimals,
          outDecimals: 9,
          solPriceUsd: opts.solPriceUsd,
          notionalUsd: opts.notionalUsd,
        })
      : Promise.resolve(
          failedQuote(
            { inputMint: opts.mint, outputMint: WSOL, amount: "0", notionalUsd: opts.notionalUsd },
            "no token size",
            0,
          ),
        );
  const buyP = quoteOnce({
    inputMint: WSOL,
    outputMint: opts.mint,
    amount: String(solLamports),
    inDecimals: 9,
    outDecimals: opts.decimals,
    solPriceUsd: opts.solPriceUsd,
    notionalUsd: opts.notionalUsd,
  });
  const [sell, buy] = await Promise.all([sellP, buyP]);

  quoteCache.set(opts.mint, { at: Date.now(), buy, sell });
  return { buy, sell, lagMs: Date.now() - t0 };
}

export async function quoteSolUsdc(): Promise<QuoteObs> {
  return quoteOnce({
    inputMint: WSOL,
    outputMint: USDC,
    amount: "10000000",
    inDecimals: 9,
    outDecimals: 6,
    solPriceUsd: 1,
    notionalUsd: 1,
  });
}

/** Exact-size quote-only adapter for the independent paper sniper. Never builds a swap. */
export async function quotePaperSwap(opts: {
  inputMint: string;
  outputMint: string;
  amount: string;
  inDecimals: number;
  outDecimals: number;
  notionalUsd: number;
}): Promise<QuoteObs> {
  const q = await quoteOnce({ ...opts, solPriceUsd: 0 });
  // An exit's USDC quote amount is known; the original entry size is not its notional.
  if (q.available && opts.outputMint === USDC)
    q.notionalUsd = Number(q.outAmount) / 10 ** opts.outDecimals;
  return q;
}
