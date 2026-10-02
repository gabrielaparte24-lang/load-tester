export * from "./errors.js";
export * from "./duration.js";
export * from "./config.js";
export * from "./precise-timer.js";
export * from "./schedule.js";
export * from "./metrics.js";
export * from "./thresholds.js";
export * from "./secrets.js";
export * from "./safety.js";
export * from "./report.js";
export * from "./runner.js";
export * from "./scenario/types.js";
export * from "./scenario/load.js";

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
export const VERSION: string = (require("../package.json") as { version: string }).version;
