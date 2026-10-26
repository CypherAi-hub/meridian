import { parsePhantomState, type PhantomReport } from "./phantom.ts";

const MAX_BYTES = 4 * 1024 * 1024;
/** Only the local engine is reachable; neither browser parameters nor upstream redirects choose a URL. */
export function phantomOrigin(value?: string): string {
  const u = new URL(value ?? "http://127.0.0.1:8790");
  if (
    u.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]", "host.docker.internal"].includes(u.hostname) ||
    u.port !== "8790" ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== "/"
  )
    throw Error("Invalid local paper engine origin");
  return u.origin;
}
export async function fetchPhantomBridge(
  options: { origin?: string; fetcher?: typeof fetch; now?: () => number } = {},
): Promise<PhantomReport> {
  const clock = options.now ?? Date.now;
  try {
    const origin = phantomOrigin(options.origin);
    const r = await (options.fetcher ?? fetch)(origin + "/state", {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(4500),
      cache: "no-store",
    });
    if (!r.ok || !r.body) throw Error("Engine unavailable");
    const reader = r.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) {
          await reader.cancel();
          throw Error("Engine payload too large");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return parsePhantomState(JSON.parse(new TextDecoder().decode(body)), clock());
  } catch {
    return {
      mode: "PAPER",
      readOnly: true,
      checkedAt: clock(),
      connection: "unavailable",
      status: "offline",
      state: null,
      message:
        "Launch engine is unavailable on this computer. Start its local paper worker to connect.",
    };
  }
}
let cache: { at: number; origin: string | undefined; report: PhantomReport } | null = null;
let flight: Promise<PhantomReport> | null = null;
export async function phantomBridgeReport(): Promise<PhantomReport> {
  const origin = process.env.OMNI_PHANTOM_ORIGIN;
  if (cache && cache.origin === origin && Date.now() - cache.at < 2000) return cache.report;
  if (flight) return flight;
  flight = fetchPhantomBridge({ origin })
    .then((report) => {
      cache = { at: Date.now(), origin, report };
      return report;
    })
    .finally(() => {
      flight = null;
    });
  return flight;
}
