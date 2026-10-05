#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import {
  ExitCode,
  LtError,
  RESPONSIBLE_USE_NOTICE,
  VERSION,
  checkBaseline,
  formatDuration,
  getBaseline,
  getConfig,
  loadScenarioFile,
  resolveInside,
  resolveWorkers,
  runScenario,
  setBaseline,
  writeJsonReport,
} from "@lt/core";
import { registerBenchCommands } from "./bench-commands.js";
import {
  RunControl,
  addCommonRunOptions,
  authorize,
  exitCodeFor,
  limitsFrom,
  percentArg,
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
  baseline?: boolean;
  regressionThreshold: number;
  saveBaseline?: boolean;
}

async function runCommand(file: string, flags: RunFlags): Promise<number> {
  const cfg = getConfig();
  const scenario = loadScenarioFile(file);
  const limits = limitsFrom(flags);
  const load = await authorize(scenario, flags, limits);
  const reportsDir = flags.out ? resolveInside(cfg.root, flags.out, "--out") : cfg.reportsDir;
  const baseline = flags.baseline ? getBaseline(cfg.dataDir, scenario.name) : null;

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
    onProgress: progress.onProgress,
  });
  progress.clear();
  control.dispose();

  const reportPath = writeJsonReport(report, reportsDir);
  printSummary(report, path.relative(process.cwd(), reportPath) || reportPath);
  let code = exitCodeFor(report);

  if (flags.baseline) {
    if (!baseline) {
      console.log(
        c.yellow(
          `\n! sem baseline para "${scenario.name}" (crie com --save-baseline ou lt baseline set)`,
        ),
      );
    } else if (report.run.status === "completed" && !report.run.invalid) {
      const check = checkBaseline(report, baseline, { thresholdPct: flags.regressionThreshold });
      console.log(
        c.bold(
          `\nBaseline (${baseline.kind}, definida em ${baseline.setAt.slice(0, 16).replace("T", " ")})`,
        ),
      );
      printComparison(check.comparison);
      if (check.regression && code === ExitCode.OK) code = ExitCode.THRESHOLDS_FAILED;
    }
  }
  if (flags.saveBaseline) {
    if (code === ExitCode.OK) {
      setBaseline(cfg.dataDir, report, path.relative(cfg.root, reportPath));
      console.log(c.green(`✓ execução salva como baseline de "${scenario.name}"`));
    } else {
      console.log(
        c.yellow(
          "! baseline não atualizada: a execução não passou (thresholds, regressão ou inválida)",
        ),
      );
    }
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
    .description("executa um cenário e gera o relatório")
    .argument("<cenario>", "arquivo YAML/JSON do cenário")
    .option("-o, --out <dir>", "diretório de relatórios (dentro do projeto)")
    .option("--baseline", "compara com a baseline do cenário; regressão → exit 1")
    .option(
      "--regression-threshold <pct>",
      "piora mínima para contar como regressão",
      percentArg,
      10,
    )
    .option("--save-baseline", "salva esta execução como baseline (se passar)"),
).action(async (file: string, flags: RunFlags) => {
  process.exitCode = await runCommand(file, flags);
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
