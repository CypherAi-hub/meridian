import type { ParticipantEvent, SniperSession } from "./v35-types.ts";
import { assertShadowWarehouse } from "./v35-dev-lease.ts";

export type SqlLike = {
  query: (text: string, params?: unknown[]) => Promise<{ rowCount?: number | null }>;
};

export async function persistParticipantEvents(sql: SqlLike, events: ParticipantEvent[]) {
  for (const e of events) {
    await sql.query(
      `insert into participant_events (
         id, instrument_id, token_mint, event_time_ms, ingested_at_ms, provider_id, provider_event_id,
         event_type, wallet_id, usd_notional, observed_price, transaction_signature, data_status,
         collection_epoch, schema_version, created_at_ms
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       on conflict (id) do nothing`,
      [
        e.id,
        e.instrumentId,
        e.tokenMint,
        e.eventTime,
        e.ingestedAt,
        e.providerId,
        e.providerEventId,
        e.eventType,
        e.walletId,
        e.usdNotional,
        e.observedPrice,
        e.transactionSignature,
        e.dataStatus,
        e.collectionEpoch,
        e.schemaVersion,
        Date.now(),
      ],
    );
  }
}

export async function persistSniperSessions(sql: SqlLike, sessions: SniperSession[]) {
  for (const s of sessions) {
    await sql.query(
      `insert into sniper_sessions (
         id, instrument_id, token_mint, trigger_version, trigger_time_ms, trigger_ingested_at_ms,
         trigger_reason_codes, family, session_state, fingerprint, priority, collection_epoch,
         commit_sha, started_at_ms
       ) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14)
       on conflict (id) do nothing`,
      [
        s.id,
        s.instrumentId,
        s.tokenMint,
        s.triggerVersion,
        s.triggerTime,
        s.triggerIngestedAt,
        JSON.stringify(s.triggerReasonCodes),
        s.family,
        s.sessionState,
        s.fingerprint,
        s.priority,
        s.collectionEpoch,
        s.commitSha,
        s.triggerTime,
      ],
    );
  }
}

export function refuseProductionPersist(env: NodeJS.ProcessEnv = process.env) {
  return assertShadowWarehouse(env);
}
