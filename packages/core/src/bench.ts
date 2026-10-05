import fs from "node:fs";
import path from "node:path";
import {
  compareGroups,
  runMetrics,
  type ComparisonOptions,
  type ComparisonResult,
  type RunMetrics,
} from "./compare.js";
import { makeRunId, type RunReport } from "./report.js";
import { writeBenchReports, writeRunReports, type ReportFormat } from "./reporting/write.js";
import { runScenario, type RunOptions } from "./runner.js";
import type { Scenario } from "./scenario/types.js";
import { bootstrapCI, mean, median, stdev, type Interval } from "./stats/stats.js";

export const MIN_BENCH_RUNS = 5;

export interface BenchRun extends RunMetrics {
  id: string;
  status: RunReport["run"]["status"];
  invalid: boolean;
  requests: number;
  errors: number;
  /** Caminho do report.json da rodada, relativo ao bench.json. */
  report: string;
}

export interface MetricSummary {
  n: number;
  median: number;
  mean: number;
  stdev: number;
  /** Coeficiente de variação entre rodadas (%): variabilidade do ambiente/alvo. */
  cvPct: number;
  min: number;
  max: number;
  /** IC 95% da mediana por bootstrap (com n = 5 é largo: é a incerteza real). */
  ci95: Interval;
}

export interface BenchGroup {
  label: "A" | "B";
  scenario: string;
  scenarioFile?: string;
  baseUrl: string;
  runs: BenchRun[];
  /** Calculado só com rodadas válidas e concluídas. */
  summary: Record<keyof RunMetrics, MetricSummary>;
}

export interface BenchReport {
  schemaVersion: 1;
  kind: "bench";
  tool: { name: "lt"; version: string };
  bench: {
    id: string;
    status: "completed" | "interrupted";
    startedAt: string;
    endedAt: string;
    mode: "single" | "ab";
    runsPerGroup: number;
    intervalMs: number;
    /** Ordem real de execução (A/B alternado em pares ABBA para reduzir viés de ordem e cache). */
    order: string[];
    seed: number;
  };
  groups: BenchGroup[];
  comparison?: ComparisonResult;
  warnings: string[];
}

export interface BenchOptions {
  groups: { label: "A" | "B"; scenario: Scenario }[];
  runs: number;
  intervalMs: number;
  reportsDir: string;
  toolVersion: string;
  runOptions: Omit<RunOptions, "toolVersion" | "runId" | "stopSignal" | "onProgress">;
  stopSignal?: AbortSignal;
  compare?: ComparisonOptions;
  /** Formatos gravados para cada rodada e para o resumo (padrão: DEFAULT_FORMATS). */
  formats?: ReportFormat[];
  onRunStart?: (info: { label: string; round: number; index: number; total: number }) => void;
  onRunDone?: (info: { label: string; round: number; report: RunReport }) => void;
  onProgress?: RunOptions["onProgress"];
  onWait?: (ms: number) => void;
}

/** Ordem das rodadas. A/B: pares alternados AB, BA, AB… (contrabalanceamento). */
export function benchOrder(mode: "single" | "ab", runs: number): ("A" | "B")[] {
  if (mode === "single") return Array.from({ length: runs }, () => "A" as const);
  const out: ("A" | "B")[] = [];
  for (let r = 0; r < runs; r++)
    out.push(...(r % 2 === 0 ? (["A", "B"] as const) : (["B", "A"] as const)));
  return out;
}

export function summarize(values: number[]): MetricSummary {
  const m = mean(values);
  const sd = stdev(values);
  return {
    n: values.length,
    median: median(values),
    mean: m,
    stdev: sd,
    cvPct: m ? (sd / Math.abs(m)) * 100 : 0,
    min: Math.min(...values),
    max: Math.max(...values),
    ci95: bootstrapCI(values),
  };
}

const KEYS: (keyof RunMetrics)[] = ["p50", "p90", "p95", "p99", "mean", "rps", "errorRate"];

export function groupSummary(runs: BenchRun[]): BenchGroup["summary"] {
  const ok = runs.filter((r) => r.status === "completed" && !r.invalid);
  return Object.fromEntries(
    KEYS.map((k) => [k, summarize(ok.map((r) => r[k]))]),
  ) as BenchGroup["summary"];
}

export async function runBench(o: BenchOptions): Promise<{ report: BenchReport; file: string }> {
  const mode = o.groups.length === 2 ? "ab" : "single";
  const startedAt = new Date();
  const id = makeRunId(`bench-${o.groups.map((g) => g.scenario.name).join("-vs-")}`, startedAt);
  const dir = path.join(o.reportsDir, id);
  fs.mkdirSync(dir, { recursive: true });
  const order = benchOrder(mode, o.runs);
  const runs: Record<"A" | "B", BenchRun[]> = { A: [], B: [] };
  const executed: string[] = [];
  let interrupted = false;
  const rounds: Record<string, number> = { A: 0, B: 0 };

  for (let i = 0; i < order.length; i++) {
    if (o.stopSignal?.aborted) {
      interrupted = true;
      break;
    }
    if (i > 0 && o.intervalMs > 0) {
      o.onWait?.(o.intervalMs);
      await abortableSleep(o.intervalMs, o.stopSignal);
      if (o.stopSignal?.aborted) {
        interrupted = true;
        break;
      }
    }
    const label = order[i]!;
    const group = o.groups.find((g) => g.label === label)!;
    const round = ++rounds[label]!;
    o.onRunStart?.({ label, round, index: i + 1, total: order.length });
    const runId = `${label}${String(round).padStart(2, "0")}`;
    const report = await runScenario(group.scenario, {
      ...o.runOptions,
      toolVersion: o.toolVersion,
      runId,
      stopSignal: o.stopSignal,
      onProgress: o.onProgress,
    });
    const file = writeRunReports(report, path.join(dir, runId), o.formats)["report.json"]!;
    executed.push(runId);
    runs[label].push({
      id: runId,
      status: report.run.status,
      invalid: report.run.invalid,
      requests: report.summary.requests.total,
      errors: report.summary.requests.failed,
      report: path.relative(dir, file).split(path.sep).join("/"),
      ...runMetrics(report),
    });
    o.onRunDone?.({ label, round, report });
    if (report.run.status === "interrupted") {
      interrupted = true;
      break;
    }
  }

  const warnings: string[] = [];
  const groups: BenchGroup[] = o.groups.map((g) => {
    const rs = runs[g.label];
    const bad = rs.filter((r) => r.invalid || r.status !== "completed");
    if (bad.length) {
      warnings.push(
        `${g.label}: ${bad.length} rodada(s) excluída(s) da estatística (inválidas ou interrompidas): ${bad.map((r) => r.id).join(", ")}`,
      );
    }
    const valid = rs.length - bad.length;
    if (valid < MIN_BENCH_RUNS) {
      warnings.push(
        `${g.label}: só ${valid} rodada(s) válida(s); recomendado ≥ ${MIN_BENCH_RUNS}.`,
      );
    }
    return {
      label: g.label,
      scenario: g.scenario.name,
      scenarioFile: g.scenario.sourceFile,
      baseUrl: g.scenario.target.baseUrl,
      runs: rs,
      summary: groupSummary(rs),
    };
  });
  for (const g of groups) {
    if (g.summary.p95.cvPct > 10) {
      warnings.push(
        `${g.label}: p95 variou ${g.summary.p95.cvPct.toFixed(1)}% entre rodadas (CV): ambiente ruidoso; diferenças menores que isso dificilmente serão detectáveis.`,
      );
    }
  }

  let comparison: ComparisonResult | undefined;
  if (mode === "ab") {
    const valid = (rs: BenchRun[]) => rs.filter((r) => r.status === "completed" && !r.invalid);
    const [ga, gb] = groups;
    const extra: string[] = [];
    if (ga!.scenario !== gb!.scenario)
      extra.push(`cenários diferentes ("${ga!.scenario}" × "${gb!.scenario}")`);
    comparison = compareGroups(
      { id: `${id}/A`, scenario: ga!.scenario, runs: valid(ga!.runs) },
      { id: `${id}/B`, scenario: gb!.scenario, runs: valid(gb!.runs) },
      o.compare,
      extra,
    );
  }

  const report: BenchReport = {
    schemaVersion: 1,
    kind: "bench",
    tool: { name: "lt", version: o.toolVersion },
    bench: {
      id,
      status: interrupted ? "interrupted" : "completed",
      startedAt: startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      mode,
      runsPerGroup: o.runs,
      intervalMs: o.intervalMs,
      order: executed,
      seed: o.groups[0]!.scenario.seed,
    },
    groups,
    ...(comparison ? { comparison } : {}),
    warnings,
  };
  const file = writeBenchReports(report, dir, o.formats)["bench.json"]!;
  return { report, file };
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export function isBenchReport(x: unknown): x is BenchReport {
  return !!x && typeof x === "object" && (x as { kind?: string }).kind === "bench";
}
