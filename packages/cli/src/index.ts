#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import {
  DEFAULT_FORMATS,
  ExitCode,
  LiveMetrics,
  LtError,
  REPORT_FORMATS,
  RESPONSIBLE_USE_NOTICE,
  VERSION,
  checkBaseline,
  formatDuration,
  getBaseline,
  getConfig,
  isBenchReport,
  loadReport,
  loadScenarioFile,
  parseFormats,
  resolveInside,
  resolveWorkers,
  runScenario,
  scenarioOf,
  setBaseline,
  writeBenchReports,
  writeRunReports,
  type BaselineEntry,
  type ComparisonResult,
  type ReportFormat,
} from "@lt/core";
import { registerBenchCommands } from "./bench-commands.js";
import {
  RunControl,
  addCommonRunOptions,
  authorize,
  exitCodeFor,
  limitsFrom,
  percentArg,
  positiveInt,
  progressPrinter,
  type CommonRunFlags,
} from "./run-support.js";
import { registerScenarioCommands } from "./scenario-commands.js";
import { c, printComparison, printSummary } from "./ui.js";

// Saída fechada (ex.: `lt run x.yaml | head`) não pode derrubar um teste em andamento nem o relatório.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code !== "EPIPE") throw e;
  });
}

interface RunFlags extends CommonRunFlags {
  out?: string;
  reportDir?: string;
  format: ReportFormat[];
  baseline?: boolean;
  baselineFile?: string;
  regressionThreshold: number;
  saveBaseline?: boolean;
  metricsPort?: number;
}

/** Baseline vinda de um arquivo (CI: baseline versionada no repositório). */
function baselineFromFile(ref: string): BaselineEntry {
  const cfg = getConfig();
  const { report, file } = loadReport(ref, cfg.reportsDir);
  return {
    scenario: scenarioOf(report),
    setAt: fs.statSync(file).mtime.toISOString(),
    source: path.relative(cfg.root, file),
    kind: isBenchReport(report) ? "bench" : "run",
    report,
  };
}

async function runCommand(file: string, flags: RunFlags): Promise<number> {
  const cfg = getConfig();
  const scenario = loadScenarioFile(file);
  const limits = limitsFrom(flags);
  const load = await authorize(scenario, flags, limits);
  const reportsDir = flags.out ? resolveInside(cfg.root, flags.out, "--out") : cfg.reportsDir;
  const fixedDir = flags.reportDir
    ? resolveInside(cfg.root, flags.reportDir, "--report-dir")
    : undefined;
  const baseline = flags.baselineFile
    ? baselineFromFile(flags.baselineFile)
    : flags.baseline
      ? getBaseline(cfg.dataDir, scenario.name)
      : null;

  const live = flags.metricsPort ? new LiveMetrics(scenario.name) : null;
  if (live) {
    await live.listen(flags.metricsPort!);
    if (!flags.quiet)
      console.log(c.dim(`métricas ao vivo: http://127.0.0.1:${flags.metricsPort}/metrics`));
  }
  const control = new RunControl(scenario.name);
  const workers = resolveWorkers(scenario, flags.workers);
  if (!flags.quiet) {
    console.log(
      `${c.bold("lt")} ${VERSION}  ${c.cyan(scenario.name)} → ${scenario.target.baseUrl}  ` +
        `${formatDuration(load.durationMs)}, ` +
        (load.model === "open"
          ? `pico ${load.peakRps} rps`
          : `até ${load.peakVus} VUs (teto ${load.peakRps} rps)`) +
        `, ${load.connections} conexões, ${workers} worker(s)`,
    );
  }
  const progress = progressPrinter(flags.quiet, scenario.load.stages.length);
  const report = await runScenario(scenario, {
    toolVersion: VERSION,
    connections: load.connections,
    stopSignal: control.signal,
    workers,
    maxRps: limits.maxRps,
    systemMetrics: flags.systemMetrics !== false,
    onProgress: (p) => {
      live?.update(p);
      progress.onProgress?.(p);
    },
  });
  progress.clear();
  control.dispose();
  live?.finish();

  let code = exitCodeFor(report);
  let comparison: ComparisonResult | undefined;
  if (flags.baseline || flags.baselineFile) {
    if (!baseline) {
      console.log(
        c.yellow(
          `\n! sem baseline para "${scenario.name}" (crie com --save-baseline ou lt baseline set)`,
        ),
      );
    } else if (report.run.status === "completed" && !report.run.invalid) {
      comparison = checkBaseline(report, baseline, {
        thresholdPct: flags.regressionThreshold,
      }).comparison;
      if (comparison.regression && code === ExitCode.OK) code = ExitCode.THRESHOLDS_FAILED;
    }
  }

  const dir = fixedDir ?? path.join(reportsDir, report.run.id);
  const files = writeRunReports(report, dir, flags.format, {
    comparison,
    baselineSource: baseline
      ? `${baseline.source} (${baseline.kind}, ${baseline.setAt.slice(0, 16).replace("T", " ")})`
      : undefined,
  });
  const rel = (f: string) => path.relative(process.cwd(), f) || f;
  printSummary(report, rel(files["report.html"] ?? files["report.json"]!));
  if (comparison && baseline) {
    console.log(c.bold(`\nBaseline (${baseline.kind}, ${baseline.source})`));
    printComparison(comparison);
  }
  const others = Object.keys(files).filter((k) => k !== "report.html");
  console.log(c.dim(`  Arquivos     ${rel(dir)}${path.sep}{${others.join(", ")}}`));

  if (flags.saveBaseline) {
    if (code === ExitCode.OK) {
      setBaseline(cfg.dataDir, report, path.relative(cfg.root, files["report.json"]!));
      console.log(c.green(`✓ execução salva como baseline de "${scenario.name}"`));
    } else {
      console.log(
        c.yellow(
          "! baseline não atualizada: a execução não passou (thresholds, regressão ou inválida)",
        ),
      );
    }
  }
  if (live) {
    // mantém /metrics disponível por um instante para a última coleta do Prometheus
    await new Promise((r) => setTimeout(r, 1000));
    await live.close();
  }
  return code;
}

const program = new Command()
  .name("lt")
  .description(`Testador de carga e benchmarking de endpoints HTTP.\n${RESPONSIBLE_USE_NOTICE}`)
  .version(VERSION)
  .showHelpAfterError();

addCommonRunOptions(
  program
    .command("run")
    .description("executa um cenário e gera os relatórios")
    .argument("<cenario>", "arquivo YAML/JSON do cenário")
    .option("-o, --out <dir>", "pasta-base dos relatórios (cada execução cria uma subpasta)")
    .option("--report-dir <dir>", "grava os relatórios exatamente nesta pasta (útil em CI)")
    .option(
      "-f, --format <lista>",
      `formatos: ${REPORT_FORMATS.join(",")} ou all`,
      parseFormats,
      DEFAULT_FORMATS,
    )
    .option("--baseline", "compara com a baseline do cenário; regressão → exit 1")
    .option(
      "--baseline-file <relatorio>",
      "compara com este report.json/bench.json (ex.: baseline versionada no CI)",
    )
    .option(
      "--regression-threshold <pct>",
      "piora mínima para contar como regressão",
      percentArg,
      10,
    )
    .option("--save-baseline", "salva esta execução como baseline (se passar)")
    .option(
      "--metrics-port <porta>",
      "expõe métricas Prometheus ao vivo em 127.0.0.1:<porta>/metrics",
      positiveInt,
    ),
).action(async (file: string, flags: RunFlags) => {
  process.exitCode = await runCommand(file, flags);
});

program
  .command("report")
  .description(
    "regenera os relatórios (HTML, CSV, Markdown, JUnit, Prometheus) a partir de um report.json ou bench.json",
  )
  .argument("<relatorio>", "report.json, bench.json, pasta ou id em reports/")
  .option(
    "-f, --format <lista>",
    `formatos: ${REPORT_FORMATS.join(",")} ou all`,
    parseFormats,
    DEFAULT_FORMATS,
  )
  .option("--report-dir <dir>", "pasta de saída (padrão: a do relatório)")
  .action((ref: string, flags: { format: ReportFormat[]; reportDir?: string }) => {
    const cfg = getConfig();
    const { report, file } = loadReport(ref, cfg.reportsDir);
    const dir = flags.reportDir
      ? resolveInside(cfg.root, flags.reportDir, "--report-dir")
      : resolveInside(cfg.root, path.dirname(path.resolve(file)), "pasta do relatório");
    const cmpFile = path.join(path.dirname(file), "baseline-comparison.json");
    const files = isBenchReport(report)
      ? writeBenchReports(report, dir, flags.format)
      : writeRunReports(report, dir, flags.format, {
          comparison: fs.existsSync(cmpFile)
            ? (JSON.parse(fs.readFileSync(cmpFile, "utf8")) as ComparisonResult)
            : undefined,
        });
    for (const f of Object.values(files))
      console.log(`${c.green("✓")} ${path.relative(process.cwd(), f) || f}`);
  });

registerScenarioCommands(program);
registerBenchCommands(program);

try {
  await program.parseAsync();
} catch (err) {
  if (err instanceof LtError) {
    console.error(c.red(`erro: ${err.message}`));
    process.exitCode = err.exitCode;
  } else {
    console.error(err);
    process.exitCode = ExitCode.CONFIG_ERROR;
  }
}
