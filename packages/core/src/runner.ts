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
import {
  MAX_BODY_BYTES,
  buildRequest,
  createIteration,
  evaluateResponse,
  templateErrorMessage,
  thinkTimeMs,
  type BuiltRequest,
  type Evaluation,
  type Iteration,
  type ResponseData,
} from "./scenario/execute.js";
import type { Scenario } from "./scenario/types.js";
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

interface SendOutcome {
  res?: ResponseData;
  error?: ErrorType;
  message?: string;
  bytesIn: number;
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
  const multiFlow = sc.flows.length > 1;
  const flowMetrics = sc.flows.map((f) =>
    f.steps.map(
      (s) =>
        new StepMetrics(
          s.name,
          s.request.method,
          s.label.slice(s.request.method.length + 1),
          multiFlow ? f.name : "",
        ),
    ),
  );
  const steps = flowMetrics.flat();
  const total = new StepMetrics("total", "*", "*");
  const serviceTime = newHistogram();
  const scheduleLag = newHistogram();
  const timeline: TimelineBucket[] = [];
  const warmupMs = sc.load.warmupMs;

  let iterationSeq = 0;
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

  const send = async (req: BuiltRequest, needsBody: boolean): Promise<SendOutcome> => {
    const ac = new AbortController();
    const onHard = () => ac.abort(new DOMException("execução interrompida", "AbortError"));
    hardAbort.signal.addEventListener("abort", onHard, { once: true });
    const to = setTimeout(
      () => ac.abort(new DOMException(`timeout de ${sc.target.timeoutMs}ms`, "TimeoutError")),
      sc.target.timeoutMs,
    );
    try {
      const res = await pool.request({
        method: req.method as "GET",
        path: req.path,
        headers: req.headers,
        body: req.body,
        signal: ac.signal,
        headersTimeout: sc.target.timeoutMs,
        bodyTimeout: sc.target.timeoutMs,
      });
      let bytesIn = 0;
      let kept = 0;
      let truncated = false;
      const chunks: Buffer[] = [];
      for await (const chunk of res.body) {
        const c = chunk as Buffer;
        bytesIn += c.length;
        if (!needsBody) continue;
        if (kept + c.length <= MAX_BODY_BYTES) {
          chunks.push(c);
          kept += c.length;
        } else truncated = true;
      }
      for (const [k, v] of Object.entries(res.headers)) {
        bytesIn += k.length + (Array.isArray(v) ? v.join(", ").length : String(v ?? "").length) + 4;
      }
      return {
        res: {
          status: res.statusCode,
          headers: res.headers,
          body: needsBody ? Buffer.concat(chunks) : undefined,
          truncated,
        },
        bytesIn,
      };
    } catch (err) {
      const reason = ac.signal.aborted ? (ac.signal.reason as Error) : (err as Error);
      return {
        error: classifyError(reason),
        message: reason?.message ?? String(reason),
        bytesIn: 0,
      };
    } finally {
      clearTimeout(to);
      hardAbort.signal.removeEventListener("abort", onHard);
    }
  };

  /** Falha antes de enviar (ex.: template inválido em tempo de execução): conta como requisição com erro. */
  const recordUnsent = (m: StepMetrics, warmup: boolean, message: string) => {
    const b = bucket(performance.now() - startPerf);
    b.requests++;
    b.errors++;
    if (warmup) return;
    for (const x of [m, total]) {
      x.requests++;
      x.addError("template_error", message);
    }
  };

  const runIteration = async (
    intendedAbs: number,
    warmup: boolean,
    index: number,
  ): Promise<void> => {
    let it: Iteration;
    try {
      it = createIteration(sc, index);
    } catch (e) {
      recordUnsent(flowMetrics[0]![0]!, warmup, `variables: ${templateErrorMessage(e)}`);
      return;
    }
    const metrics = flowMetrics[it.flowIndex]!;
    let intended = intendedAbs;
    for (let i = 0; i < it.flow.steps.length; i++) {
      if (i > 0 && (stopping || hardAbort.signal.aborted)) return;
      const step = it.flow.steps[i]!;
      let req: BuiltRequest;
      try {
        req = buildRequest(sc, step, it.ctx, basePath, base.host);
      } catch (e) {
        recordUnsent(metrics[i]!, warmup, templateErrorMessage(e));
        return;
      }
      const sentAt = performance.now();
      const out = await send(req, step.needsBody);
      const end = performance.now();
      const latency = end - intended;
      if (out.error === "aborted") {
        aborted++;
        return;
      }
      const ev: Evaluation = out.res
        ? evaluateResponse(step, out.res, latency, it.ctx)
        : { checks: [], error: out.error, message: out.message };

      const b = bucket(end - startPerf);
      b.requests++;
      if (ev.error) b.errors++;
      recordMs(b.latency, latency);

      if (!warmup) {
        const status = out.res?.status;
        for (const m of [metrics[i]!, total]) {
          m.requests++;
          m.bytesIn += out.bytesIn;
          m.bytesOut += req.bytesOut;
          recordMs(m.latency, latency);
          if (status) m.statusCodes[status] = (m.statusCodes[status] ?? 0) + 1;
          if (ev.error) m.addError(ev.error, ev.message);
        }
        for (const c of ev.checks) metrics[i]!.addCheck(c.label, c.ok);
        recordMs(serviceTime, end - sentAt);
      }
      if (ev.error) return; // etapas seguintes dependem desta
      const think = thinkTimeMs(step, it.ctx);
      if (think > 0) await timer.sleep(think);
      intended = performance.now();
    }
    if (!warmup) completed++;
  };

  const onArrival = (tRel: number) => {
    if (stopping) return;
    // índice atribuído na chegada: dados/semente da iteração não dependem da ordem das respostas
    const iteration = iterationSeq++;
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
      runIteration(startPerf + tRel, warmup, iteration).finally(() => {
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
        headers: maskHeaders(
          Object.fromEntries(sc.target.headers.map(([k, t]) => [k, t.source])),
          sc.secrets,
        ),
        timeoutMs: sc.target.timeoutMs,
      },
      load: { model: "open", stages: sc.load.stages, warmupMs, connections, maxInFlight },
      thresholds: sc.thresholds,
      flows: sc.flows.map((f) => ({
        name: f.name,
        weight: f.weight,
        steps: f.steps.map((x) => x.label),
      })),
      data: sc.data.map((d) => ({
        file: d.file,
        name: d.name,
        order: d.order,
        rows: d.rows.length,
        columns: d.columns,
      })),
      variables: sc.variables.map(([k]) => k),
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
      checks: steps.reduce(
        (acc, m) => {
          for (const c of m.checks.values()) {
            acc.passed += c.passed;
            acc.failed += c.failed;
          }
          return acc;
        },
        { passed: 0, failed: 0 },
      ),
    },
    steps: steps.map((m) => ({
      flow: m.flow,
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
      checks: [...m.checks].map(([name, c]) => ({ name, ...c })),
      failures: [...m.failures]
        .sort((a, b) => b[1] - a[1])
        .map(([message, count]) => ({ message, count })),
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
