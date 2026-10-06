import { performance } from "node:perf_hooks";
import { Agent, Pool } from "undici";
import {
  StepMetrics,
  classifyError,
  encodeHistogram,
  newHistogram,
  recordMs,
  type ErrorType,
  type Histogram,
} from "../metrics.js";
import { PreciseScheduler } from "../precise-timer.js";
import { ArrivalSchedule } from "../schedule.js";
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
} from "../scenario/execute.js";
import type { Scenario, Step, VuStage } from "../scenario/types.js";
import { GrpcClients, runGrpcStep } from "../protocols/grpc.js";
import type { ProtocolOutcome } from "../protocols/outcome.js";
import { runWsStep } from "../protocols/ws.js";
import { instrumentedConnector, type ConnectionTiming } from "./connector.js";
import type { BucketData, EngineConfig, EngineResult, StepResult } from "./protocol.js";

const BURST_TOLERANCE_MS = 100;

interface LocalBucket {
  scheduled: number;
  sent: number;
  requests: number;
  errors: number;
  concurrency: number;
  latency: Histogram;
}

interface SendOutcome {
  res?: ResponseData;
  error?: ErrorType;
  message?: string;
  bytesIn: number;
  headersAt?: number;
}

/** Número de VUs pedido no instante t (ms) — linear por etapa. */
export function vusAt(stages: VuStage[], tMs: number): number {
  let start = 0;
  for (const st of stages) {
    if (tMs < start + st.durationMs) {
      const f = st.durationMs ? (tMs - start) / st.durationMs : 0;
      return st.vusFrom + (st.vusTo - st.vusFrom) * f;
    }
    start += st.durationMs;
  }
  return 0;
}

/** Primeiro instante ≥ from em que o VU v (0-based) deve estar ativo (vusAt > v), ou null. */
export function nextActivation(stages: VuStage[], v: number, from: number): number | null {
  let start = 0;
  for (const st of stages) {
    const end = start + st.durationMs;
    if (end > from) {
      const a = Math.max(start, from);
      if (vusAt(stages, a) > v) return a;
      // dentro da etapa a contagem é linear: procura o cruzamento de v
      if (st.vusTo > v && st.vusTo !== st.vusFrom) {
        const t = start + ((v - st.vusFrom) / (st.vusTo - st.vusFrom)) * st.durationMs;
        const tt = Math.max(a, t) + 0.001;
        if (tt < end && vusAt(stages, tt) > v) return tt;
      }
    }
    start = end;
  }
  return null;
}

/**
 * Motor de carga de UM worker. No modelo aberto atende as chegadas k com k % workerCount ==
 * workerIndex; no fechado, os VUs v com v % workerCount == workerIndex. O índice global da
 * iteração (k, ou n·maxVus + v) é a semente dos dados, então o resultado não depende de quantos
 * workers existem.
 */
export class Engine {
  private readonly timer = new PreciseScheduler();
  private readonly pool: Pool;
  private readonly base: URL;
  private readonly basePath: string;
  private readonly hardAbort = new AbortController();
  private readonly flowMetrics: StepMetrics[][];
  private readonly serviceTime = newHistogram();
  private readonly ttfb = newHistogram();
  private readonly download = newHistogram();
  private readonly scheduleLag = newHistogram();
  private readonly loopLag = newHistogram();
  private readonly conn = {
    opened: 0,
    byProtocol: {} as Record<string, number>,
    dns: newHistogram(),
    connect: newHistogram(),
    tls: newHistogram(),
  };
  private readonly ws = {
    sessions: 0,
    sent: 0,
    received: 0,
    connect: newHistogram(),
    rtt: newHistogram(),
  };
  private readonly grpcStreams = {
    streams: 0,
    sent: 0,
    received: 0,
    first: newHistogram(),
    rtt: newHistogram(),
  };
  private readonly grpc = new GrpcClients();
  private wsAgent: Agent | undefined;
  private readonly buckets = new Map<number, LocalBucket>();
  private readonly sleepers = new Set<() => void>();
  private readonly counters = {
    scheduled: 0,
    started: 0,
    completed: 0,
    dropped: 0,
    aborted: 0,
    throttled: 0,
  };
  private startPerf = 0;
  private inFlight = 0;
  private activeVus = 0;
  private stopping = false;
  private stopAtRel: number | null = null;
  private schedulingDone = false;
  private nextFlush = 0;
  private resolveIdle!: () => void;
  private readonly idle = new Promise<void>((r) => (this.resolveIdle = r));
  private readonly cpuStart = threadCpu();
  private nextTokenAt = 0;
  private readonly tokenInterval: number;

  constructor(
    private readonly sc: Scenario,
    private readonly cfg: EngineConfig,
    private readonly emitBucket: (b: BucketData) => void,
  ) {
    this.base = new URL(sc.target.baseUrl);
    this.basePath = this.base.pathname.replace(/\/+$/, "");
    this.pool = new Pool(this.base.origin, {
      connections: cfg.connections,
      pipelining: 1,
      keepAliveTimeout: 10_000,
      allowH2: sc.target.http2,
      connect: instrumentedConnector(
        { timeoutMs: sc.target.timeoutMs, http2: sc.target.http2, ca: sc.target.ca },
        (t) => this.onConnection(t),
      ),
    });
    const multiFlow = sc.flows.length > 1;
    this.flowMetrics = sc.flows.map((f) =>
      f.steps.map((s) => new StepMetrics(s.name, s.method, s.path, multiFlow ? f.name : "")),
    );
    this.tokenInterval = cfg.maxRps > 0 ? 1000 / cfg.maxRps : 0;
  }

  private onConnection(t: ConnectionTiming): void {
    this.conn.opened++;
    this.conn.byProtocol[t.protocol] = (this.conn.byProtocol[t.protocol] ?? 0) + 1;
    recordMs(this.conn.dns, t.dnsMs);
    recordMs(this.conn.connect, t.connectMs);
    recordMs(this.conn.tls, t.tlsMs);
  }

  // ------------------------------------------------------------ ciclo de vida

  async run(startEpochMs: number): Promise<{ result: EngineResult; finalBuckets: BucketData[] }> {
    this.startPerf = startEpochMs - performance.timeOrigin;
    // gRPC: abre o canal antes do início (a primeira conexão do grpc-js trava o event loop por alguns ms)
    if (this.sc.flows.some((f) => f.steps.some((st) => st.kind === "grpc"))) {
      const client = this.grpc.get(this.base, this.sc.target.ca);
      const deadline = Math.max(this.startPerf - performance.now(), 50);
      await new Promise<void>((r) => client.waitForReady(Date.now() + deadline, () => r()));
    }
    const flushTimer = setInterval(() => this.flush(false), 250);
    const wait = this.startPerf - performance.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const lagTimer = setInterval(() => {
      const t0 = performance.now();
      setImmediate(() => recordMs(this.loopLag, performance.now() - t0));
    }, 100);

    if (this.sc.load.model === "open") this.startOpen();
    else this.startClosed();

    await this.idle;
    clearInterval(flushTimer);
    clearInterval(lagTimer);
    this.timer.clear();
    const hard = this.hardAbort.signal.aborted;
    await Promise.all(
      [this.pool, this.wsAgent].map((d) => d && (hard ? d.destroy() : d.close()).catch(() => {})),
    );
    this.grpc.close();
    const finalBuckets = this.flush(true);
    return { result: this.result(), finalBuckets };
  }

  /** Parada graciosa: para de agendar, acorda pausas (think) e drena as requisições em andamento. */
  stop(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.stopAtRel = performance.now() - this.startPerf;
    this.timer.clear();
    for (const wake of [...this.sleepers]) wake();
    this.checkIdle();
    const drain = setTimeout(() => this.hardAbort.abort(), this.cfg.drainTimeoutMs);
    drain.unref();
    void this.idle.then(() => clearTimeout(drain));
  }

  private checkIdle(): void {
    if ((this.schedulingDone || this.stopping) && this.inFlight === 0) this.resolveIdle();
  }

  private rel(): number {
    return performance.now() - this.startPerf;
  }

  private sleepUntil(absPerf: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.stopping) return resolve();
      const done = () => {
        this.sleepers.delete(done);
        resolve();
      };
      this.sleepers.add(done);
      this.timer.at(absPerf, done);
    });
  }

  // ------------------------------------------------------------ métricas por segundo

  private bucket(relMs: number): LocalBucket {
    const t = Math.max(0, Math.floor(relMs / 1000));
    let b = this.buckets.get(t);
    if (!b) {
      b = {
        scheduled: 0,
        sent: 0,
        requests: 0,
        errors: 0,
        concurrency: this.gauge(),
        latency: newHistogram(2),
      };
      this.buckets.set(t, b);
    }
    return b;
  }

  private gauge(): number {
    return this.sc.load.model === "open" ? this.inFlight : this.activeVus;
  }

  private touchGauge(): void {
    const b = this.bucket(this.rel());
    b.concurrency = Math.max(b.concurrency, this.gauge());
  }

  /** Envia os segundos já fechados (e reenvios tardios); no fim devolve o que restou. */
  private flush(final: boolean): BucketData[] {
    const watermark = final ? Infinity : Math.floor(this.rel() / 1000);
    const out: BucketData[] = [];
    const ser = (t: number, b: LocalBucket): BucketData => ({
      t,
      scheduled: b.scheduled,
      sent: b.sent,
      requests: b.requests,
      errors: b.errors,
      concurrency: b.concurrency,
      latency: encodeHistogram(b.latency),
    });
    for (const [t, b] of [...this.buckets].sort((a, z) => a[0] - z[0])) {
      if (t >= watermark) break;
      out.push(ser(t, b));
      this.buckets.delete(t);
    }
    // segundos sem atividade também são enviados: o coordenador precisa saber até onde cada worker chegou
    if (!final) {
      for (let t = this.nextFlush; t < watermark; t++) {
        if (!out.some((b) => b.t === t)) {
          out.push({
            t,
            scheduled: 0,
            sent: 0,
            requests: 0,
            errors: 0,
            concurrency: this.gauge(),
            latency: "",
          });
        }
      }
      out.sort((a, z) => a.t - z.t);
      this.nextFlush = Math.max(this.nextFlush, watermark);
      for (const b of out) this.emitBucket(b);
      return [];
    }
    return out;
  }

  // ------------------------------------------------------------ modelo aberto

  private startOpen(): void {
    const schedule = new ArrivalSchedule(this.sc.load.stages);
    const { workerIndex: w, workerCount: W } = this.cfg;
    let k = -1;
    const scheduleNext = () => {
      for (;;) {
        const t = schedule.next();
        if (t === null) {
          this.schedulingDone = true;
          this.checkIdle();
          return;
        }
        k++;
        if (k % W !== w) continue;
        const index = k;
        this.timer.at(this.startPerf + t, () => onArrival(t, index));
        return;
      }
    };
    const onArrival = (tRel: number, index: number) => {
      if (this.stopping) return;
      const lag = performance.now() - (this.startPerf + tRel);
      const warmup = tRel < this.sc.load.warmupMs;
      const b = this.bucket(tRel);
      b.scheduled++;
      if (!warmup) {
        this.counters.scheduled++;
        recordMs(this.scheduleLag, Math.max(0.001, lag));
      }
      if (this.inFlight >= this.cfg.maxInFlight) {
        if (!warmup) this.counters.dropped++;
      } else {
        this.inFlight++;
        this.touchGauge();
        b.sent++;
        if (!warmup) this.counters.started++;
        void this.runIteration(this.startPerf + tRel, warmup, index).finally(() => {
          this.inFlight--;
          this.checkIdle();
        });
      }
      scheduleNext();
    };
    scheduleNext();
  }

  // ------------------------------------------------------------ modelo fechado

  private startClosed(): void {
    const stages = this.sc.load.vuStages;
    const totalMs = stages.reduce((s, st) => s + st.durationMs, 0);
    const maxVus = Math.max(0, ...stages.map((s) => Math.max(s.vusFrom, s.vusTo)));
    const { workerIndex: w, workerCount: W } = this.cfg;
    const mine: number[] = [];
    for (let v = w; v < maxVus; v += W) mine.push(v);
    let running = mine.length;
    const finished = () => {
      if (--running === 0) {
        this.schedulingDone = true;
        this.checkIdle();
      }
    };
    if (!running) {
      this.schedulingDone = true;
      this.checkIdle();
      return;
    }
    const pacing = this.sc.load.pacingMs;

    const vuLoop = async (v: number) => {
      let n = 0;
      let at = nextActivation(stages, v, 0);
      while (at !== null && at < totalMs && !this.stopping) {
        await this.sleepUntil(this.startPerf + at);
        if (this.stopping) break;
        this.activeVus++;
        this.touchGauge();
        let slot = this.startPerf + at;
        for (;;) {
          const rel = this.rel();
          if (this.stopping || rel >= totalMs || !(vusAt(stages, rel) > v)) break;
          let intended = performance.now();
          if (pacing) {
            if (slot > intended) {
              await this.sleepUntil(slot);
              if (this.stopping) break;
            }
            // atrasado: a latência conta desde o horário previsto (corrige omissão coordenada)
            intended = slot;
            slot += pacing;
          }
          const warmup = intended - this.startPerf < this.sc.load.warmupMs;
          const b = this.bucket(intended - this.startPerf);
          b.sent++;
          if (!warmup) this.counters.started++;
          this.inFlight++;
          try {
            await this.runIteration(intended, warmup, n * maxVus + v);
          } finally {
            this.inFlight--;
          }
          n++;
        }
        this.activeVus--;
        this.touchGauge();
        at = nextActivation(stages, v, this.rel());
      }
      finished();
    };
    for (const v of mine) void vuLoop(v);
  }

  /**
   * Teto de RPS no modelo fechado (VUs rápidos contra um alvo rápido podem passar do limite).
   * GCRA: limita a média e tolera rajadas de até 100 ms de taxa (VUs que chegam juntos não contam
   * como limitação).
   */
  private async takeToken(): Promise<void> {
    if (!this.tokenInterval) return;
    const now = performance.now();
    const tat = Math.max(this.nextTokenAt, now);
    const allowAt = tat - BURST_TOLERANCE_MS;
    this.nextTokenAt = tat + this.tokenInterval;
    if (allowAt <= now) return;
    this.counters.throttled++;
    await this.sleepUntil(allowAt);
  }

  // ------------------------------------------------------------ iteração e requisição

  private async send(req: BuiltRequest, needsBody: boolean): Promise<SendOutcome> {
    const ac = new AbortController();
    const onHard = () => ac.abort(new DOMException("execução interrompida", "AbortError"));
    this.hardAbort.signal.addEventListener("abort", onHard, { once: true });
    const timeoutMs = this.sc.target.timeoutMs;
    const to = setTimeout(
      () => ac.abort(new DOMException(`timeout de ${timeoutMs}ms`, "TimeoutError")),
      timeoutMs,
    );
    try {
      const res = await this.pool.request({
        method: req.method as "GET",
        path: req.path,
        headers: req.headers,
        body: req.body,
        signal: ac.signal,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      });
      const headersAt = performance.now();
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
        headersAt,
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
      this.hardAbort.signal.removeEventListener("abort", onHard);
    }
  }

  private async sendHttp(
    step: Step,
    req: BuiltRequest,
    intended: number,
    it: Iteration,
  ): Promise<ProtocolOutcome> {
    const out = await this.send(req, step.needsBody);
    if (!out.res)
      return {
        error: out.error,
        message: out.message,
        checks: [],
        bytesIn: 0,
        bytesOut: req.bytesOut,
      };
    const ev: Evaluation = evaluateResponse(step, out.res, performance.now() - intended, it.ctx);
    return {
      statusKey: String(out.res.status),
      error: ev.error,
      message: ev.message,
      checks: ev.checks,
      bytesIn: out.bytesIn,
      bytesOut: req.bytesOut,
      firstByteAt: out.headersAt,
    };
  }

  private sendOther(step: Step, it: Iteration, warmup: boolean): Promise<ProtocolOutcome> {
    const headers = this.sc.target.headers;
    const timeoutMs = this.sc.target.timeoutMs;
    const hardSignal = this.hardAbort.signal;
    if (step.kind === "grpc") {
      const client = this.grpc.get(this.base, this.sc.target.ca);
      return runGrpcStep(step, it.ctx, {
        client,
        timeoutMs,
        targetHeaders: headers,
        hardSignal,
        sleep: (ms) => this.sleepUntil(performance.now() + ms),
        onFirstMessage: (ms) => !warmup && recordMs(this.grpcStreams.first, ms),
        onRtt: (ms) => !warmup && recordMs(this.grpcStreams.rtt, ms),
      });
    }
    this.wsAgent ??= new Agent({
      connections: null,
      connect: instrumentedConnector({ timeoutMs, http2: false, ca: this.sc.target.ca }, (t) =>
        this.onConnection(t),
      ),
    });
    return runWsStep(step, it.ctx, {
      base: this.base,
      basePath: this.basePath,
      targetHeaders: headers,
      timeoutMs,
      dispatcher: this.wsAgent,
      hardSignal,
      sleep: (ms) => this.sleepUntil(performance.now() + ms),
      onConnect: (ms) => !warmup && recordMs(this.ws.connect, ms),
      onRtt: (ms) => !warmup && recordMs(this.ws.rtt, ms),
    });
  }

  /** Falha antes de enviar (ex.: template inválido em tempo de execução): conta como requisição com erro. */
  private recordUnsent(m: StepMetrics, warmup: boolean, message: string): void {
    const b = this.bucket(this.rel());
    b.requests++;
    b.errors++;
    if (warmup) return;
    m.requests++;
    m.addError("template_error", message);
  }

  private async runIteration(intendedAbs: number, warmup: boolean, index: number): Promise<void> {
    let it: Iteration;
    try {
      it = createIteration(this.sc, index);
    } catch (e) {
      this.recordUnsent(this.flowMetrics[0]![0]!, warmup, `variables: ${templateErrorMessage(e)}`);
      return;
    }
    const metrics = this.flowMetrics[it.flowIndex]!;
    const closed = this.sc.load.model === "closed";
    let intended = intendedAbs;
    for (let i = 0; i < it.flow.steps.length; i++) {
      if (i > 0 && (this.stopping || this.hardAbort.signal.aborted)) return;
      const step = it.flow.steps[i]!;
      let req: BuiltRequest | undefined;
      if (step.kind === "http") {
        try {
          req = buildRequest(this.sc, step, it.ctx, this.basePath, this.base.host);
        } catch (e) {
          this.recordUnsent(metrics[i]!, warmup, templateErrorMessage(e));
          return;
        }
      }
      if (closed) {
        await this.takeToken();
        if (this.stopping && i > 0) return;
      }
      const sentAt = performance.now();
      let out: ProtocolOutcome;
      try {
        out = req
          ? await this.sendHttp(step, req, intended, it)
          : await this.sendOther(step, it, warmup);
      } catch (e) {
        // erro de template dentro do roteiro WS / mensagem gRPC
        this.recordUnsent(metrics[i]!, warmup, templateErrorMessage(e));
        return;
      }
      const end = performance.now();
      const latency = end - intended;
      if (out.error === "aborted") {
        this.counters.aborted++;
        return;
      }
      // WS/gRPC: o tempo máximo vale para a etapa inteira (no HTTP, evaluateResponse já checou)
      const maxMs = step.kind === "http" ? undefined : step.expect.maxDurationMs;
      if (maxMs !== undefined && !out.error) {
        const ok = latency <= maxMs;
        out.checks.push({ label: `tempo ≤ ${maxMs}ms`, ok });
        if (!ok) {
          out.error = "check_failed";
          out.message = `tempo ${latency.toFixed(0)}ms > ${maxMs}ms`;
        }
      }

      const b = this.bucket(end - this.startPerf);
      b.requests++;
      if (out.error) b.errors++;
      recordMs(b.latency, latency);

      if (!warmup) {
        const m = metrics[i]!;
        m.requests++;
        m.bytesIn += out.bytesIn;
        m.bytesOut += out.bytesOut;
        recordMs(m.latency, latency);
        if (out.statusKey) m.statusCodes[out.statusKey] = (m.statusCodes[out.statusKey] ?? 0) + 1;
        if (out.error) m.addError(out.error, out.message);
        for (const c of out.checks) m.addCheck(c.label, c.ok);
        recordMs(this.serviceTime, end - sentAt);
        if (out.firstByteAt !== undefined) {
          recordMs(this.ttfb, out.firstByteAt - sentAt);
          recordMs(this.download, end - out.firstByteAt);
        }
        if (step.kind === "ws") {
          this.ws.sessions++;
          this.ws.sent += out.messagesSent ?? 0;
          this.ws.received += out.messagesReceived ?? 0;
        } else if (step.grpc && step.grpc.mode !== "unary") {
          this.grpcStreams.streams++;
          this.grpcStreams.sent += out.messagesSent ?? 0;
          this.grpcStreams.received += out.messagesReceived ?? 0;
        }
      }
      if (out.error) return; // etapas seguintes dependem desta
      const think = thinkTimeMs(step, it.ctx);
      if (think > 0) {
        await this.sleepUntil(performance.now() + think);
        if (this.stopping) return;
      }
      intended = performance.now();
    }
    if (!warmup) this.counters.completed++;
  }

  // ------------------------------------------------------------ resultado

  private result(): EngineResult {
    const steps: StepResult[] = this.flowMetrics.flat().map((m) => ({
      requests: m.requests,
      errors: m.errors,
      bytesIn: m.bytesIn,
      bytesOut: m.bytesOut,
      statusCodes: m.statusCodes,
      errorsByType: m.errorsByType,
      checks: [...m.checks].map(([k, c]): [string, number, number] => [k, c.passed, c.failed]),
      failures: [...m.failures],
      latency: encodeHistogram(m.latency),
    }));
    const maxVus = Math.max(0, ...this.sc.load.vuStages.map((s) => Math.max(s.vusFrom, s.vusTo)));
    return {
      steps,
      serviceTime: encodeHistogram(this.serviceTime),
      ttfb: encodeHistogram(this.ttfb),
      download: encodeHistogram(this.download),
      scheduleLag: encodeHistogram(this.scheduleLag),
      loopLag: encodeHistogram(this.loopLag),
      connections: {
        opened: this.conn.opened,
        byProtocol: this.conn.byProtocol,
        dns: encodeHistogram(this.conn.dns),
        connect: encodeHistogram(this.conn.connect),
        tls: encodeHistogram(this.conn.tls),
      },
      counters: { ...this.counters },
      cpuMicros: threadCpu() - this.cpuStart,
      stopAtRelMs: this.stopAtRel,
      maxVus,
      ...(this.ws.sessions || this.ws.connect.totalCount
        ? {
            ws: {
              sessions: this.ws.sessions,
              messagesSent: this.ws.sent,
              messagesReceived: this.ws.received,
              connect: encodeHistogram(this.ws.connect),
              rtt: encodeHistogram(this.ws.rtt),
            },
          }
        : {}),
      ...(this.grpcStreams.streams
        ? {
            grpcStreams: {
              streams: this.grpcStreams.streams,
              messagesSent: this.grpcStreams.sent,
              messagesReceived: this.grpcStreams.received,
              firstMessage: encodeHistogram(this.grpcStreams.first),
              rtt: encodeHistogram(this.grpcStreams.rtt),
            },
          }
        : {}),
    };
  }
}

/** CPU (µs) da thread atual quando o Node oferece threadCpuUsage; senão, do processo. */
function threadCpu(): number {
  const p = process as unknown as { threadCpuUsage?: () => NodeJS.CpuUsage };
  const u = p.threadCpuUsage ? p.threadCpuUsage() : process.cpuUsage();
  return u.user + u.system;
}
