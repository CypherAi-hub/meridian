export type ExecutionMode = "PAPER" | "SHADOW" | "LIVE";

export type DeskSettings = {
  executionMode: ExecutionMode;
  universeWatchMs: number;
  activeWatchMs: number;
  holderTop10FailPct: number;
  minLiquidityUsd: number;
  maxExitImpactBps: number;
  maxDataAgeMs: number;
  liquidityCollapsePct: number;
  birdeyeApiKey: string | null;
  heliusApiKey: string | null;
  solanaRpcUrl: string | null;
};

function env(name: string): string | null {
  const v = typeof process !== "undefined" ? process.env[name] : undefined;
  if (!v || !v.trim()) return null;
  return v.trim();
}

export function deskSettings(): DeskSettings {
  const mode = (env("MERIDIAN_EXECUTION_MODE") ?? "PAPER").toUpperCase();
  if (mode !== "PAPER") {
    throw new Error(`Execution mode ${mode} is not allowed. Paper-only.`);
  }
  return {
    executionMode: "PAPER",
    universeWatchMs: 15_000,
    activeWatchMs: 4_000,
    holderTop10FailPct: 0.42,
    minLiquidityUsd: 35_000,
    maxExitImpactBps: 700,
    maxDataAgeMs: 45_000,
    liquidityCollapsePct: 0.6,
    birdeyeApiKey: env("BIRDEYE_API_KEY"),
    heliusApiKey: env("HELIUS_API_KEY"),
    solanaRpcUrl: env("SOLANA_RPC_URL"),
  };
}

export function configuredProviders() {
  const s = deskSettings();
  return {
    birdeye: Boolean(s.birdeyeApiKey),
    helius: Boolean(s.heliusApiKey),
    solanaRpc: Boolean(s.solanaRpcUrl),
  };
}
