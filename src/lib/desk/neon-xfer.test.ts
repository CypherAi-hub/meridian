import assert from "node:assert/strict";
import { test } from "node:test";
import { estimatePairBytes, noteUniverseXfer, projectTransfer } from "./neon-xfer.ts";

test("universe tick transfer is dominated by full-corpus snapshot reloads", () => {
  const current = estimatePairBytes(1201);
  assert.ok(current > 6_000_000 && current < 8_000_000);
  const before = noteUniverseXfer({ researchRows: 1201, pendingRows: 201, ledgerRows: 80 });
  const hourly = projectTransfer(before.tickBytesEst).hourly;
  assert.ok(hourly > 2e9);
  const after = noteUniverseXfer({ researchRows: 0, pendingRows: 201, ledgerRows: 80, deskBytesEst: 138_000 });
  assert.ok(after.tickBytesEst < before.tickBytesEst / 4);
  assert.equal(projectTransfer(after.tickBytesEst).monthly < 500 * 1e9, true);
});
