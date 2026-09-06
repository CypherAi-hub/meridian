import { WALLET_COHORT_VERSION } from "./v35-lock.ts";
import { asOfEvents } from "./v35-clock.ts";
import type { DataStatus, ParticipantEvent, WalletCohortId } from "./v35-types.ts";

export type WalletPitProfile = {
  walletId: string;
  instrumentId: string | null;
  asOfEventTime: number;
  ingestedAt: number;
  walletFirstSeenAt: number | null;
  walletAgeSeconds: number | null;
  historicalTokensSeen: number;
  historicalBuyCount: number;
  historicalSellCount: number;
  historicalMedianHoldSeconds: number | null;
  historicalRugExposureRate: number | null;
  cohortId: WalletCohortId;
  dataStatus: DataStatus;
  featureVersion: string;
};

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function walletProfileAt(
  events: ParticipantEvent[],
  walletId: string,
  T: number,
  rugFlags?: Map<string, boolean>,
): WalletPitProfile {
  const visible = asOfEvents(events, T).filter((e) => e.walletId === walletId);
  if (!visible.length) {
    return {
      walletId,
      instrumentId: null,
      asOfEventTime: T,
      ingestedAt: T,
      walletFirstSeenAt: null,
      walletAgeSeconds: null,
      historicalTokensSeen: 0,
      historicalBuyCount: 0,
      historicalSellCount: 0,
      historicalMedianHoldSeconds: null,
      historicalRugExposureRate: null,
      cohortId: "UNKNOWN",
      dataStatus: "UNKNOWN",
      featureVersion: WALLET_COHORT_VERSION,
    };
  }
  const first = Math.min(...visible.map((e) => e.eventTime));
  const tokens = new Set(visible.map((e) => e.instrumentId));
  const buys = visible.filter((e) => e.eventType === "BUY");
  const sells = visible.filter((e) => e.eventType === "SELL");
  const holds: number[] = [];
  for (const b of buys) {
    const s = sells.find((x) => x.instrumentId === b.instrumentId && x.eventTime > b.eventTime);
    if (s) holds.push((s.eventTime - b.eventTime) / 1000);
  }
  let rugs: number | null = null;
  if (rugFlags) {
    let n = 0;
    let r = 0;
    for (const t of tokens) {
      const flag = rugFlags.get(`${walletId}:${t}`);
      if (flag == null) continue;
      n += 1;
      if (flag) r += 1;
    }
    rugs = n ? r / n : null;
  }
  return {
    walletId,
    instrumentId: null,
    asOfEventTime: T,
    ingestedAt: T,
    walletFirstSeenAt: first,
    walletAgeSeconds: (T - first) / 1000,
    historicalTokensSeen: tokens.size,
    historicalBuyCount: buys.length,
    historicalSellCount: sells.length,
    historicalMedianHoldSeconds: median(holds),
    historicalRugExposureRate: rugs,
    cohortId: cohortFromProfile(T - first, tokens.size, median(holds), rugs),
    dataStatus: "OK",
    featureVersion: WALLET_COHORT_VERSION,
  };
}

export function cohortFromProfile(
  ageMs: number,
  tokensSeen: number,
  medianHoldS: number | null,
  rugRate: number | null,
): WalletCohortId {
  if (ageMs < 24 * 3600_000 && tokensSeen <= 1) return "NEW_WALLET";
  if (tokensSeen <= 3) return "LOW_HISTORY";
  if (tokensSeen >= 30) {
    if (medianHoldS != null && medianHoldS < 60) return "FAST_ROTATOR";
    return "HIGH_HISTORY";
  }
  if (medianHoldS != null && medianHoldS < 40) return "FAST_ROTATOR";
  if (medianHoldS != null && medianHoldS > 15 * 60) return "LONGER_HOLD";
  if (rugRate != null && rugRate >= 0.4) return "HIGH_RUG_EXPOSURE";
  if (rugRate != null && rugRate <= 0.05 && tokensSeen >= 8) return "LOW_RUG_EXPOSURE";
  if (medianHoldS != null) return "MEDIUM_HOLD";
  return "UNKNOWN";
}

/** Future outcomes after T must not rewrite this membership. */
export function cohortMembershipAt(events: ParticipantEvent[], walletId: string, T: number) {
  const p = walletProfileAt(events, walletId, T);
  return {
    walletId,
    cohortVersion: WALLET_COHORT_VERSION,
    cohortId: p.cohortId,
    effectiveEventTime: T,
    ingestedAt: T,
    dataStatus: p.dataStatus,
  };
}
