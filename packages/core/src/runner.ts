import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import { Engine, vusAt } from "./engine/engine.js";
import type {
  BucketData,
  EngineConfig,
  EngineResult,
  FromWorker,
  ToWorker,
  WorkerInit,
} from "./engine/protocol.js";
import { SystemSampler, type SystemSample } from "./engine/system.js";
import {
  decodeHistogram,
  encodeHistogram,
  latencyStats,
  newHistogram,
  type ErrorType,
  type Histogram,
} from "./metrics.js";
import { TIMER_MARGIN_MS } from "./precise-timer.js";
import {
  REPORT_SCHEMA_VERSION,
  makeRunId,
  type RunReport,
  type RunStatus,
  type StepReport,
  type TimelinePoint,
} from "./report.js";
import { ArrivalSchedule } from "./schedule.js";
import type { Scenario } from "./scenario/types.js";
import { maskDeep, maskHeaders } from "./secrets.js";
import { compare, evaluateThresholds, parseThreshold, type Threshold } from "./thresholds.js";

export interface ProgressSnapshot {
  elapsedMs: number;
  totalMs: number;
  stage: number;
  warmup: boolean;
  model: "open" | "closed";
  /** Taxa pedida (aberto) neste segundo. */
  targetRps: number;
  /** VUs pedidos (fechado) neste segundo. */
  targetVus: number;
  sentRps: number;
  rps: number;
  errors: number;
  concurrency: number;
  totalRequests: number;
  totalErrors: number;
  latencyMs: { p50: number; p95: number; p99: number };
  cpu?: number;
}

export interface RunOptions {
  toolVersion: string;
  runId?: string;
  /** Pool de conexões total (dividido entre os workers). */
  connections: number;
  /** Parada graciosa: para de agendar e drena as requisições em andamento. */
  stopSignal?: AbortSignal;
  /** Tempo máximo de drenagem antes de abortar o que estiver em andamento. */
  drainTimeoutMs?: number;
  onProgress?: (p: ProgressSnapshot) => void;
  /** Sobrescreve load.workers. */
  workers?: number | "auto";
  /** Teto de segurança de RPS (aplicado ativamente no modelo fechado). */
  maxRps?: number;
  /** Coleta CPU/memória da máquina por segundo (padrão: true). */
  systemMetrics?: boolean;
}

/** Atraso de agendamento p99 acima disso invalida a execução (modelo aberto). */
export const MAX_SCHEDULE_LAG_P99_MS = 10;
/** Atraso do event loop p99 acima disso invalida a execução (qualquer modelo). */
export const MAX_LOOP_LAG_P99_MS = 20;
/** Capacidade confortável de um worker (calibrada contra o demo-target; ver README). */
export const RPS_PER_WORKER = 1500;
export const VUS_PER_WORKER = 250;
const STOP_WINDOW_S = 3;

export function totalDurationMs(sc: Scenario): number {
  return sc.load.stages.reduce((s, st) => s + st.durationMs, 0);
}

export function maxVus(sc: Scenario): number {
  return Math.max(0, ...sc.load.vuStages.map((s) => Math.max(s.vusFrom, s.vusTo)));
}

/** Quantos workers usar: explícito, ou "auto" pela carga pedida (até núcleos − 1). */
export function resolveWorkers(sc: Scenario, override?: number | "auto"): number {
  const want = override ?? sc.load.workers;
  if (typeof want === "number") return Math.max(1, Math.floor(want));
  const cores =
    typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  const need =
    sc.load.model === "open"
      ? Math.ceil(new ArrivalSchedule(sc.load.stages).peakRps / RPS_PER_WORKER)
      : Math.ceil(maxVus(sc) / VUS_PER_WORKER);
  return Math.min(Math.max(1, need), Math.max(1, cores - 1));
}

// ------------------------------------------------------------------ handles de motor

type EngineOutcome = { result: EngineResult; finalBuckets: BucketData[] };

interface EngineHandle {
  start(startEpochMs: number): void;
  stop(): void;
  done: Promise<EngineOutcome>;
  dispose(): Promise<void>;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {}); // tratado por quem aguarda
  return { promise, resolve, reject };
}

function inProcess(
  sc: Scenario,
  cfg: EngineConfig,
  onBucket: (b: BucketData) => void,
): EngineHandle {
  const engine = new Engine(sc, cfg, onBucket);
  const d = deferred<EngineOutcome>();
  return {
    start: (epoch) => void engine.run(epoch).then(d.resolve, d.reject),
    stop: () => engine.stop(),
    done: d.promise,
    dispose: async () => {},
  };
}

const WORKER_FILE = fileURLToPath(new URL("../dist/engine/worker.js", import.meta.url));

function inWorker(
  sc: Scenario,
  cfg: EngineConfig,
  onBucket: (b: BucketData) => void,
): Promise<EngineHandle> {
  if (!fs.existsSync(WORKER_FILE)) {
    throw new Error(`worker não compilado (${WORKER_FILE}); rode npm run build`);
  }
  const init: WorkerInit = {
    scenario: {
      text: sc.source.text,
      file: sc.source.file,
      baseDir: sc.source.baseDir,
      seed: sc.seed,
      baseUrl: sc.target.baseUrl,
    },
    config: cfg,
  };
  const worker = new Worker(WORKER_FILE, { workerData: init });
  const send = (m: ToWorker) => worker.postMessage(m);
  const done = deferred<EngineOutcome>();
  const ready = deferred<EngineHandle>();
  let isReady = false;
  const fail = (err: Error) => (isReady ? done.reject(err) : ready.reject(err));
  worker.on("message", (m: FromWorker) => {
    if (m.type === "ready") {
      isReady = true;
      ready.resolve({
        start: (epoch) => send({ type: "start", startEpochMs: epoch }),
        stop: () => send({ type: "stop" }),
        done: done.promise,
        dispose: async () => {
          await worker.terminate();
        },
      });
    } else if (m.type === "bucket") onBucket(m.bucket);
    else if (m.type === "done") done.resolve({ result: m.result, finalBuckets: m.finalBuckets });
    else fail(new Error(`worker ${cfg.workerIndex}: ${m.message}`));
  });
  worker.on("error", fail);
  // sem efeito se o resultado já chegou (o terminate() do dispose também dispara "exit")
  worker.on("exit", (code) =>
    fail(new Error(`worker ${cfg.workerIndex} terminou (código ${code})`)),
  );
  return ready.promise;
}

// ------------------------------------------------------------------ coordenação

interface MergedSecond {
  scheduled: number;
  sent: number;
  requests: number;
  errors: number;
  concurrency: number[];
  latency: Histogram;
}

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

export async function runScenario(sc: Scenario, opts: RunOptions): Promise<RunReport> {
  const workers = resolveWorkers(sc, opts.workers);
  const model = sc.load.model;
  const totalMs = totalDurationMs(sc);
  const schedule = new ArrivalSchedule(sc.load.stages);
  const connections = sc.load.connections ?? opts.connections;
  const maxInFlight = sc.load.maxInFlight ?? connections * 4;
  const warmupMs = sc.load.warmupMs;
  const drainTimeoutMs = opts.drainTimeoutMs ?? Math.min(sc.target.timeoutMs, 5000);

  const merged = new Map<number, MergedSecond>();
  const watermark = new Array<number>(workers).fill(0);
  let finalizedUpTo = 0;
  let totalRequests = 0;
  let totalErrors = 0;
  const samples = new Map<number, SystemSample>();
  let startPerf = 0;
  let stopping = false;
  let stopAtRel: number | null = null;
  let userStopped = false;
  let stopReason: string | undefined;
  let breakingPoint: RunReport["run"]["breakingPoint"];
  const stopConds: Threshold[] = sc.load.stopWhen.map(parseThreshold);
  const handles: EngineHandle[] = [];

  const stopAll = () => {
    if (stopping) return;
    stopping = true;
    stopAtRel = performance.now() - startPerf;
    for (const h of handles) h.stop();
  };

  const second = (t: number): MergedSecond => {
    let m = merged.get(t);
    if (!m) {
      m = {
        scheduled: 0,
        sent: 0,
        requests: 0,
        errors: 0,
        concurrency: new Array<number>(workers).fill(0),
        latency: newHistogram(2),
      };
      merged.set(t, m);
    }
    return m;
  };

  const absorb = (w: number, b: BucketData) => {
    const m = second(b.t);
    m.scheduled += b.scheduled;
    m.sent += b.sent;
    m.requests += b.requests;
    m.errors += b.errors;
    m.concurrency[w] = Math.max(m.concurrency[w]!, b.concurrency);
    if (b.latency) m.latency.add(decodeHistogram(b.latency));
    totalRequests += b.requests;
    totalErrors += b.errors;
  };

  /** Avalia stopWhen numa janela dos últimos 3 segundos (após o aquecimento). */
  const checkStopWhen = (t: number) => {
    const first = t - STOP_WINDOW_S + 1;
    if (first < 0 || first * 1000 < warmupMs) return;
    const h = newHistogram(2);
    let req = 0;
    let err = 0;
    for (let s = first; s <= t; s++) {
      const m = merged.get(s);
      if (!m) continue;
      req += m.requests;
      err += m.errors;
      h.add(m.latency);
    }
    if (req < 10) return;
    for (const c of stopConds) {
      const v =
        c.metric === "errorRate"
          ? err / req
          : c.metric === "rps"
            ? req / STOP_WINDOW_S
            : c.metric === "mean"
              ? h.mean / 1000
              : c.metric === "max"
                ? h.maxValue / 1000
                : c.metric === "min"
                  ? h.minNonZeroValue / 1000
                  : h.getValueAtPercentile(Number(c.metric.slice(1))) / 1000;
      if (!compare(v, c.op, c.value)) continue;
      const shown = c.metric === "errorRate" ? `${(v * 100).toFixed(2)}%` : v.toFixed(2);
      stopReason = `stopWhen "${c.expression}" atingida (medido ${shown}) entre os segundos ${first} e ${t}`;
      breakingPoint = {
        t: first,
        condition: c.expression,
        measured: round(v, 4),
        ...(model === "open"
          ? {
              targetRps: round(
                schedule.countBetween(first * 1000, (t + 1) * 1000) / STOP_WINDOW_S,
                2,
              ),
            }
          : { vus: Math.ceil(vusAt(sc.load.vuStages, first * 1000)) }),
        achievedRps: round(req / STOP_WINDOW_S, 2),
      };
      stopAll();
      return;
    }
  };

  const finalizeSecond = (t: number) => {
    const m = merged.get(t);
    const rel = (t + 1) * 1000;
    opts.onProgress?.({
      elapsedMs: rel,
      totalMs,
      stage: schedule.stageAt(t * 1000),
      warmup: t * 1000 < warmupMs,
      model,
      targetRps: model === "open" ? schedule.countBetween(t * 1000, rel) : 0,
      targetVus: model === "closed" ? Math.ceil(vusAt(sc.load.vuStages, t * 1000)) : 0,
      sentRps: m?.sent ?? 0,
      rps: m?.requests ?? 0,
      errors: m?.errors ?? 0,
      concurrency: m ? sum(m.concurrency) : 0,
      totalRequests,
      totalErrors,
      latencyMs: {
        p50: m ? m.latency.getValueAtPercentile(50) / 1000 : 0,
        p95: m ? m.latency.getValueAtPercentile(95) / 1000 : 0,
        p99: m ? m.latency.getValueAtPercentile(99) / 1000 : 0,
      },
      cpu: samples.get(t)?.cpu,
    });
    if (stopConds.length && !stopping) checkStopWhen(t);
  };

  const onBucket = (w: number) => (b: BucketData) => {
    absorb(w, b);
    watermark[w] = Math.max(watermark[w]!, b.t + 1);
    const ready = Math.min(...watermark);
    while (finalizedUpTo < ready) finalizeSecond(finalizedUpTo++);
  };

  // sobe os motores (worker_threads só quando há mais de um)
  const cfgFor = (i: number): EngineConfig => ({
    workerIndex: i,
    workerCount: workers,
    connections: Math.max(1, Math.ceil(connections / workers)),
    maxInFlight: Math.max(1, Math.ceil(maxInFlight / workers)),
    maxRps: model === "closed" && opts.maxRps ? opts.maxRps / workers : 0,
    drainTimeoutMs,
  });
  if (workers === 1) handles.push(inProcess(sc, cfgFor(0), onBucket(0)));
  else {
    const started = await Promise.allSettled(
      Array.from({ length: workers }, (_, i) => inWorker(sc, cfgFor(i), onBucket(i))),
    );
    for (const s of started) if (s.status === "fulfilled") handles.push(s.value);
    const failed = started.find((s) => s.status === "rejected");
    if (failed) {
      await Promise.all(handles.map((h) => h.dispose()));
      throw (failed as PromiseRejectedResult).reason;
    }
  }

  const onUserStop = () => {
    userStopped = true;
    stopAll();
  };

  const startEpoch = performance.timeOrigin + performance.now() + 100;
  startPerf = startEpoch - performance.timeOrigin;
  const startedAt = new Date(Date.now() + 100);
  const runId = opts.runId ?? makeRunId(sc.name, startedAt);
  const sampler = opts.systemMetrics === false ? null : new SystemSampler();
  const sampleTimer = sampler
    ? setInterval(() => {
        const rel = performance.now() - startPerf;
        if (rel > 0) samples.set(Math.max(0, Math.round(rel / 1000) - 1), sampler.sample());
      }, 1000)
    : undefined;

  if (opts.stopSignal?.aborted) onUserStop();
  opts.stopSignal?.addEventListener("abort", onUserStop, { once: true });
  for (const h of handles) h.start(startEpoch);

  let outcomes: EngineOutcome[];
  try {
    outcomes = await Promise.all(handles.map((h) => h.done));
  } catch (e) {
    stopAll();
    throw e;
  } finally {
    opts.stopSignal?.removeEventListener("abort", onUserStop);
    if (sampleTimer) clearInterval(sampleTimer);
    await Promise.all(handles.map((h) => h.dispose()));
  }
  const endedPerf = performance.now();

  outcomes.forEach((o, w) => o.finalBuckets.forEach((b) => absorb(w, b)));
  const results = outcomes.map((o) => o.result);

  // ---------------------------------------------------------------- agregação final
  const add = (b64s: string[]): Histogram => {
    const h = newHistogram();
    for (const s of b64s) if (s) h.add(decodeHistogram(s));
    return h;
  };
  const multiFlow = sc.flows.length > 1;
  const flat = sc.flows.flatMap((f) =>
    f.steps.map((s) => ({ flow: multiFlow ? f.name : "", step: s })),
  );
  const stepReports: StepReport[] = [];
  const total = newHistogram();
  const statusCodes: Record<string, number> = {};
  const errorsByType: Partial<Record<ErrorType, number>> = {};
  let requests = 0;
  let errors = 0;
  let bytesIn = 0;
  let bytesOut = 0;
  let checksPassed = 0;
  let checksFailed = 0;
  const addInto = <K extends string>(
    dst: Partial<Record<K, number>>,
    src: Partial<Record<K, number>>,
  ) => {
    for (const [k, v] of Object.entries(src) as [K, number][]) dst[k] = (dst[k] ?? 0) + v;
  };
  flat.forEach(({ flow, step }, i) => {
    const parts = results.map((r) => r.steps[i]!);
    const h = add(parts.map((p) => p.latency));
    total.add(h);
    const codes: Record<string, number> = {};
    const ebt: Partial<Record<ErrorType, number>> = {};
    const checks = new Map<string, { passed: number; failed: number }>();
    const failures = new Map<string, number>();
    let rq = 0;
    let er = 0;
    let bi = 0;
    let bo = 0;
    for (const p of parts) {
      rq += p.requests;
      er += p.errors;
      bi += p.bytesIn;
      bo += p.bytesOut;
      addInto(codes, p.statusCodes);
      addInto(ebt, p.errorsByType);
      for (const [k, ok, bad] of p.checks) {
        const c = checks.get(k) ?? { passed: 0, failed: 0 };
        c.passed += ok;
        c.failed += bad;
        checks.set(k, c);
      }
      for (const [k, n] of p.failures) failures.set(k, (failures.get(k) ?? 0) + n);
    }
    requests += rq;
    errors += er;
    bytesIn += bi;
    bytesOut += bo;
    addInto(statusCodes, codes);
    addInto(errorsByType, ebt);
    for (const c of checks.values()) {
      checksPassed += c.passed;
      checksFailed += c.failed;
    }
    stepReports.push({
      flow,
      name: step.name,
      method: step.request.method,
      path: step.label.slice(step.request.method.length + 1),
      requests: rq,
      errors: er,
      errorRate: rq ? round(er / rq, 6) : 0,
      latencyMs: latencyStats(h),
      statusCodes: codes,
      errorsByType: ebt,
      bytes: { received: bi, sent: bo },
      checks: [...checks].map(([name, c]) => ({ name, ...c })),
      failures: [...failures]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([message, count]) => ({ message, count })),
    });
  });

  const counters = { scheduled: 0, started: 0, completed: 0, dropped: 0, aborted: 0, throttled: 0 };
  for (const r of results) {
    for (const k of Object.keys(counters) as (keyof typeof counters)[])
      counters[k] += r.counters[k];
  }
  const byProtocol: Record<string, number> = {};
  for (const r of results) addInto(byProtocol, r.connections.byProtocol);

  const status: RunStatus = userStopped ? "interrupted" : "completed";
  const windowEnd = stopAtRel !== null ? Math.min(stopAtRel, totalMs) : totalMs;
  const windowMs = Math.max(1, windowEnd - warmupMs);
  const windowSec = windowMs / 1000;
  const latency = latencyStats(total);
  const lagStats = latencyStats(add(results.map((r) => r.scheduleLag)));
  const loopStats = latencyStats(add(results.map((r) => r.loopLag)));
  const errorRate = requests ? errors / requests : 0;
  const rps = {
    requested:
      model === "open" ? round(schedule.countBetween(warmupMs, windowEnd) / windowSec, 2) : null,
    sent: round(counters.started / windowSec, 2),
    achieved: round(requests / windowSec, 2),
  };

  const timeline: TimelinePoint[] = [...merged.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, m]) => {
      const s = samples.get(t);
      return {
        t,
        warmup: t * 1000 < warmupMs,
        targetRps: model === "open" ? round(schedule.countBetween(t * 1000, (t + 1) * 1000), 2) : 0,
        sentRps: m.sent,
        rps: m.requests,
        errors: m.errors,
        concurrency: sum(m.concurrency),
        latencyMs: {
          p50: m.latency.getValueAtPercentile(50) / 1000,
          p95: m.latency.getValueAtPercentile(95) / 1000,
          p99: m.latency.getValueAtPercentile(99) / 1000,
          max: m.latency.maxValue / 1000,
        },
        ...(s ? { cpu: s.cpu, memPct: s.memPct } : {}),
      };
    });

  const sampleList = [...samples.values()];
  const machine = sampleList.length
    ? {
        cpuAvg: round(sampleList.reduce((a, s) => a + s.cpu, 0) / sampleList.length, 1),
        cpuMax: Math.max(...sampleList.map((s) => s.cpu)),
        memMaxPct: Math.max(...sampleList.map((s) => s.memPct)),
        rssMaxMb: Math.max(...sampleList.map((s) => s.rssMb)),
      }
    : null;

  const invalidReasons: string[] = [];
  const warnings: string[] = [];
  if (model === "open" && lagStats.count && lagStats.p99 > MAX_SCHEDULE_LAG_P99_MS) {
    invalidReasons.push(
      `resultado inválido: o gerador não conseguiu sustentar a taxa (atraso de agendamento p99 = ${lagStats.p99.toFixed(1)}ms > ${MAX_SCHEDULE_LAG_P99_MS}ms)`,
    );
  }
  if (loopStats.count && loopStats.p99 > MAX_LOOP_LAG_P99_MS) {
    invalidReasons.push(
      `resultado inválido: o gerador está saturado (atraso do event loop p99 = ${loopStats.p99.toFixed(1)}ms > ${MAX_LOOP_LAG_P99_MS}ms); use mais workers ou outra máquina`,
    );
  }
  if (machine && machine.cpuAvg > 90) {
    warnings.push(
      `CPU da máquina em ${machine.cpuAvg}% (média): gerador e alvo podem estar disputando CPU; os números podem incluir essa disputa.`,
    );
  }
  if (counters.dropped) {
    warnings.push(
      `${counters.dropped} iteração(ões) descartada(s): ${maxInFlight} já estavam em andamento (load.maxInFlight). O alvo não acompanhou a taxa ou o limite está baixo.`,
    );
  }
  if (counters.throttled) {
    warnings.push(
      `o teto de segurança de ${opts.maxRps} rps (LT_MAX_RPS) segurou os VUs ${counters.throttled} vez(es): a vazão medida é a do teto, não a capacidade do alvo.`,
    );
  }
  if (model === "closed" && !sc.load.pacingMs) {
    warnings.push(
      "modelo fechado sem pacing: quando o alvo fica lento os VUs enviam menos, e a latência pode ser subestimada (omissão coordenada). Use pacing ou o modelo aberto para medir latência sob carga.",
    );
  }
  if (counters.aborted) {
    warnings.push(
      `${counters.aborted} requisição(ões) abortada(s) na parada (excluídas das estatísticas).`,
    );
  }
  if (requests && requests < 100) {
    warnings.push(
      `apenas ${requests} requisições medidas: percentis altos (p99/p99.9) têm pouca confiabilidade.`,
    );
  }

  const thresholds = evaluateThresholds(sc.thresholds.map(parseThreshold), (metric) => {
    if (!requests) return null;
    if (metric === "errorRate") return errorRate;
    if (metric === "rps") return rps.achieved;
    if (metric === "mean") return latency.mean;
    if (metric === "max") return latency.max;
    if (metric === "min") return latency.min;
    if (metric.startsWith("p")) return total.getValueAtPercentile(Number(metric.slice(1))) / 1000;
    return null;
  });

  const elapsed = endedPerf - startPerf;
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
      durationMs: round(elapsed, 1),
      seed: sc.seed,
      model,
      invalid: invalidReasons.length > 0,
      invalidReasons,
      warnings,
      ...(stopReason ? { stopReason, breakingPoint } : {}),
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
        http2: sc.target.http2,
      },
      load: {
        model,
        stages: model === "open" ? sc.load.stages : [],
        vuStages: sc.load.vuStages,
        ...(sc.load.pacingMs ? { pacingMs: sc.load.pacingMs } : {}),
        warmupMs,
        connections,
        ...(model === "open" ? { maxInFlight } : {}),
        workers,
        stopWhen: sc.load.stopWhen,
      },
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
      requests: { total: requests, ok: requests - errors, failed: errors },
      iterations: {
        scheduled: counters.scheduled,
        started: counters.started,
        completed: counters.completed,
        dropped: counters.dropped,
      },
      errorRate: round(errorRate, 6),
      rps,
      maxConcurrency: Math.max(0, ...timeline.map((p) => p.concurrency)),
      latencyMs: latency,
      serviceTimeMs: latencyStats(add(results.map((r) => r.serviceTime))),
      ttfbMs: latencyStats(add(results.map((r) => r.ttfb))),
      downloadMs: latencyStats(add(results.map((r) => r.download))),
      connections: {
        opened: results.reduce((a, r) => a + r.connections.opened, 0),
        byProtocol,
        dnsMs: latencyStats(add(results.map((r) => r.connections.dns))),
        connectMs: latencyStats(add(results.map((r) => r.connections.connect))),
        tlsMs: latencyStats(add(results.map((r) => r.connections.tls))),
      },
      statusCodes,
      errorsByType,
      bytes: { received: bytesIn, sent: bytesOut },
      checks: { passed: checksPassed, failed: checksFailed },
    },
    steps: stepReports,
    timeline,
    thresholds,
    generator: {
      workers,
      scheduleLagMs: lagStats,
      loopLagMs: loopStats,
      cpuPercent: round((results.reduce((a, r) => a + r.cpuMicros, 0) / 1000 / elapsed) * 100, 1),
      timerMarginMs: TIMER_MARGIN_MS,
      throttled: counters.throttled,
    },
    machine,
    histograms: { latencyUs: encodeHistogram(total) },
  };
  return maskDeep(report, sc.secrets);
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
