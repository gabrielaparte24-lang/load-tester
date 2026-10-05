import fs from "node:fs";
import path from "node:path";
import { isBenchReport, type BenchReport } from "./bench.js";
import {
  compareRuns,
  type ComparisonOptions,
  type ComparisonResult,
  type MetricComparison,
} from "./compare.js";
import { ConfigError } from "./errors.js";
import { slugify, type RunReport } from "./report.js";

export type AnyReport = RunReport | BenchReport;

/**
 * Carrega um relatório por caminho (report.json, bench.json ou a pasta) ou pelo id da execução
 * (pasta dentro de reports/, ex.: 20261005-141839-smoke ou bench-…/A01).
 */
export function loadReport(ref: string, reportsDir: string): { report: AnyReport; file: string } {
  const candidates = [ref, path.join(reportsDir, ref)].flatMap((p) => [
    p,
    path.join(p, "report.json"),
    path.join(p, "bench.json"),
  ]);
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) {
      let data: unknown;
      try {
        data = JSON.parse(fs.readFileSync(c, "utf8"));
      } catch (e) {
        throw new ConfigError(`"${c}" não é um JSON válido: ${(e as Error).message}`);
      }
      const d = data as { schemaVersion?: number; run?: unknown };
      if (d?.schemaVersion !== 1 || (!isBenchReport(data) && !d.run)) {
        throw new ConfigError(`"${c}" não é um relatório do lt (schemaVersion 1)`);
      }
      return { report: data as AnyReport, file: c };
    }
  }
  throw new ConfigError(
    `relatório "${ref}" não encontrado (caminho de report.json/bench.json ou id em ${reportsDir})`,
  );
}

export interface BaselineEntry {
  scenario: string;
  setAt: string;
  source: string;
  kind: "run" | "bench";
  report: AnyReport;
}

const dirOf = (dataDir: string) => path.join(dataDir, "baselines");
const fileOf = (dataDir: string, scenario: string) =>
  path.join(dirOf(dataDir), `${slugify(scenario)}.json`);

export function scenarioOf(r: AnyReport): string {
  return isBenchReport(r) ? r.groups[0]!.scenario : r.run.scenario;
}

/** Marca um relatório como baseline do seu cenário (uma por cenário; substitui a anterior). */
export function setBaseline(dataDir: string, report: AnyReport, source: string): BaselineEntry {
  if (!isBenchReport(report)) {
    if (report.run.invalid)
      throw new ConfigError("execução inválida (gerador saturado) não pode ser baseline");
    if (report.run.status !== "completed")
      throw new ConfigError("só execuções concluídas podem ser baseline");
  } else if (report.groups.length !== 1) {
    throw new ConfigError(
      "benchmark A/B não pode ser baseline (use um benchmark de um cenário só)",
    );
  }
  const entry: BaselineEntry = {
    scenario: scenarioOf(report),
    setAt: new Date().toISOString(),
    source,
    kind: isBenchReport(report) ? "bench" : "run",
    report,
  };
  fs.mkdirSync(dirOf(dataDir), { recursive: true });
  fs.writeFileSync(fileOf(dataDir, entry.scenario), JSON.stringify(entry, null, 2));
  return entry;
}

export function getBaseline(dataDir: string, scenario: string): BaselineEntry | null {
  const f = fileOf(dataDir, scenario);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, "utf8")) as BaselineEntry;
}

export function listBaselines(dataDir: string): Omit<BaselineEntry, "report">[] {
  const d = dirOf(dataDir);
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const { report: _r, ...meta } = JSON.parse(
        fs.readFileSync(path.join(d, f), "utf8"),
      ) as BaselineEntry;
      return meta;
    });
}

export function clearBaseline(dataDir: string, scenario: string): boolean {
  const f = fileOf(dataDir, scenario);
  if (!fs.existsSync(f)) return false;
  fs.rmSync(f);
  return true;
}

export interface BaselineCheck {
  regression: boolean;
  comparison: ComparisonResult;
}

/**
 * Compara a execução atual com a baseline do cenário.
 *  - baseline = execução: blocos de 5 s + Mann-Whitney (ver compareRuns); regressão quando a piora
 *    é significativa E maior que o limite (thresholdPct).
 *  - baseline = benchmark: a execução atual é comparada à faixa observada nas rodadas: regressão
 *    quando fica pior que a mediana por mais que o limite E fora da faixa (máx/mín) das rodadas.
 */
export function checkBaseline(
  current: RunReport,
  baseline: BaselineEntry,
  opts: ComparisonOptions & { thresholdPct: number },
): BaselineCheck {
  const o: ComparisonOptions = { ...opts, minEffectPct: opts.thresholdPct };
  if (!isBenchReport(baseline.report)) {
    const comparison = compareRuns(baseline.report, current, o);
    comparison.a.label = "baseline";
    comparison.b.label = "atual";
    comparison.conclusion = comparison.conclusion
      .replace("REGRESSÃO em B", "REGRESSÃO na execução atual")
      .replace("B é melhor", "a execução atual é melhor");
    return { regression: comparison.regression, comparison };
  }
  const g = baseline.report.groups[0]!;
  const cur = {
    p50: current.summary.latencyMs.p50,
    p95: current.summary.latencyMs.p95,
    p99: current.summary.latencyMs.p99,
    rps: current.summary.rps.achieved,
    errorRate: current.summary.errorRate,
  };
  const metrics: MetricComparison[] = (Object.keys(cur) as (keyof typeof cur)[]).map((k) => {
    const s = g.summary[k];
    const v = cur[k];
    const better = k === "rps" ? "higher" : "lower";
    const delta = v - s.median;
    const deltaPct = s.median ? (delta / Math.abs(s.median)) * 100 : null;
    const outside = better === "lower" ? v > s.max : v < s.min;
    const worse = better === "lower" ? delta > 0 : delta < 0;
    const relevant =
      k === "errorRate"
        ? Math.abs(delta) * 100 >= (opts.minErrorPp ?? 0.5)
        : (deltaPct === null || Math.abs(deltaPct) >= opts.thresholdPct) &&
          (k === "rps" || Math.abs(delta) >= (opts.minAbsMs ?? 1));
    return {
      metric: k,
      label: k === "rps" ? "vazão" : k === "errorRate" ? "taxa de erro" : `latência ${k}`,
      unit: k === "rps" ? "req/s" : k === "errorRate" ? "%" : "ms",
      better,
      a: s.median,
      b: v,
      delta,
      deltaPct,
      estimate: delta,
      ci: s.ci95,
      p: NaN,
      pAdj: NaN,
      test: `faixa de ${s.n} rodadas (mín ${s.min.toFixed(2)}, máx ${s.max.toFixed(2)})`,
      nA: s.n,
      nB: 1,
      verdict: outside && relevant ? (worse ? "pior" : "melhor") : "sem diferença",
    } satisfies MetricComparison;
  });
  const worse = metrics.filter((m) => m.verdict === "pior");
  const comparison: ComparisonResult = {
    kind: "bench",
    a: {
      label: "baseline",
      id: baseline.report.bench.id,
      scenario: g.scenario,
      n: g.summary.p95.n,
    },
    b: { label: "atual", id: current.run.id, scenario: current.run.scenario, n: 1 },
    method: `execução atual contra a faixa das rodadas da baseline; limite ${opts.thresholdPct}%`,
    alpha: NaN,
    minEffectPct: opts.thresholdPct,
    metrics,
    regression: worse.length > 0,
    improvement: metrics.some((m) => m.verdict === "melhor"),
    conclusion: worse.length
      ? `REGRESSÃO: ${worse.map((m) => m.label).join(", ")}`
      : "sem regressão acima do limite",
    warnings: [],
  };
  return { regression: comparison.regression, comparison };
}
