import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
/** Immutable startup fingerprint of code and protocol definitions. Credentials/data are excluded. */
export function runtimeSourceVersion() {
  const hash = createHash("sha256");
  for (const directory of ["src", "vendor"])
    for (const name of readdirSync(new URL(`../${directory}/`, import.meta.url))
      .filter((name) => (directory === "src" ? name.endsWith(".ts") : name.endsWith(".json")))
      .sort()) {
      hash.update(`${directory}/${name}\0`);
      hash.update(readFileSync(new URL(`../${directory}/${name}`, import.meta.url)));
    }
  for (const name of ["package.json", "package-lock.json"]) {
    hash.update(name + "\0");
    hash.update(readFileSync(new URL(`../${name}`, import.meta.url)));
  }
  return hash.digest("hex");
}
