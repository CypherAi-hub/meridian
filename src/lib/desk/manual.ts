import { SNIPER_CONFIG, quoteValid, type QuoteAdapter, type SwapRequest } from "./sniper.ts";
import { USDC } from "./schema.ts";
import type { QuoteObs } from "./schema.ts";
export type ManualPosition = {
  mint: string;
  symbol: string;
  decimals: number;
  rawQty: string;
  costAtomic: string;
  openedAt: number;
  markAtomic?: string;
  markedAt?: number;
};
export type ManualOrder = {
  id: string;
  requestId: string;
  side: "BUY" | "SELL";
  mint: string;
  symbol: string;
  decimals: number;
  amountAtomic: string;
  createdAt: number;
  dueAt: number;
  status: "PENDING" | "FILLED" | "EXPIRED";
  percent?: number;
  error?: string;
  filledAt?: number;
  quote?: QuoteObs;
};
export type ManualFill = {
  id: string;
  orderId: string;
  side: "BUY" | "SELL";
  mint: string;
  symbol: string;
  at: number;
  rawQty: string;
  cashAtomic: string;
  costBasisAtomic: string;
  pnlAtomic: string;
  quote: QuoteObs;
};
export type ManualBook = {
  version: "omni-manual-v1";
  cashAtomic: string;
  initialCashAtomic: string;
  updatedAt: number;
  positions: ManualPosition[];
  orders: ManualOrder[];
  fills: ManualFill[];
  watchlist: string[];
  selectedMint: string | null;
  markCursor: number;
};
export function newManualBook(now: number): ManualBook {
  return {
    version: "omni-manual-v1",
    cashAtomic: "1000000000",
    initialCashAtomic: "1000000000",
    updatedAt: now,
    positions: [],
    orders: [],
    fills: [],
    watchlist: [],
    selectedMint: null,
    markCursor: 0,
  };
}
export function usdAtomic(value: string): string {
  if (!/^(?:0|[1-9]\d{0,5})(?:\.\d{1,6})?$/.test(value))
    throw Error("Enter a plain USDC amount with at most six decimals");
  const [whole, fraction = ""] = value.split(".");
  return String(BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, "0")));
}
const cost = (notional: bigint) => notional + (notional * 25n) / 10000n + 20000n;
const output = (raw: string) => (BigInt(raw) * 9900n) / 10000n;
export type ManualOrderIntent = {
  requestId: string;
  side: "BUY" | "SELL";
  mint: string;
  amountUsdc?: string;
  percent?: number;
};
/** A retry must resolve from the saved intent, even when providers are unavailable. */
export function isManualOrderRetry(book: ManualBook, input: ManualOrderIntent): boolean {
  if (!/^[\w-]{8,100}$/.test(input.requestId)) throw Error("A valid request ID is required");
  const existing = book.orders.find((o) => o.requestId === input.requestId);
  if (!existing) return false;
  if (
    existing.mint !== input.mint ||
    existing.side !== input.side ||
    (input.side === "BUY"
      ? existing.amountAtomic !== usdAtomic(input.amountUsdc ?? "")
      : existing.percent !== input.percent)
  )
    throw Error("Request ID already used for a different order");
  return true;
}
export function queueManualOrder(
  book: ManualBook,
  input: {
    requestId: string;
    side: "BUY" | "SELL";
    mint: string;
    symbol: string;
    decimals: number;
    amountUsdc?: string;
    percent?: number;
  },
  now: number,
): ManualBook {
  if (isManualOrderRetry(book, input)) return book;
  if (book.orders.length >= 5000) throw Error("Paper order history limit reached");
  if (book.orders.some((o) => o.mint === input.mint && o.status === "PENDING"))
    throw Error("A paper order for this token is already pending");
  const s = structuredClone(book);
  let amount: bigint;
  if (input.side === "BUY") {
    amount = BigInt(usdAtomic(input.amountUsdc ?? ""));
    if (amount < 1000000n || amount > 250000000n)
      throw Error("Paper buys must be between 1 and 250 USDC");
    const reserved = book.orders
      .filter((o) => o.side === "BUY" && o.status === "PENDING")
      .reduce((n, o) => n + cost(BigInt(o.amountAtomic)), 0n);
    if (BigInt(book.cashAtomic) - reserved < cost(amount))
      throw Error("Insufficient unreserved paper cash");
    const names = new Set([
      ...book.positions.map((p) => p.mint),
      ...book.orders.filter((o) => o.status === "PENDING" && o.side === "BUY").map((o) => o.mint),
    ]);
    if (!names.has(input.mint) && names.size >= 10) throw Error("Maximum ten paper positions");
  } else {
    const p = book.positions.find((p) => p.mint === input.mint);
    if (!p) throw Error("No paper position to sell");
    if (!Number.isInteger(input.percent) || input.percent! < 1 || input.percent! > 100)
      throw Error("Sell percentage must be 1–100");
    amount = (BigInt(p.rawQty) * BigInt(input.percent!)) / 100n;
    if (amount === 0n) throw Error("Sell size rounds to zero");
  }
  s.orders.push({
    id: `manual:${input.requestId}`,
    requestId: input.requestId,
    side: input.side,
    mint: input.mint,
    symbol: input.symbol,
    decimals: input.decimals,
    amountAtomic: String(amount),
    ...(input.side === "SELL" ? { percent: input.percent } : {}),
    createdAt: now,
    dueAt: now + 2000,
    status: "PENDING",
  });
  s.updatedAt = now;
  s.selectedMint = input.mint;
  if (!s.watchlist.includes(input.mint)) s.watchlist.push(input.mint);
  return s;
}
export async function advanceManual(
  book: ManualBook,
  now: number,
  quote: QuoteAdapter,
  clock = () => now,
): Promise<ManualBook> {
  const s = structuredClone(book);
  s.updatedAt = now;
  let calls = 0;
  for (const o of s.orders) {
    if (o.status !== "PENDING") continue;
    if (now - o.createdAt > 90000) {
      o.status = "EXPIRED";
      o.error = "No valid exact-size quote before the order expired";
      continue;
    }
    if (now < o.dueAt || calls >= 2) continue;
    const r: SwapRequest = {
      inputMint: o.side === "BUY" ? USDC : o.mint,
      outputMint: o.side === "BUY" ? o.mint : USDC,
      amount: o.amountAtomic,
      inDecimals: o.side === "BUY" ? 6 : o.decimals,
      outDecimals: o.side === "BUY" ? o.decimals : 6,
      notionalUsd: o.side === "BUY" ? Number(o.amountAtomic) / 1e6 : 25,
    };
    calls++;
    try {
      const q = await quote(r),
        at = clock();
      if (!quoteValid(q, r, at, o.dueAt, SNIPER_CONFIG) || at - o.createdAt > 90000) {
        o.error = q.failureReason ?? q.error ?? "No valid quote yet";
        continue;
      }
      let qty: bigint,
        cash: bigint,
        basis: bigint,
        pnl = 0n;
      if (o.side === "BUY") {
        qty = output(q.outAmount);
        cash = cost(BigInt(o.amountAtomic));
        basis = cash;
        if (qty === 0n || cash > BigInt(s.cashAtomic)) {
          o.status = "EXPIRED";
          o.error = "Invalid quantity or insufficient cash";
          continue;
        }
        s.cashAtomic = String(BigInt(s.cashAtomic) - cash);
        const p = s.positions.find((p) => p.mint === o.mint);
        if (p) {
          p.rawQty = String(BigInt(p.rawQty) + qty);
          p.costAtomic = String(BigInt(p.costAtomic) + basis);
          delete p.markAtomic;
          delete p.markedAt;
        } else
          s.positions.push({
            mint: o.mint,
            symbol: o.symbol,
            decimals: o.decimals,
            rawQty: String(qty),
            costAtomic: String(basis),
            openedAt: at,
          });
      } else {
        const p = s.positions.find((p) => p.mint === o.mint);
        qty = BigInt(o.amountAtomic);
        if (!p || qty > BigInt(p.rawQty)) {
          o.status = "EXPIRED";
          o.error = "Paper position is no longer available";
          continue;
        }
        const gross = output(q.outAmount);
        cash = gross - (gross * 25n) / 10000n - 20000n;
        basis = (BigInt(p.costAtomic) * qty) / BigInt(p.rawQty);
        pnl = cash - basis;
        if (BigInt(s.cashAtomic) + cash < 0n) {
          o.error = "Insufficient paper cash for modeled network cost";
          continue;
        }
        s.cashAtomic = String(BigInt(s.cashAtomic) + cash);
        p.rawQty = String(BigInt(p.rawQty) - qty);
        p.costAtomic = String(BigInt(p.costAtomic) - basis);
        delete p.markAtomic;
        delete p.markedAt;
        s.positions = s.positions.filter((p) => BigInt(p.rawQty) > 0n);
      }
      o.status = "FILLED";
      o.filledAt = at;
      o.quote = q;
      delete o.error;
      s.fills.push({
        id: `fill:${o.id}`,
        orderId: o.id,
        side: o.side,
        mint: o.mint,
        symbol: o.symbol,
        at,
        rawQty: String(qty),
        cashAtomic: String(cash),
        costBasisAtomic: String(basis),
        pnlAtomic: String(pnl),
        quote: q,
      });
    } catch (e) {
      o.error = e instanceof Error ? e.message : "Quote failed";
    }
  }
  // One full-position indicative exit mark per tick, after pending orders.
  if (calls < 2 && s.positions.length) {
    const p = s.positions[s.markCursor % s.positions.length];
    s.markCursor++;
    if (!p.markedAt || now - p.markedAt >= 20000) {
      try {
        const r: SwapRequest = {
          inputMint: p.mint,
          outputMint: USDC,
          amount: p.rawQty,
          inDecimals: p.decimals,
          outDecimals: 6,
          notionalUsd: Number(p.costAtomic) / 1e6,
        };
        const q = await quote(r),
          at = clock();
        if (quoteValid(q, r, at, p.openedAt, SNIPER_CONFIG)) {
          const gross = output(q.outAmount);
          p.markAtomic = String(gross - (gross * 25n) / 10000n - 20000n);
          p.markedAt = at;
        }
      } catch {
        /* Missing marks stay visibly missing. */
      }
    }
  }
  s.updatedAt = clock();
  return s;
}
export function manualMetrics(s: ManualBook, now: number) {
  const fresh = s.positions.filter((p) => p.markedAt && now - p.markedAt <= 45000);
  const marked = fresh.reduce(
    (n, p) => n + (BigInt(p.markAtomic ?? "0") > 0n ? BigInt(p.markAtomic!) : 0n),
    0n,
  );
  const realized = s.fills.reduce((n, f) => n + BigInt(f.pnlAtomic), 0n);
  const reserved = s.orders
    .filter((o) => o.side === "BUY" && o.status === "PENDING")
    .reduce((n, o) => n + cost(BigInt(o.amountAtomic)), 0n);
  return {
    cashUsdc: Number(s.cashAtomic) / 1e6,
    availableUsdc: Number(BigInt(s.cashAtomic) - reserved) / 1e6,
    equityUsdc: Number(BigInt(s.cashAtomic) + marked) / 1e6,
    realizedUsdc: Number(realized) / 1e6,
    unvaluedPositions: s.positions.length - fresh.length,
    pending: s.orders.filter((o) => o.status === "PENDING").length,
  };
}
