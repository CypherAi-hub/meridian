/** Public addresses and payout intent only. No private key, signer, or transaction bytes. */
export const CAPITAL_VERSION = "capital-policy-v1";
export type CapitalPolicy = {
  version: typeof CAPITAL_VERSION;
  network: "solana-mainnet";
  mode: "PAPER";
  recipient: string;
  profitMint: string;
  profitLabel: string;
  allocationBps: 10000;
  principalProtected: true;
  settlementAsset: "USDC";
  minimumPayoutAtomic: string;
};
export type ProfitBalances = {
  freeUsdcAtomic: string;
  protectedPrincipalAtomic: string;
  netRealizedPnlAtomic: string;
  profitAlreadyDistributedAtomic: string;
  profitReservedAtomic: string;
  operatingReserveAtomic: string;
};
export function isSolanaAddress(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 32 || value.length > 44) return false;
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const c of value) {
    const digit = alphabet.indexOf(c);
    if (digit < 0) return false;
    n = n * 58n + BigInt(digit);
  }
  let bytes = 0;
  while (n > 0n) {
    bytes++;
    n >>= 8n;
  }
  let leading = 0;
  for (const c of value) {
    if (c !== "1") break;
    leading++;
  }
  return bytes + leading === 32;
}
export function parseCapitalPolicy(input: unknown): CapitalPolicy {
  if (!input || typeof input !== "object") throw Error("Capital policy is required");
  const p = input as Record<string, unknown>;
  if (p.mode !== "PAPER") throw Error("LIVE_EXECUTION_LOCKED");
  if (p.network !== "solana-mainnet")
    throw Error("Only the configured Solana network is supported");
  if (!isSolanaAddress(p.recipient) || !isSolanaAddress(p.profitMint))
    throw Error("Recipient and mint must decode to 32-byte Solana addresses");
  if (p.recipient === p.profitMint)
    throw Error("Recipient wallet and profit mint must be different");
  if (p.allocationBps !== 10000 || p.principalProtected !== true || p.settlementAsset !== "USDC")
    throw Error("Policy must distribute net profits only and protect principal");
  if (
    typeof p.minimumPayoutAtomic !== "string" ||
    !/^\d+$/.test(p.minimumPayoutAtomic) ||
    BigInt(p.minimumPayoutAtomic) < 1n
  )
    throw Error("Invalid minimum payout");
  if (typeof p.profitLabel !== "string" || p.profitLabel.length > 32)
    throw Error("Invalid display label");
  return {
    version: CAPITAL_VERSION,
    network: "solana-mainnet",
    mode: "PAPER",
    recipient: p.recipient,
    profitMint: p.profitMint,
    profitLabel: p.profitLabel,
    allocationBps: 10000,
    principalProtected: true,
    settlementAsset: "USDC",
    minimumPayoutAtomic: p.minimumPayoutAtomic,
  };
}
function atomic(value: string, signed = false): bigint {
  if (!(signed ? /^-?\d+$/ : /^\d+$/).test(value))
    throw Error("Balances must be integer atomic-unit strings");
  return BigInt(value);
}
export function planProfitDistribution(policy: CapitalPolicy, balances: ProfitBalances) {
  const p = parseCapitalPolicy(policy);
  const free = atomic(balances.freeUsdcAtomic),
    principal = atomic(balances.protectedPrincipalAtomic),
    pnl = atomic(balances.netRealizedPnlAtomic, true),
    paid = atomic(balances.profitAlreadyDistributedAtomic),
    reserved = atomic(balances.profitReservedAtomic),
    operating = atomic(balances.operatingReserveAtomic);
  const max = (a: bigint, b: bigint) => (a > b ? a : b),
    min = (a: bigint, b: bigint) => (a < b ? a : b);
  const undistributed = max(0n, pnl - paid - reserved);
  const excessCash = max(0n, free - principal - operating - reserved);
  const amount = min(undistributed, excessCash);
  const eligible = amount >= BigInt(p.minimumPayoutAtomic);
  return {
    mode: "PAPER_PREVIEW" as const,
    recipient: p.recipient,
    profitMint: p.profitMint,
    amountUsdcAtomic: eligible ? String(amount) : "0",
    undistributedProfitAtomic: String(undistributed),
    status: eligible ? "QUOTE_ONLY_PREVIEW_AVAILABLE" : "NO_DISTRIBUTABLE_NET_PROFIT",
    principalProtected: true,
    signingEnabled: false,
    transferEnabled: false,
    note: "Net realized profit after losses and costs; bounded by free cash above protected principal and reserves. No token conversion or transfer has occurred.",
  };
}
export type ReadinessFacts = {
  verifiedForwardProfitable: boolean;
  independentlyAudited: boolean;
  walletOwnershipVerified: boolean;
  signerProvisioned: boolean;
  liveLimitsApproved: boolean;
  payoutRouteVerified: boolean;
  recipientTokenAccountVerified: boolean;
  securityAndAuthenticationVerified: boolean;
};
export function fundedReadiness(facts: ReadinessFacts) {
  const requirements: Array<[keyof ReadinessFacts, string]> = [
    ["verifiedForwardProfitable", "Untouched forward validation with positive net results"],
    ["independentlyAudited", "Independent execution and accounting audit"],
    ["walletOwnershipVerified", "Dedicated trading wallet and ownership verification"],
    ["signerProvisioned", "User-controlled signer provisioned separately"],
    ["liveLimitsApproved", "Explicit live capital, loss, slippage and fee limits"],
    ["payoutRouteVerified", "Fresh supported route into the chosen profit mint"],
    ["recipientTokenAccountVerified", "Correct recipient associated token account and fee reserve"],
    [
      "securityAndAuthenticationVerified",
      "Authenticated funded controls and deployment security review",
    ],
  ];
  return {
    state: "PAPER_ACTIVE_LIVE_LOCKED" as const,
    depositEnabled: false,
    depositAddress: null,
    liveExecutionEnabled: false,
    automaticPromotion: false,
    blockers: requirements.filter(([key]) => !facts[key]).map(([, description]) => description),
    finalActivation:
      "Separate explicit activation and tested execution adapter required; passing paper metrics cannot enable real trading.",
  };
}
export function rejectLiveAction(action: string): never {
  throw Error(`LIVE_EXECUTION_LOCKED: ${action} is unavailable in this paper build`);
}
