import { create } from "zustand";
import { emptyDesk } from "./engine";
import type { DeskSnapshot, LedgerRow } from "./types";

type DeskStore = DeskSnapshot & {
  tick: () => void;
  select: (address: string) => void;
  toggle: () => void;
  resetBook: () => void;
  setRisk: (bps: number) => void;
  setSlippage: (bps: number) => void;
  applyIncomingTape: () => Promise<void>;
  requote: (address: string) => Promise<void>;
  hydrateResearch: () => Promise<void>;
  dumpResearch: (format?: "json" | "csv") => Promise<LedgerRow[] | string>;
  feedError: string | null;
  hydrated: boolean;
};

async function pull(): Promise<DeskSnapshot & { feedError: string | null }> {
  const res = await fetch("/api/desk", { cache: "no-store" });
  if (!res.ok) throw new Error(`desk ${res.status}`);
  const snap = (await res.json()) as DeskSnapshot;
  const worker = snap.worker ?? emptyDesk().worker;
  return {
    ...emptyDesk(),
    ...snap,
    worker,
    feedError: worker.lastError,
  };
}

async function control(body: Record<string, unknown>) {
  await fetch("/api/control", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export const useDesk = create<DeskStore>()((set, get) => ({
  ...emptyDesk(),
  feedError: null,
  hydrated: false,
  tick: () => {
    /* server worker owns the clock */
  },
  select: (address) => {
    set({ selected: address });
    void control({ selected: address });
  },
  toggle: () => {
    const running = !get().running;
    set({ running, halted: running ? false : get().halted });
    void control({ running });
  },
  resetBook: () => {
    void control({ resetBook: true }).then(() => void get().applyIncomingTape());
  },
  setRisk: (bps) => {
    set({ riskBps: bps });
    void control({ riskBps: bps });
  },
  setSlippage: (bps) => {
    set({ slippageBps: bps });
    void control({ slippageBps: bps });
  },
  hydrateResearch: async () => {
    try {
      const snap = await pull();
      set({ ...snap, hydrated: true });
    } catch {
      set({ hydrated: true, feedError: "worker unreachable" });
    }
  },
  dumpResearch: async (format = "json") => {
    const res = await fetch(`/api/research?format=${format}`, { cache: "no-store" });
    if (format === "csv") return res.text();
    return res.json() as Promise<LedgerRow[]>;
  },
  requote: async () => {
    /* quotes live on the worker tape */
  },
  applyIncomingTape: async () => {
    try {
      const snap = await pull();
      set({
        ...snap,
        feedError: snap.worker.status === "offline" ? snap.worker.lastError ?? "worker offline" : null,
      });
    } catch (e) {
      set({
        feedError: e instanceof Error ? e.message : "desk failed",
        realData: false,
        worker: { ...get().worker, status: "offline" },
      });
    }
  },
}));

let poll: number | null = null;

export function startDeskLoop() {
  if (typeof window === "undefined") return;
  if (poll != null) return;
  void useDesk.getState().hydrateResearch();
  poll = window.setInterval(() => void useDesk.getState().applyIncomingTape(), 2000);
}

export function stopDeskLoop() {
  if (poll != null) {
    window.clearInterval(poll);
    poll = null;
  }
}
