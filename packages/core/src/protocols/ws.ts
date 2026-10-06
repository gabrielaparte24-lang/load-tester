import { performance } from "node:perf_hooks";
import { WebSocket, type Dispatcher } from "undici";
import { classifyError } from "../metrics.js";
import { evaluateResponse } from "../scenario/execute.js";
import {
  renderJson,
  renderTemplate,
  type RenderContext,
  type Template,
} from "../scenario/template.js";
import { decodeBinary } from "../scenario/binary.js";
import type { ExpectSpec, Step, WsAction } from "../scenario/types.js";
import type { ProtocolOutcome } from "./outcome.js";

export interface WsDeps {
  base: URL;
  basePath: string;
  targetHeaders: [string, Template][];
  timeoutMs: number;
  dispatcher: Dispatcher;
  hardSignal: AbortSignal;
  sleep: (ms: number) => Promise<void>;
  onConnect: (ms: number) => void;
  onRtt: (ms: number) => void;
}

/**
 * Etapa WebSocket: abre a conexão (handshake medido), executa o roteiro em ordem e fecha.
 *  - send/sendJson: envia uma mensagem (com templates);
 *  - expect: espera a PRÓXIMA mensagem (até `timeout`) e aplica as checagens/extrações;
 *    o tempo entre o último envio e essa mensagem é o RTT da mensagem;
 *  - sleep: pausa.
 * O endereço é sempre target.baseUrl (http→ws, https→wss): a allowlist continua valendo.
 */
export async function runWsStep(
  step: Step,
  ctx: RenderContext,
  d: WsDeps,
): Promise<ProtocolOutcome> {
  const spec = step.ws!;
  const scheme = d.base.protocol === "https:" ? "wss:" : "ws:";
  const url = `${scheme}//${d.base.host}${d.basePath}${renderTemplate(spec.path, ctx)}`;
  const headers: Record<string, string> = {};
  for (const [k, t] of [...d.targetHeaders, ...spec.headers])
    headers[k.toLowerCase()] = renderTemplate(t, ctx);

  const checks: ProtocolOutcome["checks"] = [];
  let bytesIn = 0;
  let bytesOut = 0;
  let sent = 0;
  let received = 0;
  const out = (extra: Partial<ProtocolOutcome>): ProtocolOutcome => ({
    checks,
    bytesIn,
    bytesOut,
    messagesSent: sent,
    messagesReceived: received,
    ...extra,
  });

  // O evento "error" do WebSocket não diz a causa: observa o handshake no dispatcher
  // (erro de rede → tipo certo; resposta ≠ 101 → status HTTP).
  let netError: Error | undefined;
  let handshakeStatus: number | undefined;
  const dispatcher = d.dispatcher.compose(
    (dispatch) => (opts, handler) =>
      dispatch(
        opts,
        observe(
          handler,
          (e) => (netError = e),
          (st) => (handshakeStatus = st),
        ),
      ),
  );

  const t0 = performance.now();
  const ws = new WebSocket(url, {
    protocols: spec.subprotocols.length ? spec.subprotocols : undefined,
    headers,
    dispatcher,
  });
  ws.binaryType = "arraybuffer";
  const queue: Msg[] = [];
  let waiter: ((m: Msg | undefined) => void) | null = null;
  let closed: { code: number; reason: string } | null = null;

  ws.addEventListener("message", (ev) => {
    const data = ev.data as string | ArrayBuffer;
    const m: Msg =
      typeof data === "string"
        ? { data: Buffer.from(data), binary: false }
        : { data: Buffer.from(data), binary: true };
    bytesIn += m.data.length;
    received++;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(m);
    } else queue.push(m);
  });
  ws.addEventListener("close", (ev) => {
    closed = { code: ev.code, reason: ev.reason };
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(undefined);
    }
  });
  ws.addEventListener("error", () => {}); // a causa vem de netError/handshakeStatus/close
  const onHard = () => ws.close();
  d.hardSignal.addEventListener("abort", onHard, { once: true });

  try {
    const opened = await new Promise<boolean>((resolve) => {
      const to = setTimeout(() => resolve(false), d.timeoutMs);
      ws.addEventListener("open", () => (clearTimeout(to), resolve(true)), { once: true });
      ws.addEventListener("close", () => (clearTimeout(to), resolve(false)), { once: true });
    });
    if (d.hardSignal.aborted) return out({ error: "aborted", message: "execução interrompida" });
    if (!opened) {
      const fail = (error: ProtocolOutcome["error"], msg: string) =>
        out({ statusKey: "ws:falha", error, message: `handshake: ${msg}` });
      if (netError) return fail(classifyError(netError), netError.message);
      if (handshakeStatus !== undefined && handshakeStatus !== 101) {
        return fail("ws_error", `servidor respondeu HTTP ${handshakeStatus} (esperado 101)`);
      }
      if (!closed) return fail("timeout", `timeout de ${d.timeoutMs}ms`);
      return fail("ws_error", `conexão fechada (código ${(closed as { code: number }).code})`);
    }
    d.onConnect(performance.now() - t0);

    let lastSend: number | null = null;
    for (const a of spec.script) {
      if (a.kind === "send") {
        const payload = outgoing(a, ctx);
        ws.send(payload);
        bytesOut += typeof payload === "string" ? Buffer.byteLength(payload) : payload.length;
        sent++;
        lastSend = performance.now();
      } else if (a.kind === "sleep") {
        await d.sleep(a.ms);
      } else {
        const msg =
          queue.shift() ??
          (closed
            ? undefined
            : await new Promise<Msg | undefined | "timeout">((resolve) => {
                const to = setTimeout(() => {
                  waiter = null;
                  resolve("timeout");
                }, a.timeoutMs);
                waiter = (m) => {
                  clearTimeout(to);
                  resolve(m);
                };
              }));
        if (d.hardSignal.aborted)
          return out({ error: "aborted", message: "execução interrompida" });
        if (msg === "timeout") {
          checks.push({ label: `msg ${a.index}: recebida`, ok: false });
          return out({
            statusKey: "ws:101",
            error: "timeout",
            message: `msg ${a.index}: nenhuma mensagem em ${a.timeoutMs}ms`,
          });
        }
        if (msg === undefined) {
          checks.push({ label: `msg ${a.index}: recebida`, ok: false });
          const c = closed as { code: number } | null;
          return out({
            statusKey: "ws:101",
            error: "ws_error",
            message: `msg ${a.index}: conexão fechada pelo servidor (código ${c?.code ?? "?"})`,
          });
        }
        if (lastSend !== null) {
          d.onRtt(performance.now() - lastSend);
          lastSend = null;
        }
        const frame = frameChecks(a.expect, msg);
        const pseudo: Step = { ...step, expect: a.expect, extract: a.extract, needsBody: true };
        const ev = evaluateResponse(pseudo, { status: 200, headers: {}, body: msg.data }, 0, ctx);
        for (const c of [...frame, ...ev.checks]) {
          checks.push({ label: `msg ${a.index}: ${c.label}`, ok: c.ok });
        }
        const failed = frame.find((c) => !c.ok);
        if (failed || ev.error)
          return out({
            statusKey: "ws:101",
            error: failed ? "check_failed" : ev.error,
            message: `msg ${a.index}: ${failed ? failed.why : ev.message}`,
          });
      }
    }
    return out({ statusKey: "ws:101" });
  } finally {
    d.hardSignal.removeEventListener("abort", onHard);
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000);
  }
}

/** Repassa o handler do fetch, anotando erro de rede e status da resposta do handshake. */
function observe<H extends object>(
  handler: H,
  onError: (e: Error) => void,
  onStatus: (s: number) => void,
): H {
  return new Proxy(handler, {
    get(t, p) {
      const v = Reflect.get(t, p, t) as unknown;
      if (typeof v !== "function") return v;
      if (p === "onResponseError" || p === "onError") {
        return (...args: unknown[]) => {
          onError(args[args.length - 1] as Error);
          return (v as (...a: unknown[]) => unknown).apply(t, args);
        };
      }
      if (p === "onResponseStart" || p === "onHeaders") {
        return (...args: unknown[]) => {
          const st = args.find((a) => typeof a === "number");
          if (typeof st === "number") onStatus(st);
          return (v as (...a: unknown[]) => unknown).apply(t, args);
        };
      }
      if (p === "onRequestUpgrade" || p === "onUpgrade") {
        return (...args: unknown[]) => {
          onStatus(101);
          return (v as (...a: unknown[]) => unknown).apply(t, args);
        };
      }
      return (v as (...a: unknown[]) => unknown).bind(t);
    },
  });
}

interface Msg {
  data: Buffer;
  binary: boolean;
}

/** Conteúdo de um send: texto (send/sendJson) ou bytes (sendBinary). */
function outgoing(a: Extract<WsAction, { kind: "send" }>, ctx: RenderContext): string | Buffer {
  if (a.binary) {
    return a.binary.encoding === "file"
      ? a.binary.data
      : decodeBinary(a.binary.encoding, renderTemplate(a.binary.template, ctx));
  }
  return a.text ? renderTemplate(a.text, ctx) : JSON.stringify(renderJson(a.json!, ctx));
}

/** Checagens do quadro: tipo (text/binary), tamanho em bytes e conteúdo em hex. */
function frameChecks(ex: ExpectSpec, m: Msg): { label: string; ok: boolean; why: string }[] {
  const out: { label: string; ok: boolean; why: string }[] = [];
  const type = m.binary ? "binary" : "text";
  if (ex.messageType) {
    out.push({
      label: `tipo = ${ex.messageType}`,
      ok: type === ex.messageType,
      why: `mensagem ${type === "binary" ? "binária" : "de texto"} (esperado ${ex.messageType})`,
    });
  }
  if (ex.size) {
    out.push({
      label: `tamanho ${ex.size.label}`,
      ok: ex.size.test(true, m.data.length),
      why: `tamanho ${ex.size.label} (recebido: ${m.data.length} bytes)`,
    });
  }
  if (ex.hex) {
    const hex = m.data.toString("hex");
    out.push({
      label: `hex ${ex.hex.label}`,
      ok: ex.hex.test(true, hex),
      why: `hex ${ex.hex.label} (recebido: ${hex.length > 64 ? `${hex.slice(0, 64)}…` : hex})`,
    });
  }
  return out;
}
