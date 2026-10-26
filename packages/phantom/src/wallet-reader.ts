import bs58 from "bs58";
import { Rpc } from "./stream.ts";
import { decodeTransaction, type RpcTransaction } from "./decoder.ts";
import { WalletIntelligence, type FundingEdge, type CreatorOutcome } from "./intelligence.ts";
import type { Store } from "./store.ts";

export type WalletCoverage = {
  schemaVersion: 2;
  wallet: string;
  observedAt: number;
  signaturesReviewed: number;
  historyComplete: false;
  funding: FundingEdge[];
  launches: CreatorOutcome[];
};
type RawWalletCoverage = Omit<WalletCoverage, "funding"> & { fundingCandidates: FundingEdge[] };
const publicKey = (v: unknown): v is string => {
  try {
    return typeof v === "string" && bs58.decode(v).length === 32;
  } catch {
    return false;
  }
};
const signature = (v: unknown): v is string => {
  try {
    return typeof v === "string" && bs58.decode(v).length === 64;
  } catch {
    return false;
  }
};
const timestamp = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const integerAmount = (v: unknown) => {
  if ((typeof v !== "string" && typeof v !== "bigint") || !/^\d+$/.test(String(v)))
    throw Error("WALLET_CACHED_AMOUNT_INVALID");
  const amount = BigInt(v);
  if (amount <= 0n) throw Error("WALLET_CACHED_AMOUNT_INVALID");
  return amount;
};

/** Bounded actual-history evidence. No cache entry proves complete wallet independence. */
export class WalletHistoryReader {
  private cache = new Map<string, RawWalletCoverage>();
  constructor(
    private readonly rpc: Rpc,
    private readonly store: Store,
    private readonly intelligence: WalletIntelligence,
    private readonly sharedServices = new Set<string>(),
    private readonly clock: () => number = Date.now,
  ) {}
  private remember(wallet: string, coverage: RawWalletCoverage) {
    this.cache.set(wallet, coverage);
    if (this.cache.size > 2000) this.cache.delete(this.cache.keys().next().value!);
  }
  private restore(value: any, wallet: string): RawWalletCoverage | null {
    try {
      // V1 caches filtered by an earlier caller's related set and are not reusable raw coverage.
      if (
        !value ||
        value.schemaVersion !== 2 ||
        value.wallet !== wallet ||
        value.historyComplete !== false ||
        !timestamp(value.observedAt) ||
        !Number.isSafeInteger(value.signaturesReviewed) ||
        value.signaturesReviewed < 0 ||
        value.signaturesReviewed > 6 ||
        !Array.isArray(value.fundingCandidates) ||
        value.fundingCandidates.length > 1000 ||
        !Array.isArray(value.launches) ||
        value.launches.length > 1000
      )
        return null;
      const fundingCandidates: FundingEdge[] = value.fundingCandidates.map((edge: any) => {
        if (
          !publicKey(edge.from) ||
          !publicKey(edge.to) ||
          edge.from === edge.to ||
          !signature(edge.signature) ||
          !timestamp(edge.eventAt) ||
          !timestamp(edge.observedAt) ||
          edge.eventAt > edge.observedAt ||
          edge.observedAt > value.observedAt ||
          typeof edge.sharedService !== "boolean"
        )
          throw Error("WALLET_CACHED_FUNDING_INVALID");
        return { ...edge, amountLamports: integerAmount(edge.amountLamports) };
      });
      const launches: CreatorOutcome[] = value.launches.map((launch: any) => {
        if (
          launch.creator !== wallet ||
          !publicKey(launch.mint) ||
          !timestamp(launch.launchedAt) ||
          !timestamp(launch.knownAt) ||
          launch.launchedAt > launch.knownAt ||
          launch.knownAt > value.observedAt ||
          launch.outcome !== "unresolved" ||
          !Array.isArray(launch.evidenceSignatures) ||
          !launch.evidenceSignatures.length ||
          !launch.evidenceSignatures.every(signature)
        )
          throw Error("WALLET_CACHED_LAUNCH_INVALID");
        return { ...launch, evidenceSignatures: [...launch.evidenceSignatures] };
      });
      return {
        schemaVersion: 2,
        wallet,
        observedAt: value.observedAt,
        signaturesReviewed: value.signaturesReviewed,
        historyComplete: false,
        fundingCandidates,
        launches,
      };
    } catch {
      return null;
    }
  }
  private project(raw: RawWalletCoverage, related: Set<string>, asOf: number): WalletCoverage {
    const funding = raw.fundingCandidates
      .filter(
        (edge) =>
          edge.eventAt <= asOf &&
          edge.observedAt <= asOf &&
          related.has(edge.from) &&
          related.has(edge.to),
      )
      .map((edge) => ({
        ...edge,
        sharedService:
          edge.sharedService ||
          this.sharedServices.has(edge.from) ||
          this.sharedServices.has(edge.to),
      }));
    const launches = raw.launches
      .filter((launch) => launch.launchedAt <= asOf && launch.knownAt <= asOf)
      .map((launch) => ({ ...launch, evidenceSignatures: [...launch.evidenceSignatures] }));
    const value: WalletCoverage = {
      schemaVersion: 2,
      wallet: raw.wallet,
      observedAt: raw.observedAt,
      signaturesReviewed: raw.signaturesReviewed,
      historyComplete: false,
      funding,
      launches,
    };
    for (const edge of value.funding) this.intelligence.addFunding(edge);
    for (const launch of value.launches) this.intelligence.addCreatorOutcome(launch);
    return value;
  }
  async inspect(wallet: string, related: Set<string>, now = this.clock()): Promise<WalletCoverage> {
    if (!publicKey(wallet) || !timestamp(now)) throw Error("WALLET_HISTORY_INPUT_INVALID");
    let previous = this.cache.get(wallet);
    if (previous && previous.observedAt <= now && now - previous.observedAt < 300000)
      return this.project(previous, related, now);
    const stored = this.restore(await this.store.get(`wallet:${wallet}`), wallet);
    if (stored && stored.observedAt <= now && now - stored.observedAt < 300000) {
      this.remember(wallet, stored);
      return this.project(stored, related, now);
    }
    if (stored && stored.observedAt <= now) previous = stored;
    const signatures = await this.rpc.call<{ signature: string; err: unknown }[]>(
      "getSignaturesForAddress",
      [wallet, { limit: 6, commitment: "finalized" }],
    );
    if (!Array.isArray(signatures) || signatures.length > 6)
      throw Error("WALLET_SIGNATURE_RESPONSE_INVALID");
    const raw: RawWalletCoverage = {
      schemaVersion: 2,
      wallet,
      observedAt: now,
      signaturesReviewed: 0,
      historyComplete: false,
      fundingCandidates: [],
      launches: [],
    };
    const seenSignatures = new Set<string>();
    for (const item of signatures) {
      if (
        !item ||
        !signature(item.signature) ||
        item.err !== null ||
        seenSignatures.has(item.signature)
      )
        continue;
      seenSignatures.add(item.signature);
      const tx = await this.rpc.call<RpcTransaction | null>("getTransaction", [
        item.signature,
        { encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: 0 },
      ]);
      if (
        !tx?.meta ||
        tx.meta.err !== null ||
        tx.transaction?.signatures?.[0] !== item.signature ||
        !timestamp(tx.slot) ||
        (tx.version != null && tx.version !== 0 && tx.version !== "legacy")
      )
        continue;
      const message = tx.transaction.message;
      if (
        !Array.isArray(message?.accountKeys) ||
        !Array.isArray(message.instructions) ||
        message.instructions.length > 1024
      )
        continue;
      const keys = [
        ...message.accountKeys,
        ...(tx.meta.loadedAddresses?.writable ?? []),
        ...(tx.meta.loadedAddresses?.readonly ?? []),
      ];
      if (!keys.every(publicKey) || !keys.includes(wallet)) continue;
      const at = this.clock(),
        eventAt = tx.blockTime == null ? at : tx.blockTime * 1000;
      if (!timestamp(at) || !timestamp(eventAt) || eventAt > at) continue;
      raw.signaturesReviewed++;
      // The transaction's successful top-level instruction list is committed. Inner instructions
      // can contain failed CPIs caught by an outer program, so they are unsupported funding evidence.
      const pairTotals = new Map<string, FundingEdge>();
      for (const ix of message.instructions) {
        if (
          !Number.isInteger(ix.programIdIndex) ||
          keys[ix.programIdIndex] !== "11111111111111111111111111111111" ||
          !Array.isArray(ix.accounts) ||
          ix.accounts.length < 2 ||
          !ix.accounts.every(
            (index) => Number.isInteger(index) && index >= 0 && index < keys.length,
          ) ||
          typeof ix.data !== "string"
        )
          continue;
        let data: Buffer;
        try {
          data = Buffer.from(bs58.decode(ix.data));
        } catch {
          continue;
        }
        if (data.length !== 12 || data.readUInt32LE(0) !== 2) continue;
        const from = keys[ix.accounts[0]],
          to = keys[ix.accounts[1]],
          amountLamports = data.readBigUInt64LE(4);
        if (from === to || amountLamports === 0n) continue;
        const pair = `${from}:${to}`,
          existing = pairTotals.get(pair);
        if (existing) existing.amountLamports += amountLamports;
        else
          pairTotals.set(pair, {
            from,
            to,
            amountLamports,
            eventAt,
            observedAt: at,
            signature: item.signature,
            sharedService: this.sharedServices.has(from) || this.sharedServices.has(to),
          });
      }
      for (const edge of pairTotals.values()) {
        const prior = previous?.fundingCandidates.find(
          (value) =>
            value.signature === edge.signature &&
            value.from === edge.from &&
            value.to === edge.to &&
            value.amountLamports === edge.amountLamports,
        );
        if (prior) {
          // With unavailable chain time, discovery time is only an upper bound; do not
          // move the same known transfer forward on every refresh or invert its times.
          if (tx.blockTime == null) edge.eventAt = prior.eventAt;
          if (edge.eventAt <= prior.observedAt)
            edge.observedAt = Math.min(prior.observedAt, edge.observedAt);
        }
        raw.fundingCandidates.push(edge);
      }
      for (const event of decodeTransaction(tx, at))
        if (event.kind === "launch" && event.creator === wallet) {
          let launchedAt = event.blockTime == null ? at : event.blockTime * 1000;
          if (launchedAt > at) continue;
          const prior = previous?.launches.find(
            (value) => value.mint === event.mint && value.creator === wallet,
          );
          if (prior && event.blockTime == null) launchedAt = prior.launchedAt;
          raw.launches.push({
            creator: wallet,
            mint: event.mint,
            launchedAt,
            knownAt: prior && launchedAt <= prior.knownAt ? Math.min(prior.knownAt, at) : at,
            outcome: "unresolved",
            evidenceSignatures: [event.signature],
          });
        }
    }
    raw.observedAt = this.clock();
    if (!timestamp(raw.observedAt) || raw.observedAt < now)
      throw Error("WALLET_HISTORY_CLOCK_MOVED_BACKWARDS");
    await this.store.save(`wallet:${wallet}`, raw);
    this.remember(wallet, raw);
    return this.project(raw, related, raw.observedAt);
  }
}
