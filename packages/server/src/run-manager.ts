import fs from "node:fs";
import path from "node:path";
import {
  ConfigError,
  LiveMetrics,
  LtError,
  VERSION,
  authorizeRun,
  makeRunId,
  resolveWorkers,
  runScenario,
  writeRunReports,
  type LoadSummary,
  type LtConfig,
  type ProgressSnapshot,
  type RunReport,
  type Scenario,
} from "@lt/core";
import type { EventHub, LogLine } from "./events.js";
import type { RunRow, Store } from "./store.js";

export class BusyError extends LtError {
  constructor(active: string) {
    super(`já existe uma execução em andamento (${active}); pare-a antes de iniciar outra`, 409);
  }
}

interface ActiveRun {
  id: string;
  scenarioId: string | null;
  scenario: Scenario;
  load: LoadSummary;
  workers: number;
  startedAt: string;
  controller: AbortController;
  history: ProgressSnapshot[];
  logs: LogLine[];
  live: LiveMetrics;
  done: Promise<void>;
}

const MAX_LOGS = 500;

/**
 * Executa cenários a partir da API. Por segurança roda uma execução por vez (carga de duas
 * execuções simultâneas no mesmo alvo invalidaria as duas medições). O progresso vai para o SSE,
 * o relatório para reports/<id>/ e o resumo para o SQLite.
 */
export class RunManager {
  private active = new Map<string, ActiveRun>();

  constructor(
    private readonly cfg: LtConfig,
    private readonly store: Store,
    private readonly hub: EventHub,
  ) {}

  list(): ActiveRun[] {
    return [...this.active.values()];
  }

  get(id: string): ActiveRun | undefined {
    return this.active.get(id);
  }

  summary(a: ActiveRun) {
    return {
      id: a.id,
      scenario: a.scenario.name,
      scenarioId: a.scenarioId,
      baseUrl: a.scenario.target.baseUrl,
      model: a.scenario.load.model,
      startedAt: a.startedAt,
      totalMs: a.load.durationMs,
      peakRps: a.load.peakRps,
      peakVus: a.load.peakVus,
      workers: a.workers,
      stages: a.scenario.load.model === "open" ? a.scenario.load.stages : a.scenario.load.vuStages,
      warmupMs: a.scenario.load.warmupMs,
      thresholds: a.scenario.thresholds,
      last: a.history[a.history.length - 1] ?? null,
    };
  }

  private log(a: ActiveRun, level: LogLine["level"], msg: string): void {
    const line: LogLine = { ts: new Date().toISOString(), level, msg };
    a.logs.push(line);
    if (a.logs.length > MAX_LOGS) a.logs.shift();
    this.hub.emit({ type: "log", runId: a.id, line });
  }

  async start(
    scenario: Scenario,
    opts: {
      scenarioId?: string | null;
      workers?: number | "auto";
      iOwnThisTarget?: boolean;
      confirmTarget?: string;
    },
  ): Promise<ReturnType<RunManager["summary"]>> {
    const busy = this.list()[0];
    if (busy) throw new BusyError(busy.id);
    const limits = {
      maxRps: this.cfg.maxRps,
      maxConnections: this.cfg.maxConnections,
      maxDurationMs: this.cfg.maxDurationMs,
      maxVus: this.cfg.maxVus,
    };
    const { load } = await authorizeRun(scenario, limits, this.cfg.allowedTargets, opts);
    if (this.list().length) throw new BusyError(this.list()[0]!.id); // corrida durante o await

    let id = makeRunId(scenario.name);
    for (
      let i = 2;
      this.store.getRun(id) || fs.existsSync(path.join(this.cfg.reportsDir, id));
      i++
    ) {
      id = `${makeRunId(scenario.name)}-${i}`;
    }
    const workers = resolveWorkers(scenario, opts.workers);
    const a: ActiveRun = {
      id,
      scenarioId: opts.scenarioId ?? null,
      scenario,
      load,
      workers,
      startedAt: new Date().toISOString(),
      controller: new AbortController(),
      history: [],
      logs: [],
      live: new LiveMetrics(scenario.name),
      done: Promise.resolve(),
    };
    this.active.set(id, a);
    this.store.insertRunning({
      id,
      scenarioId: a.scenarioId,
      scenario: scenario.name,
      model: scenario.load.model,
      baseUrl: scenario.target.baseUrl,
      startedAt: a.startedAt,
    });
    this.hub.emit({ type: "run-started", run: this.summary(a) });
    this.log(
      a,
      "info",
      `início: ${scenario.name} → ${scenario.target.baseUrl} (${workers} worker(s), ` +
        (load.model === "open" ? `pico ${load.peakRps} rps)` : `até ${load.peakVus} VUs)`),
    );
    a.done = this.execute(a);
    return this.summary(a);
  }

  private async execute(a: ActiveRun): Promise<void> {
    let lastStage = -1;
    let lastWarmup = true;
    let report: RunReport | undefined;
    try {
      report = await runScenario(a.scenario, {
        toolVersion: VERSION,
        runId: a.id,
        connections: a.load.connections,
        workers: a.workers,
        maxRps: this.cfg.maxRps,
        stopSignal: a.controller.signal,
        onProgress: (p) => {
          a.history.push(p);
          a.live.update(p);
          this.hub.emit({ type: "progress", runId: a.id, p });
          if (p.stage !== lastStage && p.stage >= 0) {
            lastStage = p.stage;
            const st =
              a.scenario.load.model === "open"
                ? a.scenario.load.stages[p.stage]
                : a.scenario.load.vuStages[p.stage];
            if (st) {
              const desc =
                "rpsFrom" in st
                  ? st.rpsFrom === st.rpsTo
                    ? `${st.rpsFrom} rps`
                    : `${st.rpsFrom} → ${st.rpsTo} rps`
                  : st.vusFrom === st.vusTo
                    ? `${st.vusFrom} VUs`
                    : `${st.vusFrom} → ${st.vusTo} VUs`;
              this.log(a, "info", `etapa ${p.stage + 1}: ${desc}`);
            }
          }
          if (lastWarmup && !p.warmup) {
            lastWarmup = false;
            if (a.scenario.load.warmupMs)
              this.log(a, "info", "aquecimento concluído; medição iniciada");
          }
          if (p.errors > 0) {
            this.log(
              a,
              p.errors / Math.max(1, p.rps) > 0.05 ? "error" : "warn",
              `${p.errors} erro(s) no segundo ${Math.round(p.elapsedMs / 1000)}`,
            );
          }
        },
      });
      const dir = path.join(this.cfg.reportsDir, a.id);
      writeRunReports(report, dir);
      this.store.saveReport(report, dir, "api", a.scenarioId);
      for (const w of [...report.run.invalidReasons, ...report.run.warnings]) {
        this.log(a, report.run.invalidReasons.includes(w) ? "error" : "warn", w);
      }
      if (report.run.stopReason) this.log(a, "warn", report.run.stopReason);
      const failed = report.thresholds.filter((t) => !t.passed).map((t) => t.expression);
      this.log(
        a,
        failed.length || report.run.invalid ? "warn" : "info",
        `fim: ${report.run.status === "interrupted" ? "interrompida" : "concluída"}; ` +
          `${report.summary.requests.total} requisições, p95 ${report.summary.latencyMs.p95} ms, erros ${(report.summary.errorRate * 100).toFixed(2)}%` +
          (failed.length ? `; thresholds violados: ${failed.join(", ")}` : ""),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.store.failRun(a.id, msg);
      this.log(a, "error", `falha: ${msg}`);
    } finally {
      a.live.finish();
      this.active.delete(a.id);
      this.hub.emit({ type: "run-finished", run: this.store.getRun(a.id) as RunRow });
    }
  }

  /** Kill switch: para de agendar, drena as requisições em andamento e salva o parcial. */
  stop(id: string): boolean {
    const a = this.active.get(id);
    if (!a) return false;
    if (!a.controller.signal.aborted) {
      this.log(a, "warn", "parada solicitada: drenando requisições em andamento");
      a.controller.abort();
    }
    return true;
  }

  /** Encerramento do servidor: interrompe tudo e espera os relatórios parciais serem gravados. */
  async stopAll(timeoutMs = 15_000): Promise<void> {
    const runs = this.list();
    for (const a of runs) this.stop(a.id);
    await Promise.race([
      Promise.all(runs.map((a) => a.done)),
      new Promise((r) => setTimeout(r, timeoutMs)),
    ]);
  }

  metrics(): string {
    const a = this.list()[0];
    return a ? a.live.render() : "";
  }
}

export function assertInside(root: string, p: string): string {
  const resolved = path.resolve(p);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel))
    throw new ConfigError("caminho fora da pasta de relatórios");
  return resolved;
}
