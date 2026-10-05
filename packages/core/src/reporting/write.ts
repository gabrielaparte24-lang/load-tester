import fs from "node:fs";
import path from "node:path";
import type { BenchReport } from "../bench.js";
import type { ComparisonResult } from "../compare.js";
import { ConfigError } from "../errors.js";
import type { RunReport } from "../report.js";
import {
  benchCsv,
  benchMarkdown,
  runJUnit,
  runMarkdown,
  runPrometheus,
  stepsCsv,
  timelineCsv,
} from "./formats.js";
import { renderBenchHtml, renderRunHtml } from "./html.js";

export const REPORT_FORMATS = ["json", "html", "csv", "md", "junit", "prom"] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];
export const DEFAULT_FORMATS: ReportFormat[] = ["json", "html", "csv", "md", "junit"];

export function parseFormats(spec: string): ReportFormat[] {
  const list = spec
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (list.includes("all")) return [...REPORT_FORMATS];
  const bad = list.filter((f) => !REPORT_FORMATS.includes(f as ReportFormat));
  if (bad.length)
    throw new ConfigError(
      `formato(s) desconhecido(s): ${bad.join(", ")} (use ${REPORT_FORMATS.join(", ")} ou all)`,
    );
  return [...new Set(list)] as ReportFormat[];
}

export interface WriteExtras {
  comparison?: ComparisonResult;
  baselineSource?: string;
}

/**
 * Grava os formatos pedidos numa pasta:
 *   report.json  report.html  timeline.csv + steps.csv  summary.md  junit.xml  metrics.prom
 * O JSON é sempre gravado (é a fonte para regenerar os demais com `lt report`).
 */
export function writeRunReports(
  r: RunReport,
  dir: string,
  formats: ReportFormat[] = DEFAULT_FORMATS,
  extras: WriteExtras = {},
): Record<string, string> {
  fs.mkdirSync(dir, { recursive: true });
  const files: Record<string, string> = {};
  const put = (name: string, content: string) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, content);
    files[name] = f;
  };
  put("report.json", JSON.stringify(r, null, 2));
  if (extras.comparison)
    put("baseline-comparison.json", JSON.stringify(extras.comparison, null, 2));
  if (formats.includes("html")) put("report.html", renderRunHtml(r, extras));
  if (formats.includes("csv")) {
    put("timeline.csv", timelineCsv(r));
    put("steps.csv", stepsCsv(r));
  }
  if (formats.includes("md")) {
    const rel = path.relative(process.cwd(), path.join(dir, "report.html")) || "report.html";
    put(
      "summary.md",
      runMarkdown(r, { comparison: extras.comparison, reportPath: rel.split(path.sep).join("/") }),
    );
  }
  if (formats.includes("junit")) put("junit.xml", runJUnit(r, extras));
  if (formats.includes("prom")) put("metrics.prom", runPrometheus(r));
  return files;
}

export function writeBenchReports(
  b: BenchReport,
  dir: string,
  formats: ReportFormat[] = DEFAULT_FORMATS,
): Record<string, string> {
  fs.mkdirSync(dir, { recursive: true });
  const files: Record<string, string> = {};
  const put = (name: string, content: string) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, content);
    files[name] = f;
  };
  put("bench.json", JSON.stringify(b, null, 2));
  if (formats.includes("html")) put("bench.html", renderBenchHtml(b));
  if (formats.includes("csv")) put("bench.csv", benchCsv(b));
  if (formats.includes("md")) put("summary.md", benchMarkdown(b));
  return files;
}
