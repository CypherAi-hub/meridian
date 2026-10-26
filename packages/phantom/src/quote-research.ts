import { randomUUID } from "node:crypto";
import { WSOL, json, type ChainEvent } from "./types.ts";
import type { QuoteProvider } from "./paper.ts";
import type { Quote } from "./execution.ts";
import type { Store } from "./store.ts";

export const RESEARCH_HORIZONS_MS = [30_000, 60_000, 180_000] as const;
export const RESEARCH_WATCH_STATE_KEY = "quote-research-horizons-v1";
const MAX_WATCHES = 10,
  MAX_EPISODE_AGE_MS = 600_000,
  MAX_QUOTE_AGE_MS = 5_000,
  BASELINE_INTERVAL_MS = 90_000;
type Horizon = { horizonMs: number; targetAt: number; done: boolean };
type Episode = {
  id: string;
  mint: string;
  signature: string;
  slot: number;
  eventObservedAt: number;
  baselineAt: number;
  amountLamports: string;
  quantityRaw: string;
  buy: Quote;
  horizons: Horizon[];
};
type CollectorState = {
  version: 1;
  lastProviderSampleAt: number;
  lastBaselineSampleAt: number;
  episodes: Episode[];
};
const raw = (value: string) => {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw Error("RESEARCH_AMOUNT_INVALID");
  const amount = BigInt(value);
  if (amount <= 0n || amount > 18_446_744_073_709_551_615n)
    throw Error("RESEARCH_AMOUNT_OUTSIDE_U64");
  return amount;
};
function quoteAge(q: Quote | undefined, now: number) {
  return q && Number.isFinite(q.observedAt) ? now - q.observedAt : null;
}
function freshness(q: Quote | undefined, now: number) {
  const age = quoteAge(q, now);
  return age === null
    ? "NO_QUOTE"
    : age < 0
      ? "FUTURE"
      : age > MAX_QUOTE_AGE_MS
        ? "STALE"
        : "FRESH";
}
function validate(q: Quote, inputMint: string, outputMint: string, amount: bigint, now: number) {
  if (
    q.inputMint !== inputMint ||
    q.outputMint !== outputMint ||
    raw(q.inAmount) !== amount ||
    raw(q.minOutAmount) > raw(q.outAmount)
  )
    throw Error("RESEARCH_QUOTE_SIZE_OR_MINT_MISMATCH");
  if (freshness(q, now) !== "FRESH") throw Error("RESEARCH_QUOTE_STALE_OR_FUTURE");
}
function publicError(error: unknown) {
  return error instanceof Error && /^[A-Z_0-9]+$/.test(error.message)
    ? error.message
    : "RESEARCH_QUOTE_PROVIDER_UNAVAILABLE";
}

/** Low-priority quote observations only. Never creates an order, signs, or spends funds. */
export class QuoteResearchCollector {
  private active: Promise<void> | null = null;
  private state: CollectorState = {
    version: 1,
    lastProviderSampleAt: 0,
    lastBaselineSampleAt: 0,
    episodes: [],
  };
  private initialized = false;
  private initialization: Promise<void> | null = null;
  constructor(
    private store: Store,
    private intervalMs = 30_000,
  ) {
    if (!Number.isInteger(intervalMs) || intervalMs < 30_000)
      throw Error("RESEARCH_QUOTE_RATE_TOO_HIGH");
  }
  async initialize() {
    if (this.initialized) return;
    if (this.initialization) return this.initialization;
    this.initialization = (async () => {
      const saved = await this.store.get(RESEARCH_WATCH_STATE_KEY);
      if (saved) {
        if (
          saved.version !== 1 ||
          !Number.isFinite(saved.lastProviderSampleAt) ||
          saved.lastProviderSampleAt < 0 ||
          !Array.isArray(saved.episodes) ||
          saved.episodes.length > MAX_WATCHES
        )
          throw Error("RESEARCH_WATCH_STATE_INVALID");
        const ids = new Set<string>();
        for (const e of saved.episodes as Episode[]) {
          if (
            !e.id ||
            ids.has(e.id) ||
            !e.mint ||
            !e.signature ||
            !Number.isSafeInteger(e.slot) ||
            e.slot < 0 ||
            !Number.isFinite(e.eventObservedAt) ||
            !Number.isFinite(e.baselineAt) ||
            e.baselineAt < 0 ||
            !Array.isArray(e.horizons) ||
            e.horizons.length !== 3
          )
            throw Error("RESEARCH_EPISODE_STATE_INVALID");
          ids.add(e.id);
          raw(e.amountLamports);
          raw(e.quantityRaw);
          if (
            e.buy.inputMint !== WSOL ||
            e.buy.outputMint !== e.mint ||
            e.buy.inAmount !== e.amountLamports ||
            e.buy.minOutAmount !== e.quantityRaw ||
            e.buy.observedAt !== e.baselineAt
          )
            throw Error("RESEARCH_BASELINE_STATE_INVALID");
          for (const [i, h] of e.horizons.entries())
            if (
              h.horizonMs !== RESEARCH_HORIZONS_MS[i] ||
              h.targetAt !== e.baselineAt + h.horizonMs ||
              typeof h.done !== "boolean"
            )
              throw Error("RESEARCH_HORIZON_STATE_INVALID");
        }
        const lastBaseline =
          saved.lastBaselineSampleAt ??
          Math.max(0, ...saved.episodes.map((e: Episode) => e.baselineAt));
        if (!Number.isFinite(lastBaseline) || lastBaseline < 0)
          throw Error("RESEARCH_BASELINE_BUDGET_STATE_INVALID");
        this.state = { ...structuredClone(saved), lastBaselineSampleAt: lastBaseline };
      }
      this.initialized = true;
    })().finally(() => {
      this.initialization = null;
    });
    return this.initialization;
  }
  private async persist() {
    await this.store.save(RESEARCH_WATCH_STATE_KEY, this.state);
  }
  private eligible(now: number) {
    return (
      !this.state.lastProviderSampleAt || now - this.state.lastProviderSampleAt >= this.intervalMs
    );
  }
  private due(now: number) {
    return this.state.episodes
      .flatMap((e) => e.horizons.filter((h) => !h.done && h.targetAt <= now).map((h) => ({ e, h })))
      .sort((a, b) => a.h.targetAt - b.h.targetAt || a.e.id.localeCompare(b.e.id))[0];
  }
  private prune() {
    this.state.episodes = this.state.episodes.filter((e) => e.horizons.some((h) => !h.done));
  }
  private start(work: () => Promise<void>) {
    if (this.active) return;
    const active = work();
    this.active = active.finally(() => {
      this.active = null;
    });
    return this.active;
  }
  /** Existing baseline sampling API. Due horizons take priority over adding new watches. */
  sample(event: ChainEvent, provider: QuoteProvider, amount = 10_000_000n) {
    if (this.active || event.mint === WSOL || event.quoteMint !== WSOL) return;
    return this.start(async () => {
      await this.initialize();
      const now = Date.now();
      this.prune();
      if (
        this.due(now) ||
        this.state.episodes.length >= MAX_WATCHES ||
        this.state.episodes.some((e) => e.mint === event.mint) ||
        !this.eligible(now) ||
        (this.state.lastBaselineSampleAt &&
          now - this.state.lastBaselineSampleAt < BASELINE_INTERVAL_MS)
      )
        return;
      raw(amount.toString());
      this.state.lastBaselineSampleAt = now;
      await this.reserve(now);
      await this.collectBaseline(event, provider, amount);
    });
  }
  /** Process one due horizon per call, using the original hypothetical baseline quantity. */
  async tick(provider: QuoteProvider): Promise<void> {
    if (this.active) return;
    await this.start(async () => {
      await this.initialize();
      const now = Date.now(),
        next = this.due(now);
      if (!next) return;
      const id = `${next.e.id}:horizon:${next.h.horizonMs}`;
      const existing = await this.store.query(
        "SELECT payload FROM phantom_quote_research WHERE id=$1",
        [id],
      );
      if (existing.length) {
        next.h.done = true;
        this.prune();
        await this.persist();
        return;
      }
      if (now - next.e.baselineAt > MAX_EPISODE_AGE_MS) {
        await this.collectHorizon(next.e, next.h, provider, true);
        return;
      }
      if (!this.eligible(now)) return;
      await this.reserve(now);
      await this.collectHorizon(next.e, next.h, provider, false);
    });
  }
  private async reserve(now: number) {
    this.state.lastProviderSampleAt = now;
    await this.persist();
  }
  private async write(payload: Record<string, unknown>) {
    await this.store.exec(
      "INSERT INTO phantom_quote_research(id,at,payload) VALUES($1,$2,$3::jsonb) ON CONFLICT(id) DO NOTHING",
      [payload.id, Date.now(), json(payload)],
    );
  }
  private async collectBaseline(event: ChainEvent, provider: QuoteProvider, amount: bigint) {
    const startedAt = Date.now();
    let buy: Quote | undefined, sell: Quote | undefined;
    let error: string | undefined,
      buyVerified = false;
    try {
      buy = await provider.quote({
        inputMint: WSOL,
        outputMint: event.mint,
        amount,
        slippageBps: 100,
      });
      validate(buy, WSOL, event.mint, amount, Date.now());
      buyVerified = true;
      sell = await provider.quote({
        inputMint: event.mint,
        outputMint: WSOL,
        amount: raw(buy.minOutAmount),
        slippageBps: 100,
      });
      validate(sell, event.mint, WSOL, raw(buy.minOutAmount), Date.now());
    } catch (e) {
      error = publicError(e);
    }
    const observedAt = Date.now(),
      buyFresh = freshness(buy, observedAt),
      sellFresh = freshness(sell, observedAt);
    if (!error && (buyFresh !== "FRESH" || sellFresh !== "FRESH"))
      error = "RESEARCH_BASELINE_QUOTES_NOT_JOINTLY_FRESH";
    const baselineEligible = !!buy && buyVerified;
    const id = randomUUID();
    const payload: Record<string, unknown> = {
      id,
      phase: "BASELINE",
      mint: event.mint,
      signature: event.signature,
      slot: event.slot,
      eventObservedAt: event.receivedAt,
      startedAt,
      scope: "RESEARCH_QUOTE_ONLY_NO_TRADE",
      amountLamports: amount.toString(),
      modeledNetworkFeesLamports: "20000",
      slippageBpsPerLeg: 100,
      observedAt,
      completedAt: observedAt,
      latencyMs: observedAt - startedAt,
      baselineEligibleForHorizons: baselineEligible,
      quoteFreshness: {
        buy: buyFresh,
        sell: sellFresh,
        buyAgeMs: quoteAge(buy, observedAt),
        sellAgeMs: quoteAge(sell, observedAt),
      },
      ...(buy && buyVerified ? { buy } : {}),
    };
    if (!error && buy && sell) {
      Object.assign(payload, {
        status: "QUOTED",
        sell,
        conservativeRoundTripNetLamports: (raw(sell.minOutAmount) - amount - 20_000n).toString(),
        conservativeRoundTripCostBps: Number(
          ((amount + 20_000n - raw(sell.minOutAmount)) * 10_000n) / amount,
        ),
        assumptions:
          "Two sequential exact-size quotes; configured min-outs include slippage, venue fees are embedded, network fees modeled once per leg. No fill, position, or return forecast.",
      });
    } else
      Object.assign(payload, {
        status: "UNAVAILABLE",
        error: error ?? "RESEARCH_BASELINE_UNAVAILABLE",
      });
    await this.write(payload);
    if (baselineEligible && buy) {
      const e: Episode = {
        id,
        mint: event.mint,
        signature: event.signature,
        slot: event.slot,
        eventObservedAt: event.receivedAt,
        baselineAt: buy.observedAt,
        amountLamports: amount.toString(),
        quantityRaw: buy.minOutAmount,
        buy: structuredClone(buy),
        horizons: RESEARCH_HORIZONS_MS.map((horizonMs) => ({
          horizonMs,
          targetAt: buy!.observedAt + horizonMs,
          done: false,
        })),
      };
      this.state.episodes.push(e);
      await this.persist();
    }
  }
  private async collectHorizon(e: Episode, h: Horizon, provider: QuoteProvider, expired: boolean) {
    const startedAt = Date.now();
    let sell: Quote | undefined, error: string | undefined;
    if (expired) error = "HORIZON_EXPIRED_NO_OBSERVATION";
    else
      try {
        sell = await provider.quote({
          inputMint: e.mint,
          outputMint: WSOL,
          amount: raw(e.quantityRaw),
          slippageBps: 100,
        });
        validate(sell, e.mint, WSOL, raw(e.quantityRaw), Date.now());
        if (sell.observedAt < h.targetAt) throw Error("HORIZON_QUOTE_PRECEDES_TARGET");
      } catch (err) {
        error = publicError(err);
      }
    const observedAt = Date.now();
    const payload: Record<string, unknown> = {
      id: `${e.id}:horizon:${h.horizonMs}`,
      episodeId: e.id,
      phase: "HORIZON",
      mint: e.mint,
      signature: e.signature,
      slot: e.slot,
      eventObservedAt: e.eventObservedAt,
      startedAt,
      baselineAt: e.baselineAt,
      baselineBuy: e.buy,
      amountLamports: e.amountLamports,
      hypotheticalTokenQuantityRaw: e.quantityRaw,
      horizonMs: h.horizonMs,
      targetAt: h.targetAt,
      observedAt,
      delayPastTargetMs: Math.max(0, observedAt - h.targetAt),
      scope: "RESEARCH_QUOTE_ONLY_NO_TRADE",
      modeledNetworkFeesLamports: "20000",
      slippageBpsPerLeg: 100,
      completedAt: observedAt,
      latencyMs: observedAt - startedAt,
      quoteFreshness: { sell: freshness(sell, observedAt), sellAgeMs: quoteAge(sell, observedAt) },
      assumptions:
        "Quote-only hypothetical exit for the original baseline min-output quantity; no order or fill occurred. Baseline and exit venue fees/slippage are embedded; network fees modeled once per leg. Delayed or missing horizon observations remain explicit and are not backdated.",
    };
    if (!error && sell) {
      const net = raw(sell.minOutAmount) - raw(e.amountLamports) - 20_000n;
      Object.assign(payload, {
        status: "QUOTED",
        sell,
        hypotheticalHorizonNetLamports: net.toString(),
        hypotheticalHorizonReturnBps: Number((net * 10_000n) / raw(e.amountLamports)),
      });
    } else
      Object.assign(payload, {
        status: "UNAVAILABLE",
        error: error ?? "HORIZON_QUOTE_UNAVAILABLE",
      });
    await this.write(payload);
    h.done = true;
    this.prune();
    await this.persist();
  }
  async idle() {
    await this.active;
  }
}
