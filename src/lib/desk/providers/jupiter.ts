import { USDC, WSOL, type QuoteObs } from "../schema";
import { blankQuote } from "./normalize";
import { breakerFor } from "../circuit";
import { classifyRouteFailure, routeStateFromFailure } from "../routes";

type JupQuote = {
  inAmount?: string;
  outAmount?: string;
  priceImpactPct?: string | number;
  routePlan?: { swapInfo?: { label?: string } }[];
  error?: string;
};

const ENDPOINTS = [
  "https://lite-api.jup.ag/swap/v1/quote",
  "https://public.jupiterapi.com/quote",
  "https://quote-api.jup.ag/v6/quote",
];

function impactOf(body: JupQuote) {
  if (body.priceImpactPct == null) return null;
  const n = Number(body.priceImpactPct);
  if (!Number.isFinite(n)) return null;
  return n > 1 ? n / 100 : n;
}

function impliedPrice(opts: {
  inMint: string;
  outMint: string;
  inAmount: string;
  outAmount: string;
  inDecimals: number;
  outDecimals: number;
  solPriceUsd: number;
}): number | null {
  const inn = Number(opts.inAmount);
  const out = Number(opts.outAmount);
  if (!inn || !out) return null;
  const inUi = inn / 10 ** opts.inDecimals;
  const outUi = out / 10 ** opts.outDecimals;
  if (opts.inMint === WSOL) {
    const usdIn = inUi * opts.solPriceUsd;
    return usdIn / outUi;
  }
  if (opts.outMint === WSOL) {
    const usdOut = outUi * opts.solPriceUsd;
    return usdOut / inUi;
  }
  return null;
}

function failedQuote(
  opts: { inputMint: string; outputMint: string; amount: string; notionalUsd: number },
  message: string,
  latencyMs: number,
  httpStatus?: number,
): QuoteObs {
  const reason = classifyRouteFailure(message, httpStatus);
  const state = routeStateFromFailure(reason);
  const q = blankQuote(opts.inputMint, opts.outputMint, opts.amount, opts.notionalUsd, message, latencyMs);
  q.available = false;
  q.routeState = state;
  q.failureReason = reason;
  q.error = message;
  return q;
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
  const circuit = breakerFor("jupiter");
  if (!circuit.canCall()) {
    return failedQuote(opts, "circuit open", 0);
  }
  let last = "quote failed";
  let lastStatus: number | undefined;
  for (const base of ENDPOINTS) {
    const url = `${base}?inputMint=${opts.inputMint}&outputMint=${opts.outputMint}&amount=${opts.amount}&slippageBps=50`;
    try {
      const r = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(7000),
      });
      const latencyMs = Date.now() - t0;
      const eventTime = Date.now();
      if (!r.ok) {
        last = `http ${r.status}`;
        lastStatus = r.status;
        if (r.status === 429) {
          circuit.failure("rate limit");
          return failedQuote(opts, last, latencyMs, r.status);
        }
        continue;
      }
      const body = (await r.json()) as JupQuote;
      const labels = (body.routePlan ?? []).map((x) => x.swapInfo?.label).filter((x): x is string => Boolean(x));
      const inAmount = body.inAmount ?? opts.amount;
      const outAmount = body.outAmount ?? "0";
      const ok = Boolean(outAmount && Number(outAmount) > 0);
      if (!ok) {
        circuit.failure("no route");
        return failedQuote(opts, body.error ?? "no route", latencyMs);
      }
      circuit.success();
      return {
        available: true,
        inMint: opts.inputMint,
        outMint: opts.outputMint,
        inAmount,
        outAmount,
        notionalUsd: opts.notionalUsd,
        priceImpactPct: impactOf(body),
        impliedPriceUsd: impliedPrice({
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
        routeState: "ROUTABLE",
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

  const [buy, sell] = await Promise.all([
    quoteOnce({
      inputMint: WSOL,
      outputMint: opts.mint,
      amount: String(solLamports),
      inDecimals: 9,
      outDecimals: opts.decimals,
      solPriceUsd: opts.solPriceUsd,
      notionalUsd: opts.notionalUsd,
    }),
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
      : Promise.resolve(failedQuote({ inputMint: opts.mint, outputMint: WSOL, amount: "0", notionalUsd: opts.notionalUsd }, "no token size", 0)),
  ]);

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
