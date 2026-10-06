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

const RESERVED = new Set([
  "host",
  "content-type",
  "content-length",
  "connection",
  "te",
  "user-agent",
]);
const codeName = (c: number) => GRPC_CODES[c] ?? String(c);

/**
 * Chamada gRPC unária. Status fora de expect.grpcStatus (padrão: OK) é falha; DEADLINE_EXCEEDED
 * conta como timeout. A resposta vira JSON para as mesmas checagens/extrações por JSONPath.
 */
export function runGrpcStep(
  step: Step,
  ctx: RenderContext,
  d: {
    client: grpc.Client;
    timeoutMs: number;
    targetHeaders: [string, Template][];
    hardSignal: AbortSignal;
  },
): Promise<ProtocolOutcome> {
  const spec = step.grpc!;
  const md = new grpc.Metadata();
  let mdBytes = 0;
  for (const [k, t] of [...d.targetHeaders, ...spec.metadata]) {
    const key = k.toLowerCase();
    if (RESERVED.has(key)) continue;
    const v = renderTemplate(t, ctx);
    md.set(key, v);
    mdBytes += key.length + v.length;
  }
  let payload: Buffer;
  try {
    payload = spec.requestSerialize(renderJson(spec.message, ctx));
  } catch (e) {
    return Promise.resolve({
      error: "template_error",
      message: `mensagem inválida para ${spec.service}/${spec.method}: ${(e as Error).message}`,
      checks: [],
      bytesIn: 0,
      bytesOut: 0,
    });
  }
  const bytesOut = payload.length + mdBytes;
  const expected = step.expect.grpcStatus ?? [0];

  return new Promise((resolve) => {
    let aborted = false;
    const call = d.client.makeUnaryRequest(
      spec.path,
      (b: Buffer) => b, // já serializado acima (para medir bytes e validar a mensagem)
      spec.responseDeserialize,
      payload,
      md,
      { deadline: Date.now() + d.timeoutMs },
      (err, resp) => {
        d.hardSignal.removeEventListener("abort", onHard);
        if (aborted)
          return resolve({
            error: "aborted",
            message: "execução interrompida",
            checks: [],
            bytesIn: 0,
            bytesOut,
          });
        const code = err ? (err.code ?? 2) : 0;
        const statusKey = `grpc:${codeName(code)}`;
        const checks: ProtocolOutcome["checks"] = [];
        const statusOk = expected.includes(code);
        if (step.expect.grpcStatus) {
          checks.push({
            label: `grpc ${expected.length > 1 ? `∈ {${expected.map(codeName).join(", ")}}` : `= ${codeName(expected[0]!)}`}`,
            ok: statusOk,
          });
        }
        if (!statusOk) {
          const details = err?.details ? `: ${err.details}` : "";
          const type: ErrorType =
            code === grpc.status.DEADLINE_EXCEEDED
              ? "timeout"
              : code === grpc.status.UNAVAILABLE && /ECONNREFUSED|connect/i.test(err?.details ?? "")
                ? "connection_refused"
                : "grpc_status";
          return resolve({
            statusKey,
            error: type,
            message: `status ${codeName(code)}${details}${step.expect.grpcStatus ? ` (esperado ${expected.map(codeName).join(" ou ")})` : ""}`,
            checks,
            bytesIn: 0,
            bytesOut,
          });
        }
        if (err || resp === undefined) return resolve({ statusKey, checks, bytesIn: 0, bytesOut });
        const json = Buffer.from(JSON.stringify(resp));
        const pseudo: Step = {
          ...step,
          expect: { ...step.expect, status: undefined, maxDurationMs: undefined },
        };
        const ev = evaluateResponse(pseudo, { status: 200, headers: {}, body: json }, 0, ctx);
        resolve({
          statusKey,
          error: ev.error,
          message: ev.message,
          checks: [...checks, ...ev.checks],
          bytesIn: spec.responseSerialize(resp).length,
          bytesOut,
        });
      },
    );
    const onHard = () => {
      aborted = true;
      call.cancel();
    };
    d.hardSignal.addEventListener("abort", onHard, { once: true });
  });
}
