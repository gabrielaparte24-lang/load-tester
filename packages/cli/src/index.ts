#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Command, InvalidArgumentError } from "commander";
import {
  ConfigError,
  ExitCode,
  LtError,
  RESPONSIBLE_USE_NOTICE,
  VERSION,
  checkTarget,
  enforceLimits,
  formatDuration,
  getConfig,
  loadScenarioFile,
  resolveInside,
  runScenario,
  writeJsonReport,
  type RunReport,
} from "@lt/core";
import { ask, c, printSummary, progressLine } from "./ui.js";

// Saída fechada (ex.: `lt run x.yaml | head`) não pode derrubar um teste em andamento nem o relatório.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code !== "EPIPE") throw e;
  });
}

const positiveInt = (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0)
    throw new InvalidArgumentError("deve ser um inteiro positivo");
  return n;
};

interface RunFlags {
  out?: string;
  iOwnThisTarget?: boolean;
  confirmTarget?: string;
  maxRps?: number;
  maxConnections?: number;
  quiet?: boolean;
}

export function exitCodeFor(r: RunReport): number {
  if (r.run.status === "interrupted") return ExitCode.INTERRUPTED;
  if (r.run.invalid) return ExitCode.INVALID_RUN;
  if (r.thresholds.some((t) => !t.passed)) return ExitCode.THRESHOLDS_FAILED;
  return ExitCode.OK;
}

async function runCommand(file: string, flags: RunFlags): Promise<number> {
  const cfg = getConfig();
  const scenario = loadScenarioFile(file);
  const limits = {
    maxRps: flags.maxRps ?? cfg.maxRps,
    maxConnections: flags.maxConnections ?? cfg.maxConnections,
    maxDurationMs: cfg.maxDurationMs,
  };
  const load = enforceLimits(scenario, limits);

  const target = await checkTarget(scenario.target.baseUrl, cfg.allowedTargets);
  if (!target.allowed) {
    if (!flags.iOwnThisTarget) {
      throw new ConfigError(
        `alvo "${target.host}" ${target.reason}.\n` +
          `  ${RESPONSIBLE_USE_NOTICE}\n` +
          `  Se o sistema é seu (ou você tem autorização por escrito), repita com --i-own-this-target,\n` +
          `  ou adicione o host/faixa em ALLOWED_TARGETS no .env.`,
      );
    }
    console.log(c.yellow(`\n⚠ ALVO FORA DA ALLOWLIST\n  ${RESPONSIBLE_USE_NOTICE}`));
    console.log(
      `  Host:        ${target.host} (${target.addresses.join(", ") || "sem IP resolvido"})`,
    );
    console.log(
      `  Taxa máxima: ${load.peakRps} rps   Duração: ${formatDuration(load.durationMs)}   ~${load.expectedRequests} requisições`,
    );
    if (flags.confirmTarget !== undefined) {
      if (flags.confirmTarget.toLowerCase() !== target.host) {
        throw new ConfigError(
          `--confirm-target "${flags.confirmTarget}" não confere com o host "${target.host}"`,
        );
      }
    } else if (process.stdin.isTTY) {
      const typed = await ask(`  Digite o host (${target.host}) para confirmar: `);
      if (typed.toLowerCase() !== target.host)
        throw new ConfigError("confirmação não confere; execução cancelada");
    } else {
      throw new ConfigError(
        `terminal não interativo: confirme com --confirm-target ${target.host}`,
      );
    }
  }

  const reportsDir = flags.out ? resolveInside(cfg.root, flags.out, "--out") : cfg.reportsDir;

  const stopper = new AbortController();
  let sigints = 0;
  const onSigint = () => {
    sigints++;
    if (sigints === 1) {
      process.stderr.write(
        c.yellow("\nParando: drenando requisições em andamento (Ctrl+C de novo força a saída)…\n"),
      );
      stopper.abort();
    } else {
      process.stderr.write(c.red("\nSaída forçada; relatório parcial não foi salvo.\n"));
      process.exit(ExitCode.INTERRUPTED);
    }
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", () => stopper.abort());

  // Registro para o `npm run stop` conseguir interromper este teste com segurança.
  fs.mkdirSync(cfg.runDir, { recursive: true });
  const runFile = path.join(cfg.runDir, `cli-${process.pid}.json`);
  const stopFile = path.join(cfg.runDir, `cli-${process.pid}.stop`);
  fs.writeFileSync(
    runFile,
    JSON.stringify({
      pid: process.pid,
      scenario: scenario.name,
      startedAt: new Date().toISOString(),
      entry: process.argv[1],
    }),
  );
  const stopPoll = setInterval(() => {
    if (fs.existsSync(stopFile)) {
      process.stderr.write(c.yellow("\nParada solicitada por `npm run stop`.\n"));
      stopper.abort();
    }
  }, 300);
  const cleanup = () => {
    clearInterval(stopPoll);
    for (const f of [runFile, stopFile]) fs.rmSync(f, { force: true });
  };
  process.on("exit", cleanup);

  if (!flags.quiet) {
    console.log(
      `${c.bold("lt")} ${VERSION}  ${c.cyan(scenario.name)} → ${scenario.target.baseUrl}  ` +
        `${formatDuration(load.durationMs)}, pico ${load.peakRps} rps, ${load.connections} conexões`,
    );
  }
  const tty = process.stdout.isTTY && !flags.quiet;
  let lastLog = 0;
  const report = await runScenario(scenario, {
    toolVersion: VERSION,
    connections: load.connections,
    stopSignal: stopper.signal,
    onProgress: flags.quiet
      ? undefined
      : (p) => {
          const line = progressLine(p, scenario.load.stages.length);
          if (tty) process.stdout.write(`\r\x1b[2K${line}`);
          else if (p.elapsedMs - lastLog >= 5000) {
            lastLog = p.elapsedMs;
            console.log(line);
          }
        },
  });
  if (tty) process.stdout.write("\r\x1b[2K");
  process.off("SIGINT", onSigint);
  cleanup();

  const reportPath = writeJsonReport(report, reportsDir);
  printSummary(report, path.relative(process.cwd(), reportPath) || reportPath);
  return exitCodeFor(report);
}

const program = new Command()
  .name("lt")
  .description(`Testador de carga e benchmarking de endpoints HTTP.\n${RESPONSIBLE_USE_NOTICE}`)
  .version(VERSION)
  .showHelpAfterError();

program
  .command("run")
  .description("executa um cenário e gera o relatório")
  .argument("<cenario>", "arquivo YAML/JSON do cenário")
  .option("-o, --out <dir>", "diretório de relatórios (dentro do projeto)")
  .option("--i-own-this-target", "permite alvo fora da allowlist (exige confirmação)")
  .option("--confirm-target <host>", "confirmação não interativa do host (CI)")
  .option("--max-rps <n>", "eleva o teto de RPS desta execução", positiveInt)
  .option("--max-connections <n>", "eleva o teto de conexões desta execução", positiveInt)
  .option("-q, --quiet", "sem progresso ao vivo")
  .action(async (file: string, flags: RunFlags) => {
    process.exitCode = await runCommand(file, flags);
  });

program
  .command("validate")
  .description("valida um cenário sem executar")
  .argument("<cenario...>", "arquivo(s) YAML/JSON")
  .action((files: string[]) => {
    for (const f of files) {
      const sc = loadScenarioFile(f);
      console.log(
        `${c.green("✓")} ${f}: "${sc.name}" válido (${sc.flow.length} etapa(s) de fluxo, ${sc.load.stages.length} etapa(s) de carga)`,
      );
    }
  });

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
