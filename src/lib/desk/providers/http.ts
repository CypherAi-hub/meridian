import { budgetFor, parseRetryAfter } from "../rate-budget";

export const UA = {
  accept: "application/json",
  "user-agent": "MeridianPaperDesk/3.25 (research; paper-only)",
};

export function getJson(url: string, ms = 8000) {
  return fetch(url, { headers: UA, signal: AbortSignal.timeout(ms) });
}

export async function getJsonRetry(url: string, ms = 8000, attempts = 3, family?: string) {
  const budget = family ? budgetFor(family) : null;
  let last: Response | null = null;
  for (let i = 0; i < attempts; i++) {
    if (budget && !budget.take()) {
      if (last) return last;
      throw new Error(`${family ?? "provider"} rate budget empty`);
    }
    try {
      const r = await getJson(url, ms);
      last = r;
      if (r.ok) {
        budget?.onSuccess();
        return r;
      }
      if (r.status === 429) {
        const wait = parseRetryAfter(r.headers.get("retry-after"));
        budget?.onRateLimit(wait);
        if (i < attempts - 1 && wait > 0 && wait <= 2000) {
          await new Promise((res) => setTimeout(res, wait));
        }
        continue;
      }
      if (r.status < 500) return r;
    } catch (e) {
      if (e instanceof Error && e.message.includes("rate budget empty")) throw e;
    }
    await new Promise((res) => setTimeout(res, 350 * (i + 1)));
  }
  return last ?? getJson(url, ms);
}
