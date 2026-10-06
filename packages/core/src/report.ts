import fs from "node:fs";
import path from "node:path";
import type { ErrorType, LatencyStats } from "./metrics.js";
import type { ThresholdResult } from "./thresholds.js";

/** Versão do formato JSON do relatório. Mudanças incompatíveis incrementam este número. */
export const REPORT_SCHEMA_VERSION = 1;

export type RunStatus = "completed" | "interrupted" | "failed";

export interface CheckReport {
  name: string;
  passed: number;
  failed: number;
}

export interface StepReport {
  /** Nome do fluxo (vazio quando o cenário tem um único fluxo). */
  flow: string;
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
  checks: CheckReport[];
  /** Mensagens de falha mais frequentes (amostra, até 20 distintas). */
  failures: { message: string; count: number }[];
}

export interface TimelinePoint {
  t: number;
  warmup: boolean;
  /** Taxa de chegada pedida pelo cronograma (iterações/s); 0 no modelo fechado. */
  targetRps: number;
  /** Iterações disparadas neste segundo. */
  sentRps: number;
  /** Requisições concluídas neste segundo. */
  rps: number;
  errors: number;
  /** Iterações simultâneas (aberto) ou VUs ativos (fechado) — máximo no segundo. */
  concurrency: number;
  latencyMs: { p50: number; p95: number; p99: number; max: number };
  /** CPU total da máquina (%) e memória em uso (%), quando a coleta está ativa. */
  cpu?: number;
  memPct?: number;
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
    model: "open" | "closed";
    /** true quando o gerador não sustentou a carga: números não representam o alvo. */
    invalid: boolean;
    invalidReasons: string[];
    warnings: string[];
    /** Motivo de término antecipado (stopWhen). */
    stopReason?: string;
    /** Onde o alvo "quebrou" (stopWhen): segundo, carga pedida e vazão obtida. */
    breakingPoint?: {
      t: number;
      condition: string;
      measured: number;
      targetRps?: number;
      vus?: number;
      achievedRps: number;
    };
  };
  environment: { node: string; platform: string; arch: string; cpus: number };
  config: {
    target: {
      baseUrl: string;
      headers: Record<string, string>;
      timeoutMs: number;
      http2: boolean;
    };
    load: {
      model: "open" | "closed";
      stages: { durationMs: number; rpsFrom: number; rpsTo: number }[];
      vuStages: { durationMs: number; vusFrom: number; vusTo: number }[];
      pacingMs?: number;
      warmupMs: number;
      connections: number;
      maxInFlight?: number;
      workers: number;
      stopWhen: string[];
    };
    thresholds: string[];
    flows: { name: string; weight: number; steps: string[] }[];
    data: { file: string; name?: string; order: string; rows: number; columns: string[] }[];
    variables: string[];
  };
  summary: {
    /** Janela medida (sem aquecimento), em ms. */
    windowMs: number;
    requests: { total: number; ok: number; failed: number };
    iterations: { scheduled: number; started: number; completed: number; dropped: number };
    /** Fração 0..1 de requisições com falha (não inclui iterações descartadas). */
    errorRate: number;
    rps: {
      /** Taxa média de chegada pedida (iterações/s); null no modelo fechado. */
      requested: number | null;
      /** Iterações iniciadas por segundo. */
      sent: number;
      /** Requisições concluídas por segundo (todas as etapas). */
      achieved: number;
    };
    /** Máximo de iterações simultâneas (aberto) ou VUs ativos (fechado). */
    maxConcurrency: number;
    /** Latência a partir do instante PREVISTO de envio (corrige omissão coordenada). */
    latencyMs: LatencyStats;
    /** Tempo de serviço: do envio efetivo até o fim da resposta. */
    serviceTimeMs: LatencyStats;
    /** Do envio até os headers da resposta (inclui espera por conexão livre e conexão nova). */
    ttfbMs: LatencyStats;
    /** Dos headers até o fim do corpo. */
    downloadMs: LatencyStats;
    /** Medidos por conexão nova (com keep-alive, poucas requisições abrem conexão). */
    connections: {
      opened: number;
      byProtocol: Record<string, number>;
      dnsMs: LatencyStats;
      connectMs: LatencyStats;
      tlsMs: LatencyStats;
    };
    statusCodes: Record<string, number>;
    errorsByType: Partial<Record<ErrorType, number>>;
    bytes: { received: number; sent: number };
    checks: { passed: number; failed: number };
    /** Só com etapas WebSocket. connectMs = handshake; rttMs = do envio até a mensagem esperada. */
    ws?: {
      sessions: number;
      messagesSent: number;
      messagesReceived: number;
      connectMs: LatencyStats;
      rttMs: LatencyStats;
    };
    /**
     * Só com etapas gRPC de streaming. firstMessageMs = início da chamada → 1ª mensagem recebida;
     * rttMs = envio → mensagem esperada por um expect do roteiro.
     */
    grpcStreams?: {
      streams: number;
      messagesSent: number;
      messagesReceived: number;
      firstMessageMs: LatencyStats;
      rttMs: LatencyStats;
    };
  };
  steps: StepReport[];
  timeline: TimelinePoint[];
  thresholds: ThresholdResult[];
  generator: {
    workers: number;
    /** Atraso entre o instante previsto e o disparo real (saúde do gerador, modelo aberto). */
    scheduleLagMs: LatencyStats;
    /** Atraso do event loop dos workers (medido com setImmediate a cada 100 ms). */
    loopLagMs: LatencyStats;
    /** CPU usada pelos motores, em % de UM núcleo (somada entre workers). */
    cpuPercent: number;
    timerMarginMs: number;
    /** Esperas impostas pelo teto de RPS (modelo fechado). */
    throttled: number;
  };
  /** Máquina local durante o teste (null se a coleta foi desativada). */
  machine: { cpuAvg: number; cpuMax: number; memMaxPct: number; rssMaxMb: number } | null;
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
