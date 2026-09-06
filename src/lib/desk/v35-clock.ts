import type { ParticipantEvent } from "./v35-types.ts";

/** Point-in-time filter. Late ingested rows stay invisible until ingested_at <= T. */
export function visibleAt<T extends { eventTime: number; ingestedAt: number }>(rows: T[], T: number): T[] {
  return rows.filter((r) => r.eventTime <= T && r.ingestedAt <= T);
}

export function asOfEvents(events: ParticipantEvent[], T: number): ParticipantEvent[] {
  return visibleAt(events, T);
}

export function assertNoFuture(row: { eventTime: number; ingestedAt: number }, T: number, label: string) {
  if (row.eventTime > T || row.ingestedAt > T) {
    throw new Error(`PIT_LEAK: ${label} used after T`);
  }
}
