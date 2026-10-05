import path from "node:path";
import type { Command } from "commander";
import {
  ConfigError,
  ExitCode,
  MIN_BENCH_RUNS,
  VERSION,
  clearBaseline,
  compareGroups,
  compareRuns,
  getBaseline,
  getConfig,
  isBenchReport,
  listBaselines,
  loadReport,
  loadScenarioFile,
  resolveInside,
  resolveWorkers,
  runBench,
  setBaseline,
  type ComparisonOptions,
  type ComparisonResult,
  type RunReport,
  type Scenario,
} from "@lt/core";
import {
  RunControl,
  addCommonRunOptions,
  authorize,
  durationArg,
  limitsFrom,
  percentArg,
  positiveInt,
  probabilityArg,
  progressPrinter,
  type CommonRunFlags,
} from "./run-support.js";
import { c, printBench, printComparison } from "./ui.js";

interface StatFlags {
  alpha: number;
  minEffect: number;
  failOnRegression?: boolean;
}

interface BenchFlags extends CommonRunFlags, StatFlags {
  runs: number;
  interval: number;
  ab?: string;
  abTarget?: string;
  out?: string;
}

const statOptions = (cmd: Command) =>
  cmd
    .option("--alpha <p>", "nível de significância", probabilityArg, 0.05)
    .option("--min-effect <pct>", "menor diferença relevante (latência/vazão)", percentArg, 5)
    .option("--fail-on-regression", "exit 1 se B for significativamente pior");

const compareOpts = (f: StatFlags): ComparisonOptions => ({
  alpha: f.alpha,
  minEffectPct: f.minEffect,
});

/** Mesmo cenário apontando para outra URL (A/B de versões). */
function withBaseUrl(sc: Scenario, baseUrl: string): Scenario {
  if (!/^https?:\/\//.test(baseUrl))
    throw new ConfigError("--ab-target deve começar com http:// ou https://");
  return { ...sc, target: { ...sc.target, baseUrl: baseUrl.replace(/\/+$/, "") } };
}

export function registerBenchCommands(program: Command): void {
  addCommonRunOptions(
    statOptions(
      program
        .command("bench")
        .description(
          `roda o cenário N vezes (≥ ${MIN_BENCH_RUNS}) e resume mediana, IC 95% e variabilidade; --ab compara duas versões`,
        )
        .argument("<cenario>", "cenário (grupo A)")
        .option(
          "-n, --runs <n>",
          `rodadas por grupo (mínimo ${MIN_BENCH_RUNS})`,
          positiveInt,
          MIN_BENCH_RUNS,
        )
        .option(
          "--interval <duração>",
          "pausa entre rodadas (esfriar conexões/caches)",
          durationArg,
          5000,
        )
        .option("--ab <cenarioB>", "A/B: segundo cenário (grupo B)")
        .option("--ab-target <url>", "A/B: mesmo cenário contra outra URL base (grupo B)")
        .option("-o, --out <dir>", "diretório de relatórios (dentro do projeto)"),
    ),
  ).action(async (file: string, flags: BenchFlags) => {
    const cfg = getConfig();
    if (flags.runs < MIN_BENCH_RUNS) {
      throw new ConfigError(
        `use ao menos ${MIN_BENCH_RUNS} rodadas (--runs): com menos, nenhuma diferença pode ser estatisticamente detectada`,
      );
    }
    if (flags.ab && flags.abTarget) throw new ConfigError("use --ab ou --ab-target, não os dois");
    const a = loadScenarioFile(file);
    let b: Scenario | undefined;
    if (flags.ab) {
      // mesma semente: os dois grupos recebem exatamente os mesmos dados
      b = loadScenarioFile(flags.ab, { seed: a.seed });
    } else if (flags.abTarget) b = withBaseUrl(a, flags.abTarget);

    const limits = limitsFrom(flags);
    const load = await authorize(a, flags, limits);
    if (b) await authorize(b, flags, limits);
    const reportsDir = flags.out ? resolveInside(cfg.root, flags.out, "--out") : cfg.reportsDir;
    const control = new RunControl(`bench ${a.name}`);
    const groups = [
      { label: "A" as const, scenario: a },
      ...(b ? [{ label: "B" as const, scenario: b }] : []),
    ];
    const total = flags.runs * groups.length;
    console.log(
      `${c.bold("lt bench")} ${c.cyan(a.name)}${b ? ` × ${c.cyan(b.name === a.name ? b.target.baseUrl : b.name)}` : ""}  ` +
        `${flags.runs} rodada(s)${b ? " por grupo (ordem AB, BA, AB…)" : ""}, intervalo ${flags.interval / 1000}s, ` +
        `${resolveWorkers(a, flags.workers)} worker(s)`,
    );
    let prefix = "";
    const progress = progressPrinter(flags.quiet, a.load.stages.length, () => prefix);
    const { report, file: out } = await runBench({
      groups,
      runs: flags.runs,
      intervalMs: flags.interval,
      reportsDir,
      toolVersion: VERSION,
      runOptions: {
        connections: load.connections,
        workers: flags.workers,
        maxRps: limits.maxRps,
        systemMetrics: flags.systemMetrics !== false,
      },
      stopSignal: control.signal,
      compare: compareOpts(flags),
      onRunStart: ({ label, round, index }) => {
        prefix = `[${b ? `${label} ` : ""}${round}/${flags.runs} · ${index}/${total}] `;
      },
      onProgress: progress.onProgress,
      onRunDone: ({ label, round, report: r }) => {
        progress.clear();
        const l = r.summary.latencyMs;
        console.log(
          `  ${b ? `${label} ` : ""}rodada ${round}: p50 ${l.p50.toFixed(2)}  p95 ${l.p95.toFixed(2)}  p99 ${l.p99.toFixed(2)} ms  ` +
            `${r.summary.rps.achieved.toFixed(1)} req/s  erros ${(r.summary.errorRate * 100).toFixed(2)}%` +
            (r.run.invalid ? c.red("  [inválida]") : "") +
            (r.run.status !== "completed" ? c.yellow(`  [${r.run.status}]`) : ""),
        );
      },
      onWait: (ms) => {
        if (!flags.quiet && process.stdout.isTTY)
          process.stdout.write(c.dim(`  aguardando ${ms / 1000}s…`));
      },
    });
    progress.clear();
    control.dispose();
    printBench(report, path.relative(process.cwd(), out) || out);
    let code: number = ExitCode.OK;
    if (report.bench.status === "interrupted") code = ExitCode.INTERRUPTED;
    else if (report.groups.some((g) => g.summary.p50.n < MIN_BENCH_RUNS))
      code = ExitCode.INVALID_RUN;
    else if (flags.failOnRegression && report.comparison?.regression)
      code = ExitCode.THRESHOLDS_FAILED;
    process.exitCode = code;
  });

  statOptions(
    program
      .command("compare")
      .description("compara duas execuções (ou dois benchmarks) com teste de significância")
      .argument("<a>", "relatório A (report.json, bench.json, pasta ou id em reports/)")
      .argument("[b]", "relatório B (omitido: usa o A/B de um bench.json)")
      .option("--block <s>", "execuções únicas: tamanho do bloco em segundos", positiveInt, 5)
      .option("--json", "imprime o resultado em JSON"),
  ).action(
    (
      refA: string,
      refB: string | undefined,
      flags: StatFlags & { block: number; json?: boolean },
    ) => {
      const { reportsDir } = getConfig();
      const A = loadReport(refA, reportsDir).report;
      const opts = { ...compareOpts(flags), blockSeconds: flags.block };
      let result: ComparisonResult;
      if (!refB) {
        if (!isBenchReport(A) || A.groups.length !== 2) {
          throw new ConfigError("informe dois relatórios, ou um bench.json de A/B (lt bench --ab)");
        }
        const ok = (g: (typeof A.groups)[number]) =>
          g.runs.filter((r) => r.status === "completed" && !r.invalid);
        result = compareGroups(
          { id: `${A.bench.id}/A`, scenario: A.groups[0]!.scenario, runs: ok(A.groups[0]!) },
          { id: `${A.bench.id}/B`, scenario: A.groups[1]!.scenario, runs: ok(A.groups[1]!) },
          opts,
        );
      } else {
        const B = loadReport(refB, reportsDir).report;
        if (isBenchReport(A) !== isBenchReport(B)) {
          throw new ConfigError(
            "compare execução com execução ou benchmark com benchmark (para checar uma execução contra um benchmark, use lt baseline)",
          );
        }
        if (isBenchReport(A) && isBenchReport(B)) {
          const ok = (g: (typeof A.groups)[number]) =>
            g.runs.filter((r) => r.status === "completed" && !r.invalid);
          result = compareGroups(
            { id: A.bench.id, scenario: A.groups[0]!.scenario, runs: ok(A.groups[0]!) },
            { id: B.bench.id, scenario: B.groups[0]!.scenario, runs: ok(B.groups[0]!) },
            opts,
          );
        } else result = compareRuns(A as RunReport, B as RunReport, opts);
      }
      if (flags.json) console.log(JSON.stringify(result, null, 2));
      else printComparison(result);
      if (flags.failOnRegression && result.regression)
        process.exitCode = ExitCode.THRESHOLDS_FAILED;
    },
  );

  const bl = program
    .command("baseline")
    .description("baselines por cenário (usadas por lt run --baseline)");
  bl.command("set")
    .description("marca uma execução (ou benchmark de um cenário) como baseline do seu cenário")
    .argument("<relatorio>", "report.json, bench.json, pasta ou id em reports/")
    .action((ref: string) => {
      const cfg = getConfig();
      const { report, file } = loadReport(ref, cfg.reportsDir);
      const e = setBaseline(cfg.dataDir, report, path.relative(cfg.root, file));
      console.log(`${c.green("✓")} baseline de "${e.scenario}" ← ${e.source} (${e.kind})`);
    });
  bl.command("list")
    .description("lista as baselines")
    .action(() => {
      const items = listBaselines(getConfig().dataDir);
      if (!items.length)
        console.log("nenhuma baseline (use lt baseline set ou lt run --save-baseline)");
      for (const b of items)
        console.log(
          `  ${b.scenario.padEnd(30)} ${b.kind.padEnd(5)} ${b.setAt.slice(0, 16)}  ${b.source}`,
        );
    });
  bl.command("show")
    .description("mostra a baseline de um cenário")
    .argument("<cenario>", "nome do cenário")
    .action((name: string) => {
      const e = getBaseline(getConfig().dataDir, name);
      if (!e) throw new ConfigError(`sem baseline para "${name}"`);
      const r = e.report;
      console.log(`${c.bold(e.scenario)}  ${e.kind}  definida em ${e.setAt}  (${e.source})`);
      if (isBenchReport(r)) {
        const s = r.groups[0]!.summary;
        console.log(
          `  ${s.p50.n} rodadas · p50 ${s.p50.median.toFixed(2)}  p95 ${s.p95.median.toFixed(2)}  p99 ${s.p99.median.toFixed(2)} ms (medianas)`,
        );
      } else {
        const l = r.summary.latencyMs;
        console.log(
          `  p50 ${l.p50.toFixed(2)}  p95 ${l.p95.toFixed(2)}  p99 ${l.p99.toFixed(2)} ms  ${r.summary.rps.achieved} req/s`,
        );
      }
    });
  bl.command("clear")
    .description("remove a baseline de um cenário")
    .argument("<cenario>", "nome do cenário")
    .action((name: string) => {
      if (clearBaseline(getConfig().dataDir, name))
        console.log(`${c.green("✓")} baseline de "${name}" removida`);
      else console.log(`sem baseline para "${name}"`);
    });
}
