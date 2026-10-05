import fs from "node:fs";
import path from "node:path";
import { InvalidArgumentError, type Command } from "commander";
import {
  ConfigError,
  ExitCode,
  RESPONSIBLE_USE_NOTICE,
  checkTarget,
  enforceLimits,
  formatDuration,
  getConfig,
  parseDuration,
  type Limits,
  type LoadSummary,
  type ProgressSnapshot,
  type RunReport,
  type Scenario,
} from "@lt/core";
import { ask, c, progressLine } from "./ui.js";

export const positiveInt = (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0)
    throw new InvalidArgumentError("deve ser um inteiro positivo");
  return n;
};

export const workersArg = (v: string): number | "auto" => (v === "auto" ? "auto" : positiveInt(v));

/** "10%", "10" ou "0.5%" → número em %. */
export const percentArg = (v: string) => {
  const n = Number(v.replace(/%$/, ""));
  if (!Number.isFinite(n) || n < 0) throw new InvalidArgumentError('use um percentual, ex.: "10%"');
  return n;
};

export const durationArg = (v: string) => {
  try {
    return parseDuration(v);
  } catch (e) {
    throw new InvalidArgumentError((e as Error).message);
  }
};

export const probabilityArg = (v: string) => {
  const n = Number(v);
  if (!(n > 0 && n < 1)) throw new InvalidArgumentError("deve estar entre 0 e 1 (ex.: 0.05)");
  return n;
};

export interface CommonRunFlags {
  iOwnThisTarget?: boolean;
  confirmTarget?: string;
  maxRps?: number;
  maxConnections?: number;
  maxVus?: number;
  workers?: number | "auto";
  systemMetrics?: boolean;
  quiet?: boolean;
}

/** Opções comuns a `run` e `bench` (segurança, workers, coleta). */
export function addCommonRunOptions(cmd: Command): Command {
  return cmd
    .option("--i-own-this-target", "permite alvo fora da allowlist (exige confirmação)")
    .option("--confirm-target <host>", "confirmação não interativa do host (CI)")
    .option("--max-rps <n>", "eleva o teto de RPS desta execução", positiveInt)
    .option("--max-connections <n>", "eleva o teto de conexões desta execução", positiveInt)
    .option("--max-vus <n>", "eleva o teto de VUs desta execução (modelo fechado)", positiveInt)
    .option(
      "-w, --workers <n|auto>",
      "threads geradoras de carga (padrão: load.workers ou auto)",
      workersArg,
    )
    .option("--no-system-metrics", "não coleta CPU/memória da máquina")
    .option("-q, --quiet", "sem progresso ao vivo");
}

export function limitsFrom(flags: CommonRunFlags): Limits {
  const cfg = getConfig();
  return {
    maxRps: flags.maxRps ?? cfg.maxRps,
    maxConnections: flags.maxConnections ?? cfg.maxConnections,
    maxDurationMs: cfg.maxDurationMs,
    maxVus: flags.maxVus ?? cfg.maxVus,
  };
}

/** Aplica tetos de segurança e a allowlist (com confirmação explícita fora dela). */
export async function authorize(
  scenario: Scenario,
  flags: CommonRunFlags,
  limits: Limits,
): Promise<LoadSummary> {
  const cfg = getConfig();
  const load = enforceLimits(scenario, limits);
  const target = await checkTarget(scenario.target.baseUrl, cfg.allowedTargets);
  if (target.allowed) return load;
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
    load.model === "open"
      ? `  Taxa máxima: ${load.peakRps} rps   Duração: ${formatDuration(load.durationMs)}   ~${load.expectedRequests} requisições`
      : `  VUs: até ${load.peakVus} (teto de ${load.peakRps} rps)   Duração: ${formatDuration(load.durationMs)}`,
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
    throw new ConfigError(`terminal não interativo: confirme com --confirm-target ${target.host}`);
  }
  return load;
}

/**
 * Ctrl+C (gracioso; o segundo força), SIGTERM e o arquivo de parada usado por `npm run stop`.
 * Chame dispose() ao terminar.
 */
export class RunControl {
  readonly controller = new AbortController();
  private sigints = 0;
  private readonly runFile: string;
  private readonly stopFile: string;
  private readonly poll: NodeJS.Timeout;

  constructor(label: string) {
    const cfg = getConfig();
    fs.mkdirSync(cfg.runDir, { recursive: true });
    this.runFile = path.join(cfg.runDir, `cli-${process.pid}.json`);
    this.stopFile = path.join(cfg.runDir, `cli-${process.pid}.stop`);
    fs.writeFileSync(
      this.runFile,
      JSON.stringify({
        pid: process.pid,
        scenario: label,
        startedAt: new Date().toISOString(),
        entry: process.argv[1],
      }),
    );
    this.poll = setInterval(() => {
      if (fs.existsSync(this.stopFile) && !this.signal.aborted) {
        process.stderr.write(c.yellow("\nParada solicitada por `npm run stop`.\n"));
        this.controller.abort();
      }
    }, 300);
    process.on("SIGINT", this.onSigint);
    process.on("SIGTERM", this.onSigterm);
    process.on("exit", this.dispose);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  private onSigint = () => {
    this.sigints++;
    if (this.sigints === 1) {
      process.stderr.write(
        c.yellow("\nParando: drenando requisições em andamento (Ctrl+C de novo força a saída)…\n"),
      );
      this.controller.abort();
    } else {
      process.stderr.write(c.red("\nSaída forçada; relatório parcial não foi salvo.\n"));
      process.exit(ExitCode.INTERRUPTED);
    }
  };

  private onSigterm = () => this.controller.abort();

  dispose = () => {
    clearInterval(this.poll);
    process.off("SIGINT", this.onSigint);
    process.off("SIGTERM", this.onSigterm);
    for (const f of [this.runFile, this.stopFile]) fs.rmSync(f, { force: true });
  };
}

/** Linha de progresso: reescrita no TTY; a cada 5 s fora dele. */
export function progressPrinter(
  quiet: boolean | undefined,
  stages: number,
  prefix: () => string = () => "",
) {
  if (quiet) return { onProgress: undefined, clear: () => {} };
  const tty = process.stdout.isTTY;
  let lastLog = 0;
  return {
    onProgress: (p: ProgressSnapshot) => {
      const line = prefix() + progressLine(p, stages);
      if (tty) process.stdout.write(`\r\x1b[2K${line}`);
      else if (p.elapsedMs - lastLog >= 5000) {
        lastLog = p.elapsedMs;
        console.log(line);
      }
    },
    clear: () => {
      if (tty) process.stdout.write("\r\x1b[2K");
    },
  };
}

export function exitCodeFor(r: RunReport): number {
  if (r.run.status === "interrupted") return ExitCode.INTERRUPTED;
  if (r.run.invalid) return ExitCode.INVALID_RUN;
  if (r.thresholds.some((t) => !t.passed)) return ExitCode.THRESHOLDS_FAILED;
  return ExitCode.OK;
}
