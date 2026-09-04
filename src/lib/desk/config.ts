import { z } from "zod";
import {
  canonicalDriver,
  currentEpochName,
  meridianEnvironment,
  validateProductionConfig,
  type MeridianEnvironment,
} from "./env.ts";

export type ExecutionMode = "PAPER";

const EnvSchema = z.object({
  BIRDEYE_API_KEY: z.string().optional(),
  HELIUS_API_KEY: z.string().optional(),
  HELIUS_RPC_URL: z.string().optional(),
  HELIUS_GATEKEEPER_URL: z.string().optional(),
  SOLANA_RPC_URL: z.string().optional(),
  JUPITER_API_KEY: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  MERIDIAN_EXECUTION_MODE: z.enum(["PAPER"]).optional(),
  EXECUTION_MODE: z.enum(["PAPER"]).optional(),
  MERIDIAN_ENV: z.string().optional(),
  UNIVERSE_INTERVAL_MS: z.coerce.number().int().min(5_000).optional(),
  ACTIVE_INTERVAL_MS: z.coerce.number().int().min(1_000).optional(),
  ACTIVE_WATCH_TTL_MS: z.coerce.number().int().min(60_000).optional(),
  MAX_ACTIVE_WATCHES: z.coerce.number().int().min(1).max(80).optional(),
  MAX_HOLDER_AGE_MS: z.coerce.number().int().optional(),
  MAX_ROUTE_AGE_MS: z.coerce.number().int().optional(),
});

export type DeskSettings = {
  executionMode: ExecutionMode;
  environment: MeridianEnvironment;
  databaseDriver: "pglite" | "neon";
  databaseUrl: string | null;
  universeWatchMs: number;
  activeWatchMs: number;
  activeWatchTtlMs: number;
  maxActiveWatches: number;
  holderTop10FailPct: number;
  minLiquidityUsd: number;
  maxExitImpactBps: number;
  maxDataAgeMs: number;
  liquidityCollapsePct: number;
  birdeyeApiKey: string | null;
  heliusApiKey: string | null;
  heliusRpcUrl: string | null;
  heliusGatekeeperUrl: string | null;
  solanaRpcUrl: string | null;
  jupiterApiKey: string | null;
  collectionEpoch: string;
};

function clean(v: string | undefined): string | null {
  if (!v || !v.trim()) return null;
  return v.trim().replace(/\.+$/, "");
}

export function loadDeskConfig(): DeskSettings {
  const parsed = EnvSchema.parse(process.env ?? {});
  const mode = parsed.MERIDIAN_EXECUTION_MODE ?? parsed.EXECUTION_MODE ?? "PAPER";
  if (mode !== "PAPER") {
    throw new Error("Meridian V3.3A.2 supports PAPER mode only.");
  }
  const databaseUrl = clean(parsed.DATABASE_URL);
  const databaseDriver = canonicalDriver();
  const environment = meridianEnvironment();
  validateProductionConfig({
    databaseUrl,
    databaseDriver,
    executionMode: "PAPER",
  });
  return {
    executionMode: "PAPER",
    environment,
    databaseDriver,
    databaseUrl,
    universeWatchMs: parsed.UNIVERSE_INTERVAL_MS ?? 15_000,
    activeWatchMs: parsed.ACTIVE_INTERVAL_MS ?? 3_000,
    activeWatchTtlMs: parsed.ACTIVE_WATCH_TTL_MS ?? 3_600_000,
    maxActiveWatches: parsed.MAX_ACTIVE_WATCHES ?? 25,
    holderTop10FailPct: 0.42,
    minLiquidityUsd: 35_000,
    maxExitImpactBps: 700,
    maxDataAgeMs: 45_000,
    liquidityCollapsePct: 0.6,
    birdeyeApiKey: clean(parsed.BIRDEYE_API_KEY),
    heliusApiKey: clean(parsed.HELIUS_API_KEY),
    heliusRpcUrl: clean(parsed.HELIUS_RPC_URL),
    heliusGatekeeperUrl: clean(parsed.HELIUS_GATEKEEPER_URL),
    solanaRpcUrl: clean(parsed.SOLANA_RPC_URL),
    jupiterApiKey: clean(parsed.JUPITER_API_KEY),
    collectionEpoch: currentEpochName(environment),
  };
}

export function deskSettings(): DeskSettings {
  return loadDeskConfig();
}

export function assertPaperMode() {
  if (deskSettings().executionMode !== "PAPER") {
    throw new Error("Live execution disabled.");
  }
}

export function configuredProviders() {
  const s = deskSettings();
  return {
    birdeye: Boolean(s.birdeyeApiKey),
    helius: Boolean(s.heliusApiKey),
    solanaRpc: Boolean(s.solanaRpcUrl),
    jupiter: Boolean(s.jupiterApiKey),
    jupiterMode: s.jupiterApiKey ? ("configured" as const) : ("keyless" as const),
    rpc: s.solanaRpcUrl ? ("dedicated" as const) : s.heliusRpcUrl ? ("dedicated" as const) : ("public" as const),
    rugcheck: true,
    database: s.databaseDriver === "neon" ? ("NEON" as const) : ("PGLITE" as const),
  };
}

export function publicConfig() {
  const s = deskSettings();
  return {
    executionMode: s.executionMode,
    environment: s.environment,
    collectionEpoch: s.collectionEpoch,
    universeWatchMs: s.universeWatchMs,
    activeWatchMs: s.activeWatchMs,
    maxActiveWatches: s.maxActiveWatches,
    databaseDriver: s.databaseDriver,
    configured: configuredProviders(),
  };
}
