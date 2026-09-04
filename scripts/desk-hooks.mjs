/**
 * Node loader hooks so the Railway worker can import desk TypeScript
 * with `@/` aliases and optional `.ts` extensions (Vite-style).
 */
import { existsSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const EXTS = ["", ".ts", ".js", ".mjs", "/index.ts", "/index.js"];

function asFileUrl(abs) {
  return pathToFileURL(abs).href;
}

function tryFile(abs) {
  for (const ext of EXTS) {
    const candidate = abs + ext;
    if (existsSync(candidate)) return asFileUrl(candidate);
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const abs = join(SRC, specifier.slice(2));
    const hit = tryFile(abs);
    if (hit) return { url: hit, shortCircuit: true };
  }
  if (specifier.startsWith(".") && context.parentURL) {
    const parentDir = dirname(fileURLToPath(context.parentURL));
    if (!extname(specifier)) {
      const hit = tryFile(join(parentDir, specifier));
      if (hit) return { url: hit, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
