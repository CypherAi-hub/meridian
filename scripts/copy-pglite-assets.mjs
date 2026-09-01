#!/usr/bin/env node
/** Nitro's Vercel bundle does not emit PGLite's wasm/data next to the vendor chunk. */
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules/@electric-sql/pglite/dist");
const dest = join(root, ".vercel/output/functions/__server.func/_libs");
mkdirSync(dest, { recursive: true });
for (const f of ["pglite.data", "pglite.wasm", "initdb.wasm"]) {
  copyFileSync(join(src, f), join(dest, f));
}
