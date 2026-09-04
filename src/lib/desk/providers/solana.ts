import type { TokenSnapshot } from "../schema.ts";
import { field } from "./normalize.ts";
import { deskSettings } from "../config.ts";

type RpcError = { message?: string };
type AccountValue = { data?: [string, string]; owner?: string } | null;

const PUBLIC_RPCS = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"];

function rpcUrls(): string[] {
  const s = deskSettings();
  const dedicated = [s.solanaRpcUrl, s.heliusRpcUrl, s.heliusGatekeeperUrl].filter(
    (u, i, all): u is string => Boolean(u) && all.indexOf(u) === i,
  );
  return dedicated.length ? [...dedicated, ...PUBLIC_RPCS] : PUBLIC_RPCS;
}

export async function solanaRpc<T>(payload: unknown): Promise<T> {
  let last = "solana rpc failed";
  for (const url of rpcUrls()) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) {
        last = `rpc ${r.status}`;
        continue;
      }
      return (await r.json()) as T;
    } catch (e) {
      last = e instanceof Error ? e.message : "solana rpc failed";
    }
  }
  throw new Error(last);
}

function u32(buf: Uint8Array, o: number) {
  return (buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16) | (buf[o + 3] << 24)) >>> 0;
}

function decodeB64(data: string) {
  const bin = atob(data);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}

function parseMint(dataB64: string) {
  const buf = decodeB64(dataB64);
  if (buf.length < 82) return null;
  return {
    mintAuth: u32(buf, 0) !== 0,
    freezeAuth: u32(buf, 46) !== 0,
    decimals: buf[44] ?? 6,
  };
}

export async function enrichSolana(tokens: TokenSnapshot[]): Promise<{
  tokens: TokenSnapshot[];
  lagMs: number;
  error?: string;
}> {
  const t0 = Date.now();
  const slice = tokens.slice(0, 16);
  if (!slice.length) return { tokens, lagMs: 0 };

  try {
    const mints = slice.map((t) => t.address);
    const info = await solanaRpc<{
      result?: { value: AccountValue[] };
      error?: RpcError;
    }>({
      jsonrpc: "2.0",
      id: 1,
      method: "getMultipleAccounts",
      params: [mints, { encoding: "base64" }],
    });
    if (info.error) throw new Error(info.error.message ?? "getMultipleAccounts");
    const accounts = info.result?.value ?? [];
    const eventTime = Date.now();
    const ingestedAt = eventTime;

    const by = new Map(
      slice.map((t, i) => {
        const acc = accounts[i];
        const data = acc?.data?.[0];
        const mint = data ? parseMint(data) : null;
        const next: TokenSnapshot = {
          ...t,
          decimals: mint?.decimals ?? t.decimals,
          mintAuth: mint ? field(mint.mintAuth, eventTime, ingestedAt, "solana") : t.mintAuth,
          freezeAuth: mint ? field(mint.freezeAuth, eventTime, ingestedAt, "solana") : t.freezeAuth,
        };
        return [t.address, next] as const;
      }),
    );

    return {
      tokens: tokens.map((t) => by.get(t.address) ?? t),
      lagMs: Date.now() - t0,
    };
  } catch (e) {
    return {
      tokens,
      lagMs: Date.now() - t0,
      error: e instanceof Error ? e.message : "solana failed",
    };
  }
}
