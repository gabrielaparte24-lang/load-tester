#!/usr/bin/env node
// npm run restart [-- <opções do start>] — stop seguido de start (repassa as opções ao start).
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT } from "./lib.mjs";

const run = (script, args) =>
  spawnSync(process.execPath, [path.join(ROOT, "scripts", script), ...args], {
    stdio: "inherit",
    cwd: ROOT,
  }).status ?? 1;

const stopCode = run("stop.mjs", []);
if (stopCode !== 0) process.exit(stopCode);
process.exit(run("start.mjs", process.argv.slice(2)));
