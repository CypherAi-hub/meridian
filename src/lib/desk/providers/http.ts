export const UA = {
  accept: "application/json",
  "user-agent": "MeridianPaperDesk/3.2 (research; paper-only)",
};

export function getJson(url: string, ms = 8000) {
  return fetch(url, { headers: UA, signal: AbortSignal.timeout(ms) });
}

export async function getJsonRetry(url: string, ms = 8000, attempts = 3) {
  let last: Response | null = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await getJson(url, ms);
      last = r;
      if (r.ok) return r;
      if (r.status !== 429 && r.status < 500) return r;
    } catch {
      /* retry */
    }
    await new Promise((res) => setTimeout(res, 350 * (i + 1)));
  }
  return last ?? getJson(url, ms);
}