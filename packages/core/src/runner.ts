import os from "node:os";
import { performance } from "node:perf_hooks";
import { Pool } from "undici";
import {
  StepMetrics,
  classifyError,
  encodeHistogram,
  latencyStats,
  newHistogram,
  recordMs,
  type ErrorType,
  type TimelineBucket,
} from "./metrics.js";
import { PreciseScheduler, TIMER_MARGIN_MS } from "./precise-timer.js";
import {
  REPORT_SCHEMA_VERSION,
  makeRunId,
  type RunReport,
  type RunStatus,
  type TimelinePoint,
} from "./report.js";
import { ArrivalSchedule } from "./schedule.js";
import type { Scenario, Step } from "./scenario/types.js";
import { maskDeep, maskHeaders } from "./secrets.js";
import { evaluateThresholds, parseThreshold } from "./thresholds.js";

export interface ProgressSnapshot {
  elapsedMs: number;
  totalMs: number;
  stage: number;
  warmup: boolean;
  targetRps: number;
  sentRps: number;
  rps: number;
  errors: number;
  inFlight: number;
  totalRequests: number;
  totalErrors: number;
  latencyMs: { p50: number; p95: number; p99: number };
}

export interface RunOptions {
  toolVersion: string;
  runId?: string;
  /** Pool de conexões por origem. */
  connections: number;
  /** Parada graciosa: para de agendar e drena as requisições em andamento. */
  stopSignal?: AbortSignal;
  /** Tempo máximo de drenagem antes de abortar o que estiver em andamento. */
  drainTimeoutMs?: number;
  onProgress?: (p: ProgressSnapshot) => void;
}

/** Atraso de agendamento p99 acima disso invalida a execução. */
export const MAX_SCHEDULE_LAG_P99_MS = 10;

interface RequestOutcome {
  status: number;
  error?: ErrorType;
  bytesIn: number;
  bytesOut: number;
}

export async function runScenario(sc: Scenario, opts: RunOptions): Promise<RunReport> {
  const schedule = new ArrivalSchedule(sc.load.stages);
  const timer = new PreciseScheduler();
  const base = new URL(sc.target.baseUrl);
  const basePath = base.pathname.replace(/\/+$/, "");
  const connections = sc.load.connections ?? opts.connections;
  const maxInFlight = sc.load.maxInFlight ?? connections * 4;
  const pool = new Pool(base.origin, {
    connections,
    pipelining: 1,
    keepAliveTimeout: 10_000,
    connect: { timeout: sc.target.timeoutMs },
  });

  const hardAbort = new AbortController();
  const steps = sc.flow.map((s) => new StepMetrics(s.name, s.request.method, s.request.path));
  const total = new StepMetrics("total", "*", "*");
  const serviceTime = newHistogram();
  const scheduleLag = newHistogram();
  const timeline: TimelineBucket[] = [];
  const warmupMs = sc.load.warmupMs;

  let scheduledMain = 0;
  let started = 0;
  let completed = 0;
  let dropped = 0;
  let aborted = 0;
  let inFlight = 0;
  let stopping = false;
  let stopAtRel: number | null = null;

  const cpuStart = process.cpuUsage();
  const startPerf = performance.now() + 20;
  const startedAt = new Date(Date.now() + 20);
  const runId = opts.runId ?? makeRunId(sc.name, startedAt);

  const bucket = (relMs: number): TimelineBucket => {
    const t = Math.max(0, Math.floor(relMs / 1000));
    for (let i = timeline.length; i <= t; i++) {
      timeline[i] = {
        t: i,
        warmup: i * 1000 < warmupMs,
        requests: 0,
        errors: 0,
        scheduled: 0,
        sent: 0,
        latency: newHistogram(2),
      };
    }
    return timeline[t]!;
  };

  let resolveIdle!: () => void;
  const idle = new Promise<void>((r) => (resolveIdle = r));
  let schedulingDone = false;
  const checkIdle = () => {
    if ((schedulingDone || stopping) && inFlight === 0) resolveIdle();
  };

  const executeRequest = async (step: Step): Promise<RequestOutcome> => {
    const req = step.request;
    const qs = Object.keys(req.query).length
      ? (req.path.includes("?") ? "&" : "?") + new URLSearchParams(req.query).toString()
      : "";
    const fullPath = basePath + req.path + qs;
    const headers: Record<string, string> = { ...sc.target.headers, ...req.headers };
    if (req.contentType && !Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
      headers["content-type"] = req.contentType;
    }
    let bytesOut = `${req.method} ${fullPath} HTTP/1.1\r\nhost: ${base.host}\r\n`.length + 2;
    for (const [k, v] of Object.entries(headers)) bytesOut += k.length + v.length + 4;
    if (req.body) bytesOut += Buffer.byteLength(req.body);

    const ac = new AbortController();
    const onHard = () => ac.abort(new DOMException("execução interrompida", "AbortError"));
    hardAbort.signal.addEventListener("abort", onHard, { once: true });
    const to = setTimeout(
      () => ac.abort(new DOMException(`timeout de ${sc.target.timeoutMs}ms`, "TimeoutError")),
      sc.target.timeoutMs,
    );
    try {
      const res = await pool.request({
        method: req.method,
        path: fullPath,
        headers,
        body: req.body,
        signal: ac.signal,
        headersTimeout: sc.target.timeoutMs,
        bodyTimeout: sc.target.timeoutMs,
      });
      let bytesIn = 0;
      for await (const chunk of res.body) bytesIn += (chunk as Buffer).length;
      for (const [k, v] of Object.entries(res.headers)) {
        bytesIn += k.length + (Array.isArray(v) ? v.join(", ").length : String(v ?? "").length) + 4;
      }
      const status = res.statusCode;
      let error: ErrorType | undefined;
      const accepted = step.expect.status;
      if (accepted ? !accepted.includes(status) : status >= 400) {
        error = status >= 500 ? "http_5xx" : status >= 400 ? "http_4xx" : "check_failed";
      }
      return { status, error, bytesIn, bytesOut };
    } catch (err) {
      const reason = ac.signal.aborted ? (ac.signal.reason as Error) : err;
      return { status: 0, error: classifyError(reason), bytesIn: 0, bytesOut };
    } finally {
      clearTimeout(to);
      hardAbort.signal.removeEventListener("abort", onHard);
    }
  };

  const runIteration = async (intendedAbs: number, warmup: boolean): Promise<void> => {
    let intended = intendedAbs;
    for (let i = 0; i < sc.flow.length; i++) {
      if (i > 0 && (stopping || hardAbort.signal.aborted)) return;
      const step = sc.flow[i]!;
      const sentAt = performance.now();
      const out = await executeRequest(step);
      const end = performance.now();
      const latency = end - intended;
      if (!out.error && step.expect.maxDurationMs && latency > step.expect.maxDurationMs)
        out.error = "check_failed";
      if (out.error === "aborted") {
        aborted++;
        return;
      }

      const b = bucket(end - startPerf);
      b.requests++;
      if (out.error) b.errors++;
      recordMs(b.latency, latency);

      if (!warmup) {
        for (const m of [steps[i]!, total]) {
          m.requests++;
          m.bytesIn += out.bytesIn;
          m.bytesOut += out.bytesOut;
          recordMs(m.latency, latency);
          if (out.status) m.statusCodes[out.status] = (m.statusCodes[out.status] ?? 0) + 1;
          if (out.error) m.addError(out.error);
        }
        recordMs(serviceTime, end - sentAt);
      }
      if (out.error) return; // etapas seguintes dependem desta
      if (step.thinkMs) await timer.sleep(step.thinkMs);
      intended = performance.now();
    }
    if (!warmup) completed++;
  };

  const onArrival = (tRel: number) => {
    if (stopping) return;
    const lag = performance.now() - (startPerf + tRel);
    const warmup = tRel < warmupMs;
    const b = bucket(tRel);
    b.scheduled++;
    if (!warmup) {
      scheduledMain++;
      recordMs(scheduleLag, Math.max(0.001, lag));
    }
    if (inFlight >= maxInFlight) {
      if (!warmup) dropped++;
    } else {
      inFlight++;
      b.sent++;
      if (!warmup) started++;
      runIteration(startPerf + tRel, warmup).finally(() => {
        inFlight--;
        checkIdle();
      });
    }
    scheduleNext();
  };

  const scheduleNext = () => {
    const t = schedule.next();
    if (t === null) {
      schedulingDone = true;
      checkIdle();
      return;
    }
    timer.at(startPerf + t, () => onArrival(t));
  };

  const stop = () => {
    if (stopping) return;
    stopping = true;
    stopAtRel = performance.now() - startPerf;
    timer.clear();
    checkIdle();
    const drain = setTimeout(
      () => hardAbort.abort(),
      opts.drainTimeoutMs ?? Math.min(sc.target.timeoutMs, 5000),
    );
    drain.unref();
    idle.then(() => clearTimeout(drain));
  };
  if (opts.stopSignal?.aborted) stop();
  opts.stopSignal?.addEventListener("abort", stop, { once: true });

  let lastReported = -1;
  const progress = opts.onProgress
    ? setInterval(() => {
        const rel = performance.now() - startPerf;
        const sec = Math.floor(rel / 1000) - 1;
        if (sec < 0 || sec === lastReported) return;
        lastReported = sec;
        const b = timeline[sec];
        opts.onProgress!({
          elapsedMs: rel,
          totalMs: schedule.totalMs,
          stage: schedule.stageAt(rel),
          warmup: rel < warmupMs,
          targetRps: schedule.countBetween(sec * 1000, (sec + 1) * 1000),
          sentRps: b?.sent ?? 0,
          rps: b?.requests ?? 0,
          errors: b?.errors ?? 0,
          inFlight,
          totalRequests: total.requests,
          totalErrors: total.errors,
          latencyMs: {
            p50: b ? b.latency.getValueAtPercentile(50) / 1000 : 0,
            p95: b ? b.latency.getValueAtPercentile(95) / 1000 : 0,
            p99: b ? b.latency.getValueAtPercentile(99) / 1000 : 0,
          },
        });
      }, 250)
    : undefined;

  scheduleNext();
  await idle;
  if (progress) clearInterval(progress);
  opts.stopSignal?.removeEventListener("abort", stop);
  timer.clear();
  await (hardAbort.signal.aborted ? pool.destroy() : pool.close());

  const endedPerf = performance.now();
  const cpu = process.cpuUsage(cpuStart);
  const status: RunStatus = stopping ? "interrupted" : "completed";
  const windowEnd = stopAtRel !== null ? Math.min(stopAtRel, schedule.totalMs) : schedule.totalMs;
  const windowMs = Math.max(1, windowEnd - warmupMs);
  const windowSec = windowMs / 1000;

  const latency = latencyStats(total.latency);
  const lagStats = latencyStats(scheduleLag);
  const errorRate = total.requests ? total.errors / total.requests : 0;
  const rps = {
    requested: round(schedule.countBetween(warmupMs, windowEnd) / windowSec, 2),
    sent: round(started / windowSec, 2),
    achieved: round(total.requests / windowSec, 2),
  };

  const invalidReasons: string[] = [];
  const warnings: string[] = [];
  if (lagStats.count && lagStats.p99 > MAX_SCHEDULE_LAG_P99_MS) {
    invalidReasons.push(
      `resultado inválido: o gerador não conseguiu sustentar a taxa (atraso de agendamento p99 = ${lagStats.p99.toFixed(1)}ms > ${MAX_SCHEDULE_LAG_P99_MS}ms)`,
    );
  }
  if (dropped) {
    warnings.push(
      `${dropped} iteração(ões) descartada(s): ${maxInFlight} já estavam em andamento (load.maxInFlight). O alvo não acompanhou a taxa ou o limite está baixo.`,
    );
  }
  if (aborted)
    warnings.push(`${aborted} requisição(ões) abortada(s) na parada (excluídas das estatísticas).`);
  if (total.requests && total.requests < 100) {
    warnings.push(
      `apenas ${total.requests} requisições medidas: percentis altos (p99/p99.9) têm pouca confiabilidade.`,
    );
  }

  const thresholds = evaluateThresholds(sc.thresholds.map(parseThreshold), (metric) => {
    if (!total.requests) return null;
    if (metric === "errorRate") return errorRate;
    if (metric === "rps") return rps.achieved;
    if (metric === "mean") return latency.mean;
    if (metric === "max") return latency.max;
    if (metric === "min") return latency.min;
    if (metric.startsWith("p"))
      return total.latency.getValueAtPercentile(Number(metric.slice(1))) / 1000;
    return null;
  });

  const timelinePoints: TimelinePoint[] = timeline.map((b) => ({
    t: b.t,
    warmup: b.warmup,
    targetRps: round(schedule.countBetween(b.t * 1000, (b.t + 1) * 1000), 2),
    sentRps: b.sent,
    rps: b.requests,
    errors: b.errors,
    latencyMs: {
      p50: b.latency.getValueAtPercentile(50) / 1000,
      p95: b.latency.getValueAtPercentile(95) / 1000,
      p99: b.latency.getValueAtPercentile(99) / 1000,
      max: b.latency.maxValue / 1000,
    },
  }));

  const report: RunReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: { name: "lt", version: opts.toolVersion },
    run: {
      id: runId,
      scenario: sc.name,
      scenarioFile: sc.sourceFile,
      status,
      startedAt: startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: round(endedPerf - startPerf, 1),
      seed: sc.seed,
      model: "open",
      invalid: invalidReasons.length > 0,
      invalidReasons,
      warnings,
    },
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus().length,
    },
    config: {
      target: {
        baseUrl: sc.target.baseUrl,
        headers: maskHeaders(sc.target.headers, sc.secrets),
        timeoutMs: sc.target.timeoutMs,
      },
      load: { model: "open", stages: sc.load.stages, warmupMs, connections, maxInFlight },
      thresholds: sc.thresholds,
    },
    summary: {
      windowMs: round(windowMs, 1),
      requests: { total: total.requests, ok: total.requests - total.errors, failed: total.errors },
      iterations: { scheduled: scheduledMain, started, completed, dropped },
      errorRate: round(errorRate, 6),
      rps,
      latencyMs: latency,
      serviceTimeMs: latencyStats(serviceTime),
      statusCodes: total.statusCodes,
      errorsByType: total.errorsByType,
      bytes: { received: total.bytesIn, sent: total.bytesOut },
    },
    steps: steps.map((m) => ({
      name: m.name,
      method: m.method,
      path: m.path,
      requests: m.requests,
      errors: m.errors,
      errorRate: m.requests ? round(m.errors / m.requests, 6) : 0,
      latencyMs: latencyStats(m.latency),
      statusCodes: m.statusCodes,
      errorsByType: m.errorsByType,
      bytes: { received: m.bytesIn, sent: m.bytesOut },
    })),
    timeline: timelinePoints,
    thresholds,
    generator: {
      scheduleLagMs: lagStats,
      cpuPercent: round(((cpu.user + cpu.system) / 1000 / (endedPerf - startPerf)) * 100, 1),
      timerMarginMs: TIMER_MARGIN_MS,
    },
    histograms: { latencyUs: encodeHistogram(total.latency) },
  };
  return maskDeep(report, sc.secrets);
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
