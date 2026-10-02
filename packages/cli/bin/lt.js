#!/usr/bin/env node
// Shim versionado: existe antes do build, então o npm consegue criar o link `lt` já no `npm install`.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const entry = new URL("../dist/index.js", import.meta.url);
if (!existsSync(fileURLToPath(entry))) {
  console.error("lt ainda não foi compilado. Rode: npm run setup (ou npm run build)");
  process.exit(2);
}
await import(entry.href);
