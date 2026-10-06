import hdr from "hdr-histogram-js";

export type Histogram = hdr.Histogram;

/** Valores registrados em microssegundos; 3 dígitos significativos (erro ≤ 0,1%). */
export function newHistogram(digits: 1 | 2 | 3 = 3): Histogram {
  return hdr.build({
    lowestDiscernibleValue: 1,
    highestTrackableValue: 60 * 60 * 1_000_000,
    numberOfSignificantValueDigits: digits,
    autoResize: true,
    useWebAssembly: false,
  });
}

export function recordMs(h: Histogram, ms: number): void {
  h.recordValue(Math.max(1, Math.round(ms * 1000)));
}

export interface LatencyStats {
  count: number;
  min: number;
  mean: number;
  stdev: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  p99: number;
  p999: number;
  max: number;
}

const r3 = (us: number) => Math.round(us) / 1000;

/** Estatísticas em ms a partir de um histograma em µs. */
export function latencyStats(h: Histogram): LatencyStats {
  if (h.totalCount === 0) {
    return {
      count: 0,
      min: 0,
      mean: 0,
      stdev: 0,
      p50: 0,
      p75: 0,
      p90: 0,
      p95: 0,
      p99: 0,
      p999: 0,
      max: 0,
    };
  }
  return {
    count: h.totalCount,
    min: r3(h.minNonZeroValue),
    mean: r3(h.mean),
    stdev: r3(h.stdDeviation),
    p50: r3(h.getValueAtPercentile(50)),
    p75: r3(h.getValueAtPercentile(75)),
    p90: r3(h.getValueAtPercentile(90)),
    p95: r3(h.getValueAtPercentile(95)),
    p99: r3(h.getValueAtPercentile(99)),
    p999: r3(h.getValueAtPercentile(99.9)),
    max: r3(h.maxValue),
  };
}

export function encodeHistogram(h: Histogram): string {
  return hdr.encodeIntoCompressedBase64(h);
}

export function decodeHistogram(b64: string): Histogram {
  return hdr.decodeFromCompressedBase64(b64, 32, false);
}

export type ErrorType =
  | "timeout"
  | "connection_refused"
  | "connection_reset"
  | "dns"
  | "http_4xx"
  | "http_5xx"
  | "check_failed"
  | "template_error"
  | "ws_error"
  | "grpc_status"
  | "dropped"
  | "aborted"
  | "other";

/** Classifica falhas de transporte do undici/Node. */
export function classifyError(err: unknown): ErrorType {
  const e = err as { code?: string; name?: string; cause?: { code?: string } };
  const code = e?.code ?? e?.cause?.code ?? "";
  if (
    e?.name === "TimeoutError" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "ETIMEDOUT"
  ) {
    return "timeout";
  }
  if (code === "ECONNREFUSED") return "connection_refused";
  if (
    code === "ECONNRESET" ||
    code === "UND_ERR_SOCKET" ||
    code === "EPIPE" ||
    code === "UND_ERR_CLOSED"
  )
    return "connection_reset";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns";
  if (e?.name === "AbortError" || code === "UND_ERR_ABORTED") return "aborted";
  return "other";
}

const MAX_FAILURE_MESSAGES = 20;

export class StepMetrics {
  readonly latency = newHistogram();
  requests = 0;
  errors = 0;
  bytesIn = 0;
  bytesOut = 0;
  readonly statusCodes: Record<string, number> = {};
  readonly errorsByType: Partial<Record<ErrorType, number>> = {};
  /** Contagem por checagem (rótulo legível → aprovadas/reprovadas). */
  readonly checks = new Map<string, { passed: number; failed: number }>();
  /** Amostra das mensagens de falha mais comuns (limitada para não crescer sem fim). */
  readonly failures = new Map<string, number>();

  constructor(
    readonly name: string,
    readonly method: string,
    readonly path: string,
    readonly flow = "",
  ) {}

  addError(type: ErrorType, message?: string): void {
    this.errors++;
    this.errorsByType[type] = (this.errorsByType[type] ?? 0) + 1;
    if (message) {
      const n = this.failures.get(message);
      if (n !== undefined) this.failures.set(message, n + 1);
      else if (this.failures.size < MAX_FAILURE_MESSAGES) this.failures.set(message, 1);
    }
  }

  addCheck(label: string, ok: boolean): void {
    let c = this.checks.get(label);
    if (!c) this.checks.set(label, (c = { passed: 0, failed: 0 }));
    if (ok) c.passed++;
    else c.failed++;
  }
}

export interface TimelineBucket {
  /** Segundo desde o início do teste (pela conclusão da requisição). */
  t: number;
  warmup: boolean;
  requests: number;
  errors: number;
  /** Chegadas pedidas pelo cronograma neste segundo. */
  scheduled: number;
  /** Iterações efetivamente disparadas neste segundo. */
  sent: number;
  latency: Histogram;
}
