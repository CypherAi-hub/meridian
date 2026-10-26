import {describe, expect, it} from "vitest";
import {conservativeCostBps} from "../src/costs.ts";
describe("conservative cost budget arithmetic", () => {
  it("rejects every positive fraction above the150bps boundary without rejecting equality", () => {
    expect(conservativeCostBps(10_000_000n, 9_870_001n, 20_000n)).toBe(150);
    expect(conservativeCostBps(10_000_000n, 9_870_000n, 20_000n)).toBe(150);
    expect(conservativeCostBps(10_000_000n, 9_869_999n, 20_000n)).toBe(151);
  });
  it("keeps amount arithmetic exact beyond floating-point precision", () => {
    const amount=10n ** 24n, fees=20_000n, boundary=amount*150n/10_000n;
    expect(conservativeCostBps(amount,amount+fees-boundary,fees)).toBe(150);
    expect(conservativeCostBps(amount,amount+fees-boundary-1n,fees)).toBe(151);
  });
  it("keeps zero costs and quote improvements at zero, and fails closed for invalid amounts", () => {
    expect(conservativeCostBps(100n,110n,10n)).toBe(0);
    expect(conservativeCostBps(100n,111n,10n)).toBe(0);
    expect(()=>conservativeCostBps(0n,0n,0n)).toThrow("INVALID_COST_AMOUNTS");
    expect(()=>conservativeCostBps(1n,-1n,0n)).toThrow("INVALID_COST_AMOUNTS");
    expect(()=>conservativeCostBps(1n,0n,-1n)).toThrow("INVALID_COST_AMOUNTS");
    expect(conservativeCostBps(1n,0n,10n**30n)).toBe(Number.MAX_SAFE_INTEGER);
  });
});
