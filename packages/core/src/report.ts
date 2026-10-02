import fs from "node:fs";
import path from "node:path";
import type { ErrorType, LatencyStats } from "./metrics.js";
import type { ThresholdResult } from "./thresholds.js";

/** Versão do formato JSON do relatório. Mudanças incompatíveis incrementam este número. */
export const REPORT_SCHEMA_VERSION = 1;

export type RunStatus = "completed" | "interrupted" | "failed";

export interface StepReport {
  name: string;
  method: string;
  path: string;
  requests: number;
  errors: number;
  errorRate: number;
  latencyMs: LatencyStats;
  statusCodes: Record<string, number>;
  errorsByType: Partial<Record<ErrorType, number>>;
  bytes: { received: number; sent: number };
}

export interface TimelinePoint {
  t: number;
  warmup: boolean;
  /** Taxa de chegada pedida pelo cronograma (iterações/s). */
  targetRps: number;
  /** Iterações disparadas neste segundo. */
  sentRps: number;
  /** Requisições concluídas neste segundo. */
  rps: number;
  errors: number;
  latencyMs: { p50: number; p95: number; p99: number; max: number };
}

export interface RunReport {
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  tool: { name: "lt"; version: string };
  run: {
    id: string;
    scenario: string;
    scenarioFile?: string;
    status: RunStatus;
    startedAt: string;
    endedAt: string;
    durationMs: number;
    seed: number;
    model: "open";
    /** true quando o gerador não sustentou a taxa: números não representam o alvo. */
    invalid: boolean;
    invalidReasons: string[];
    warnings: string[];
  };
  environment: { node: string; platform: string; arch: string; cpus: number };
  config: {
    target: { baseUrl: string; headers: Record<string, string>; timeoutMs: number };
    load: {
      model: "open";
      stages: { durationMs: number; rpsFrom: number; rpsTo: number }[];
      warmupMs: number;
      connections: number;
      maxInFlight: number;
    };
    thresholds: string[];
  };
  summary: {
    /** Janela medida (sem aquecimento), em ms. */
    windowMs: number;
    requests: { total: number; ok: number; failed: number };
    iterations: { scheduled: number; started: number; completed: number; dropped: number };
    /** Fração 0..1 de requisições com falha (não inclui iterações descartadas). */
    errorRate: number;
    rps: {
      /** Taxa média de chegada pedida (iterações/s). */
      requested: number;
      /** Iterações iniciadas por segundo. */
      sent: number;
      /** Requisições concluídas por segundo (todas as etapas). */
      achieved: number;
    };
    /** Latência a partir do instante PREVISTO de envio (corrige omissão coordenada). */
    latencyMs: LatencyStats;
    /** Tempo de serviço: do envio efetivo até o fim da resposta. */
    serviceTimeMs: LatencyStats;
    statusCodes: Record<string, number>;
    errorsByType: Partial<Record<ErrorType, number>>;
    bytes: { received: number; sent: number };
  };
  steps: StepReport[];
  timeline: TimelinePoint[];
  thresholds: ThresholdResult[];
  generator: {
    /** Atraso entre o instante previsto e o disparo real (saúde do gerador). */
    scheduleLagMs: LatencyStats;
    cpuPercent: number;
    timerMarginMs: number;
  };
  /** Histograma de latência (µs) codificado em HdrHistogram base64 comprimido, para comparações. */
  histograms: { latencyUs: string };
}

export function slugify(s: string): string {
  return (
    s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "run"
  );
}

export function makeRunId(scenarioName: string, date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const ts = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  return `${ts}-${slugify(scenarioName)}`;
}

/** Grava o relatório em <reportsDir>/<runId>/report.json e devolve o caminho. */
export function writeJsonReport(report: RunReport, reportsDir: string): string {
  const dir = path.join(reportsDir, report.run.id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "report.json");
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  return file;
}
