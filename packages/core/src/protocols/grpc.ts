import { performance } from "node:perf_hooks";
import * as grpc from "@grpc/grpc-js";
import type { ErrorType } from "../metrics.js";
import { evaluateResponse } from "../scenario/execute.js";
import { GRPC_CODES } from "../scenario/schema.js";
import {
  renderJson,
  renderTemplate,
  type RenderContext,
  type Template,
} from "../scenario/template.js";
import type { Step } from "../scenario/types.js";
import type { ProtocolOutcome } from "./outcome.js";

/** Um canal gRPC (HTTP/2 multiplexado) por endereço e por worker. */
export class GrpcClients {
  private clients = new Map<string, grpc.Client>();

  get(base: URL, ca?: string): grpc.Client {
    const tls = base.protocol === "https:";
    const address = `${base.hostname}:${base.port || (tls ? 443 : 80)}`;
    let c = this.clients.get(address);
    if (!c) {
      const creds = tls
        ? grpc.credentials.createSsl(ca ? Buffer.from(ca) : undefined)
        : grpc.credentials.createInsecure();
      c = new grpc.Client(address, creds, { "grpc.enable_retries": 0 });
      this.clients.set(address, c);
    }
    return c;
  }

  close(): void {
    for (const c of this.clients.values()) c.close();
    this.clients.clear();
  }
}

export interface GrpcDeps {
  client: grpc.Client;
  timeoutMs: number;
  targetHeaders: [string, Template][];
  hardSignal: AbortSignal;
  sleep: (ms: number) => Promise<void>;
  /** Streams: do início da chamada até a primeira mensagem recebida. */
  onFirstMessage: (ms: number) => void;
  /** Streams: do último envio até a mensagem esperada por um expect. */
  onRtt: (ms: number) => void;
}

const RESERVED = new Set([
  "host",
  "content-type",
  "content-length",
  "connection",
  "te",
  "user-agent",
]);
const codeName = (c: number) => GRPC_CODES[c] ?? String(c);
const identity = (b: Buffer) => b; // mensagens já serializadas (para medir bytes e validar)
const END = Symbol("fim");
const TIMEOUT = Symbol("timeout");
const aborted = (): ProtocolOutcome => ({
  error: "aborted",
  message: "execução interrompida",
  checks: [],
  bytesIn: 0,
  bytesOut: 0,
});

class InvalidMessage extends Error {}

function buildMetadata(
  step: Step,
  ctx: RenderContext,
  targetHeaders: [string, Template][],
): { md: grpc.Metadata; bytes: number } {
  const md = new grpc.Metadata();
  let bytes = 0;
  for (const [k, t] of [...targetHeaders, ...step.grpc!.metadata]) {
    const key = k.toLowerCase();
    if (RESERVED.has(key)) continue;
    const v = renderTemplate(t, ctx);
    md.set(key, v);
    bytes += key.length + v.length;
  }
  return { md, bytes };
}

function serialize(step: Step, value: unknown): Buffer {
  const spec = step.grpc!;
  try {
    return spec.requestSerialize(value);
  } catch (e) {
    throw new InvalidMessage(
      `mensagem inválida para ${spec.service}/${spec.method}: ${(e as Error).message}`,
    );
  }
}

type Verdict = { error?: ErrorType; message?: string };

/** Checagem do status final; devolve o erro quando o código não está entre os esperados. */
function checkStatus(
  step: Step,
  code: number,
  details: string | undefined,
  checks: ProtocolOutcome["checks"],
): Verdict {
  const expected = step.expect.grpcStatus ?? [0];
  const ok = expected.includes(code);
  if (step.expect.grpcStatus) {
    checks.push({
      label: `grpc ${expected.length > 1 ? `∈ {${expected.map(codeName).join(", ")}}` : `= ${codeName(expected[0]!)}`}`,
      ok,
    });
  }
  if (ok) return {};
  const error: ErrorType =
    code === grpc.status.DEADLINE_EXCEEDED
      ? "timeout"
      : code === grpc.status.UNAVAILABLE && /ECONNREFUSED|connect/i.test(details ?? "")
        ? "connection_refused"
        : "grpc_status";
  return {
    error,
    message: `status ${codeName(code)}${details ? `: ${details}` : ""}${step.expect.grpcStatus ? ` (esperado ${expected.map(codeName).join(" ou ")})` : ""}`,
  };
}

/**
 * Checagens da etapa sobre a resposta (unário/client streaming) ou a ÚLTIMA mensagem do stream
 * (jsonPath/bodyContains/bodyMatches/extract; a mensagem vira JSON) e a contagem de mensagens.
 */
function checkLast(
  step: Step,
  last: unknown,
  received: number,
  ctx: RenderContext,
  checks: ProtocolOutcome["checks"],
): Verdict {
  const ex = step.expect;
  let v: Verdict = {};
  if (ex.messages) {
    const ok = ex.messages.test(true, received);
    checks.push({ label: `mensagens ${ex.messages.label}`, ok });
    if (!ok)
      v = {
        error: "check_failed",
        message: `mensagens ${ex.messages.label} (recebidas: ${received})`,
      };
  }
  const wantsBody =
    ex.jsonPath.length > 0 ||
    ex.bodyContains.length > 0 ||
    !!ex.bodyMatches ||
    step.extract.length > 0;
  if (!wantsBody) return v;
  if (last === undefined) {
    checks.push({ label: "mensagem recebida", ok: false });
    return v.error ? v : { error: "check_failed", message: "nenhuma mensagem recebida" };
  }
  const pseudo: Step = {
    ...step,
    expect: { ...ex, status: undefined, maxDurationMs: undefined },
  };
  const ev = evaluateResponse(
    pseudo,
    { status: 200, headers: {}, body: Buffer.from(JSON.stringify(last)) },
    0,
    ctx,
  );
  checks.push(...ev.checks);
  return v.error ? v : { error: ev.error, message: ev.message };
}

/** Etapa gRPC: unária ou streaming (server, client, bidi), conforme o método no .proto. */
export async function runGrpcStep(
  step: Step,
  ctx: RenderContext,
  d: GrpcDeps,
): Promise<ProtocolOutcome> {
  try {
    return await (step.grpc!.mode === "unary" ? runUnary(step, ctx, d) : runStream(step, ctx, d));
  } catch (e) {
    if (!(e instanceof InvalidMessage)) throw e;
    return { error: "template_error", message: e.message, checks: [], bytesIn: 0, bytesOut: 0 };
  }
}

function runUnary(step: Step, ctx: RenderContext, d: GrpcDeps): Promise<ProtocolOutcome> {
  const spec = step.grpc!;
  const { md, bytes: mdBytes } = buildMetadata(step, ctx, d.targetHeaders);
  const payload = serialize(step, renderJson(spec.message, ctx));
  const bytesOut = payload.length + mdBytes;
  let bytesIn = 0;
  const deser = (b: Buffer) => {
    bytesIn += b.length;
    return spec.responseDeserialize(b);
  };

  return new Promise((resolve) => {
    let stopped = false;
    const call = d.client.makeUnaryRequest(
      spec.path,
      identity,
      deser,
      payload,
      md,
      { deadline: Date.now() + (spec.deadlineMs ?? d.timeoutMs) },
      (err, resp) => {
        d.hardSignal.removeEventListener("abort", onHard);
        if (stopped) return resolve(aborted());
        const code = err ? (err.code ?? 2) : 0;
        const checks: ProtocolOutcome["checks"] = [];
        const base = { statusKey: `grpc:${codeName(code)}`, checks, bytesIn, bytesOut };
        const st = checkStatus(step, code, err?.details, checks);
        if (st.error) return resolve({ ...base, ...st });
        if (err) return resolve(base); // status de erro aceito em grpcStatus: não há corpo
        resolve({ ...base, ...checkLast(step, resp, 1, ctx, checks) });
      },
    );
    const onHard = () => {
      stopped = true;
      call.cancel();
    };
    d.hardSignal.addEventListener("abort", onHard, { once: true });
  });
}

type StreamCall =
  | grpc.ClientReadableStream<unknown>
  | grpc.ClientWritableStream<Buffer>
  | grpc.ClientDuplexStream<Buffer, unknown>;

/**
 * Stream gRPC: executa o roteiro (send/expect/sleep/end), encerra o envio e lê o resto do stream
 * até o status final. Cada espera (expect, fim do stream) tem timeout; o prazo total é grpc.deadline.
 *  - server: envia `message` e lê o stream; client: envia pelo roteiro, resposta única no fim;
 *  - bidi: envio e leitura intercalados pelo roteiro.
 * As checagens da etapa (grpcStatus, messages, jsonPath… da última mensagem) valem no fim.
 */
async function runStream(step: Step, ctx: RenderContext, d: GrpcDeps): Promise<ProtocolOutcome> {
  const spec = step.grpc!;
  const { md, bytes: mdBytes } = buildMetadata(step, ctx, d.targetHeaders);
  const checks: ProtocolOutcome["checks"] = [];
  let bytesIn = 0;
  let bytesOut = mdBytes;
  let sent = 0;
  let received = 0;
  let last: unknown;
  const t0 = performance.now();

  const queue: unknown[] = [];
  let waiter: (() => void) | null = null;
  const wake = () => {
    const w = waiter;
    waiter = null;
    w?.();
  };
  let status: grpc.StatusObject | undefined;
  let done = false; // status recebido e mensagens pendentes já entregues
  let stopped = false;
  const deser = (b: Buffer) => {
    bytesIn += b.length;
    return spec.responseDeserialize(b);
  };
  const onMessage = (m: unknown) => {
    if (received === 0) d.onFirstMessage(performance.now() - t0);
    received++;
    last = m;
    queue.push(m);
    wake();
  };

  const opts: grpc.CallOptions = spec.deadlineMs ? { deadline: Date.now() + spec.deadlineMs } : {};
  let call: StreamCall;
  if (spec.mode === "server") {
    const payload = serialize(step, renderJson(spec.message, ctx));
    bytesOut += payload.length;
    sent++;
    call = d.client.makeServerStreamRequest(spec.path, identity, deser, payload, md, opts);
  } else if (spec.mode === "client") {
    call = d.client.makeClientStreamRequest(spec.path, identity, deser, md, opts, (err, resp) => {
      if (!err && resp !== undefined) onMessage(resp);
    });
  } else {
    call = d.client.makeBidiStreamRequest(spec.path, identity, deser, md, opts);
  }
  if (spec.mode !== "client") call.on("data", onMessage);
  call.on("error", () => {}); // o status chega pelo evento "status"
  call.on("status", (st: grpc.StatusObject) => {
    status = st;
    // mensagens já recebidas podem ser entregues logo depois do status
    setImmediate(() => {
      done = true;
      wake();
    });
  });
  const onHard = () => {
    stopped = true;
    call.cancel();
    wake();
  };
  d.hardSignal.addEventListener("abort", onHard, { once: true });

  /** Próxima mensagem, END (stream terminou) ou TIMEOUT. */
  const next = (timeoutMs: number): Promise<unknown> => {
    if (queue.length) return Promise.resolve(queue.shift());
    if (done || stopped) return Promise.resolve(END);
    return new Promise((resolve) => {
      const to = setTimeout(() => {
        waiter = null;
        resolve(TIMEOUT);
      }, timeoutMs);
      waiter = () => {
        clearTimeout(to);
        resolve(queue.length ? queue.shift() : done || stopped ? END : next(timeoutMs));
      };
    });
  };
  const result = (v: Verdict): ProtocolOutcome => ({
    statusKey: status ? `grpc:${codeName(status.code)}` : undefined,
    checks,
    bytesIn,
    bytesOut,
    messagesSent: sent,
    messagesReceived: received,
    ...v,
  });
  const endWrite = () => {
    if (spec.mode === "server") return;
    const w = call as grpc.ClientWritableStream<Buffer>;
    if (!w.writableEnded) w.end();
  };
  /** O stream terminou antes do esperado: o status explica (erro) ou faltou mensagem. */
  const endedEarly = (what: string): ProtocolOutcome => {
    const st = checkStatus(step, status?.code ?? grpc.status.UNKNOWN, status?.details, []);
    if (st.error) return result({ error: st.error, message: `${what}: ${st.message}` });
    return result({ error: "check_failed", message: `${what}: o stream terminou antes` });
  };

  try {
    let lastSend: number | null = null;
    for (const a of spec.script) {
      if (stopped) return aborted();
      if (a.kind === "send") {
        const buf = serialize(step, renderJson(a.json!, ctx));
        if (done) return endedEarly(`envio ${sent + 1}`);
        (call as grpc.ClientWritableStream<Buffer>).write(buf);
        bytesOut += buf.length;
        sent++;
        lastSend = performance.now();
      } else if (a.kind === "end") {
        endWrite();
      } else if (a.kind === "sleep") {
        await d.sleep(a.ms);
      } else {
        const msg = await next(a.timeoutMs);
        if (stopped) return aborted();
        if (msg === TIMEOUT) {
          checks.push({ label: `msg ${a.index}: recebida`, ok: false });
          return result({
            error: "timeout",
            message: `msg ${a.index}: nenhuma mensagem em ${a.timeoutMs}ms`,
          });
        }
        if (msg === END) {
          checks.push({ label: `msg ${a.index}: recebida`, ok: false });
          return endedEarly(`msg ${a.index}`);
        }
        if (lastSend !== null) {
          d.onRtt(performance.now() - lastSend);
          lastSend = null;
        }
        const pseudo: Step = { ...step, expect: a.expect, extract: a.extract, needsBody: true };
        const ev = evaluateResponse(
          pseudo,
          { status: 200, headers: {}, body: Buffer.from(JSON.stringify(msg)) },
          0,
          ctx,
        );
        checks.push(...ev.checks.map((c) => ({ label: `msg ${a.index}: ${c.label}`, ok: c.ok })));
        if (ev.error) return result({ error: ev.error, message: `msg ${a.index}: ${ev.message}` });
      }
    }
    endWrite();
    // lê o resto do stream até o status (timeout = tempo máximo sem nenhuma novidade)
    for (;;) {
      const msg = await next(d.timeoutMs);
      if (stopped) return aborted();
      if (msg === END) break;
      if (msg === TIMEOUT) {
        return result({
          error: "timeout",
          message: `o stream não terminou (nenhuma mensagem nem status em ${d.timeoutMs}ms)`,
        });
      }
    }
    const st = checkStatus(step, status!.code, status!.details, checks);
    if (st.error) return result(st);
    return result(checkLast(step, last, received, ctx, checks));
  } finally {
    d.hardSignal.removeEventListener("abort", onHard);
    if (!status) call.cancel();
  }
}
