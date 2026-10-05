import type { ErrorType } from "../metrics.js";

/**
 * Formatos trocados entre o motor (em cada worker) e o coordenador. Tudo é serializável por
 * structured clone; histogramas viajam como HdrHistogram base64 comprimido.
 */

/** Um segundo fechado de um worker (pela hora de conclusão das requisições). */
export interface BucketData {
  t: number;
  /** Chegadas pedidas (modelo aberto) neste segundo. */
  scheduled: number;
  /** Iterações iniciadas neste segundo. */
  sent: number;
  requests: number;
  errors: number;
  /** Máximo de iterações simultâneas (aberto) ou VUs ativos (fechado) neste segundo. */
  concurrency: number;
  latency: string;
}

export interface StepResult {
  requests: number;
  errors: number;
  bytesIn: number;
  bytesOut: number;
  statusCodes: Record<string, number>;
  errorsByType: Partial<Record<ErrorType, number>>;
  checks: [string, number, number][];
  failures: [string, number][];
  latency: string;
}

export interface EngineResult {
  steps: StepResult[];
  serviceTime: string;
  ttfb: string;
  download: string;
  scheduleLag: string;
  loopLag: string;
  connections: {
    opened: number;
    byProtocol: Record<string, number>;
    dns: string;
    connect: string;
    tls: string;
  };
  counters: {
    scheduled: number;
    started: number;
    completed: number;
    dropped: number;
    aborted: number;
    /** Esperas impostas pelo teto de RPS no modelo fechado. */
    throttled: number;
  };
  /** CPU da thread do motor (µs), quando disponível. */
  cpuMicros: number;
  stopAtRelMs: number | null;
  maxVus: number;
}

export interface WorkerInit {
  scenario: { text: string; file?: string; baseDir: string; seed: number };
  config: EngineConfig;
}

export interface EngineConfig {
  workerIndex: number;
  workerCount: number;
  connections: number;
  maxInFlight: number;
  /** Teto de RPS por worker (modelo fechado). */
  maxRps: number;
  drainTimeoutMs: number;
}

export type ToWorker = { type: "start"; startEpochMs: number } | { type: "stop" };

export type FromWorker =
  | { type: "ready" }
  | { type: "bucket"; bucket: BucketData }
  | { type: "done"; result: EngineResult; finalBuckets: BucketData[] }
  | { type: "error"; message: string; stack?: string };
