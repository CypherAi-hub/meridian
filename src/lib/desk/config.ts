import { z } from "zod";

export type ExecutionMode = "PAPER";

const EnvSchema = z.object({
  BIRDEYE_API_KEY: z.string().optional(),
  HELIUS_API_KEY: z.string().optional(),
  HELIUS_RPC_URL: z.string().optional(),
  SOLANA_RPC_URL: z.string().optional(),
  JUPITER_API_KEY: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  MERIDIAN_EXECUTION_MODE: z.enum(["PAPER"]).optional(),
  UNIVERSE_INTERVAL_MS: z.coerce.number().int().min(5_000).optional(),
  ACTIVE_INTERVAL_MS: z.coerce.number().int().min(1_000).optional(),
  ACTIVE_WATCH_TTL_MS: z.coerce.number().int().min(60_000).optional(),
  MAX_HOLDER_AGE_MS: z.coerce.number().int().optional(),
  MAX_ROUTE_AGE_MS: z.coerce.number().int().optional(),
});

export type DeskSettings = {
  executionMode: ExecutionMode;
  universeWatchMs: number;
  activeWatchMs: number;
  activeWatchTtlMs: number;
  holderTop10FailPct: number;
  minLiquidityUsd: number;
  maxExitImpactBps: number;
  maxDataAgeMs: number;
  liquidityCollapsePct: number;
  birdeyeApiKey: string | null;
  heliusApiKey: string | null;
  heliusRpcUrl: string | null;
  solanaRpcUrl: string | null;
  jupiterApiKey: string | null;
};

function clean(v: string | undefined): string | null {
  if (!v || !v.trim()) return null;
  return v.trim();
}

export function loadDeskConfig(): DeskSettings {
  const parsed = EnvSchema.parse(process.env ?? {});
  const mode = parsed.MERIDIAN_EXECUTION_MODE ?? "PAPER";
  if (mode !== "PAPER") {
    throw new Error("Meridian V3.3A.1 supports PAPER mode only.");
  }
  return {
    executionMode: "PAPER",
    universeWatchMs: parsed.UNIVERSE_INTERVAL_MS ?? 15_000,
    activeWatchMs: parsed.ACTIVE_INTERVAL_MS ?? 3_000,
    activeWatchTtlMs: parsed.ACTIVE_WATCH_TTL_MS ?? 3_600_000,
    holderTop10FailPct: 0.42,
    minLiquidityUsd: 35_000,
    maxExitImpactBps: 700,
    maxDataAgeMs: 45_000,
    liquidityCollapsePct: 0.6,
    birdeyeApiKey: clean(parsed.BIRDEYE_API_KEY),
    heliusApiKey: clean(parsed.HELIUS_API_KEY),
    heliusRpcUrl: clean(parsed.HELIUS_RPC_URL),
    solanaRpcUrl: clean(parsed.SOLANA_RPC_URL),
    jupiterApiKey: clean(parsed.JUPITER_API_KEY),
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
    rugcheck: true,
  };
}

export function publicConfig() {
  const s = deskSettings();
  return {
    executionMode: s.executionMode,
    universeWatchMs: s.universeWatchMs,
    activeWatchMs: s.activeWatchMs,
    configured: configuredProviders(),
  };
}
