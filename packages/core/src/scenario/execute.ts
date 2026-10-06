import { randomBytes } from "node:crypto";
import type { ErrorType } from "../metrics.js";
import { evalJsonPath } from "./jsonpath.js";
import { createRng } from "./random.js";
import {
  TemplateError,
  renderJson,
  renderTemplate,
  renderValue,
  type RenderContext,
} from "./template.js";
import type { Flow, Scenario, Step } from "./types.js";

/** Respostas maiores que isso não são guardadas para checagens/extração. */
export const MAX_BODY_BYTES = 10 * 1024 * 1024;

/** Fronteira multipart estável por processo. */
export const MULTIPART_BOUNDARY = `----lt-${randomBytes(12).toString("hex")}`;

export interface Iteration {
  index: number;
  flowIndex: number;
  flow: Flow;
  ctx: RenderContext;
}

/**
 * Prepara a iteração k: escolhe o fluxo (por peso), a linha de cada CSV e avalia `variables`.
 * Tudo deriva de (seed, k), então é reprodutível e independente da ordem de chegada das respostas.
 */
export function createIteration(sc: Scenario, index: number, placeholders = false): Iteration {
  const rng = createRng(sc.seed, index);
  const ctx: RenderContext = { rng, vars: new Map(), iteration: index, placeholders };

  let flowIndex = 0;
  if (sc.flows.length > 1) {
    const total = sc.flows.reduce((s, f) => s + f.weight, 0);
    let x = rng() * total;
    flowIndex = sc.flows.findIndex((f) => (x -= f.weight) < 0);
    if (flowIndex < 0) flowIndex = sc.flows.length - 1;
  }

  for (const d of sc.data) {
    const row =
      d.order === "random"
        ? d.rows[Math.floor(rng() * d.rows.length)]!
        : d.rows[index % d.rows.length]!;
    if (d.name) ctx.vars.set(d.name, row);
    else for (const [k, v] of Object.entries(row)) ctx.vars.set(k, v);
  }
  for (const [k, t] of sc.variables) ctx.vars.set(k, renderValue(t, ctx));
  return { index, flowIndex, flow: sc.flows[flowIndex]!, ctx };
}

export interface BuiltRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string | Buffer;
  bytesOut: number;
}

export function buildRequest(
  sc: Scenario,
  step: Step,
  ctx: RenderContext,
  basePath: string,
  host: string,
): BuiltRequest {
  const rq = step.request;
  if (!rq) throw new Error(`etapa "${step.name}" não é HTTP`);
  let p = renderTemplate(rq.path, ctx);
  if (rq.query.length) {
    const qs = new URLSearchParams(
      rq.query.map(([k, t]): [string, string] => [k, renderTemplate(t, ctx)]),
    ).toString();
    p += (p.includes("?") ? "&" : "?") + qs;
  }
  const fullPath = basePath + p;

  // headers: alvo + etapa, sem diferenciar maiúsculas (a etapa prevalece)
  const merged = new Map<string, [string, string]>();
  for (const [k, t] of [...sc.target.headers, ...rq.headers]) {
    merged.set(k.toLowerCase(), [k, renderTemplate(t, ctx)]);
  }

  let body: string | Buffer | undefined;
  let contentType: string | undefined;
  const b = rq.body;
  if (b) {
    switch (b.kind) {
      case "json":
        body = JSON.stringify(renderJson(b.value, ctx));
        contentType = b.contentType;
        break;
      case "text":
        body = renderTemplate(b.template, ctx);
        contentType = b.contentType;
        break;
      case "form":
        body = new URLSearchParams(
          b.fields.map(([k, t]): [string, string] => [k, renderTemplate(t, ctx)]),
        ).toString();
        contentType = b.contentType;
        break;
      case "file":
        body = b.data;
        contentType = b.contentType;
        break;
      case "multipart": {
        const chunks: Buffer[] = [];
        for (const part of b.parts) {
          let head = `--${MULTIPART_BOUNDARY}\r\nContent-Disposition: form-data; name="${part.name}"`;
          if ("file" in part) {
            head += `; filename="${part.filename}"\r\nContent-Type: ${part.contentType}\r\n\r\n`;
            chunks.push(Buffer.from(head), part.file, Buffer.from("\r\n"));
          } else {
            chunks.push(Buffer.from(`${head}\r\n\r\n${renderTemplate(part.value, ctx)}\r\n`));
          }
        }
        chunks.push(Buffer.from(`--${MULTIPART_BOUNDARY}--\r\n`));
        body = Buffer.concat(chunks);
        contentType = `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`;
        break;
      }
    }
  }
  if (contentType && !merged.has("content-type"))
    merged.set("content-type", ["content-type", contentType]);

  const headers = Object.fromEntries(merged.values());
  let bytesOut = `${rq.method} ${fullPath} HTTP/1.1\r\nhost: ${host}\r\n`.length + 2;
  for (const [k, v] of Object.entries(headers)) bytesOut += k.length + v.length + 4;
  if (body) bytesOut += typeof body === "string" ? Buffer.byteLength(body) : body.length;
  return { method: rq.method, path: fullPath, headers, body, bytesOut };
}

export interface ResponseData {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  /** Presente quando step.needsBody. */
  body?: Buffer;
  truncated?: boolean;
}

export interface Evaluation {
  checks: { label: string; ok: boolean }[];
  error?: ErrorType;
  message?: string;
}

const headerText = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(", ") : v);

/** Aplica expect + extract. Valores extraídos vão para ctx.vars (para as etapas seguintes). */
export function evaluateResponse(
  step: Step,
  res: ResponseData,
  latencyMs: number,
  ctx: RenderContext,
): Evaluation {
  const checks: Evaluation["checks"] = [];
  const ex = step.expect;
  let error: ErrorType | undefined;
  let message: string | undefined;
  const fail = (type: ErrorType, msg: string) => {
    if (!error) {
      error = type;
      message = msg;
    }
  };

  const statusOk = ex.status ? ex.status.includes(res.status) : res.status < 400;
  if (ex.status) {
    checks.push({
      label: `status ${ex.status.length > 1 ? `∈ {${ex.status.join(", ")}}` : `= ${ex.status[0]}`}`,
      ok: statusOk,
    });
  }
  if (!statusOk) {
    const type = res.status >= 500 ? "http_5xx" : res.status >= 400 ? "http_4xx" : "check_failed";
    fail(type, `status ${res.status}${ex.status ? ` (esperado ${ex.status.join(" ou ")})` : ""}`);
    return { checks, error, message }; // demais checagens não fazem sentido numa resposta de erro
  }

  if (ex.maxDurationMs !== undefined) {
    const ok = latencyMs <= ex.maxDurationMs;
    checks.push({ label: `tempo ≤ ${ex.maxDurationMs}ms`, ok });
    if (!ok) fail("check_failed", `tempo ${latencyMs.toFixed(0)}ms > ${ex.maxDurationMs}ms`);
  }

  for (const h of ex.headers) {
    const v = headerText(res.headers[h.name]);
    const ok = h.matcher.test(v !== undefined, v);
    checks.push({ label: `header ${h.name} ${h.matcher.label}`, ok });
    if (!ok)
      fail("check_failed", `header ${h.name} ${h.matcher.label} (recebido: ${v ?? "ausente"})`);
  }

  let text: string | undefined;
  let json: unknown;
  let jsonState: "pending" | "ok" | "invalid" = "pending";
  const getText = () => (text ??= res.body ? res.body.toString("utf8") : "");
  const getJson = () => {
    if (jsonState === "pending") {
      try {
        json = JSON.parse(getText());
        jsonState = "ok";
      } catch {
        jsonState = "invalid";
      }
    }
    return jsonState === "ok";
  };
  const bodyProblem = res.truncated
    ? `corpo maior que ${MAX_BODY_BYTES / 1024 / 1024}MB`
    : undefined;

  for (const s of ex.bodyContains) {
    const ok = !bodyProblem && getText().includes(s);
    checks.push({ label: `corpo contém ${JSON.stringify(s)}`, ok });
    if (!ok) fail("check_failed", bodyProblem ?? `corpo não contém ${JSON.stringify(s)}`);
  }
  if (ex.bodyMatches) {
    const ok = !bodyProblem && ex.bodyMatches.test(getText());
    checks.push({ label: `corpo ~ /${ex.bodyMatches.source}/`, ok });
    if (!ok) fail("check_failed", bodyProblem ?? `corpo não casa com /${ex.bodyMatches.source}/`);
  }
  for (const jp of ex.jsonPath) {
    let ok = false;
    let got = "corpo não é JSON";
    if (!bodyProblem && getJson()) {
      const r = evalJsonPath(jp.segments, json);
      ok = jp.matcher.test(r.found, r.value);
      got = r.found ? JSON.stringify(r.value) : "ausente";
    }
    checks.push({ label: `${jp.path} ${jp.matcher.label}`, ok });
    if (!ok)
      fail(
        "check_failed",
        `${jp.path} ${jp.matcher.label} (recebido: ${bodyProblem ?? truncate(got)})`,
      );
  }

  for (const [name, x] of step.extract) {
    let found = false;
    let value: unknown;
    if (x.kind === "header") {
      value = headerText(res.headers[x.name]);
      found = value !== undefined;
    } else if (!bodyProblem && x.kind === "jsonPath" && getJson()) {
      const r = evalJsonPath(x.segments, json);
      found = r.found;
      value = r.value;
    } else if (!bodyProblem && x.kind === "regex") {
      const m = x.re.exec(getText());
      found = !!m && m[x.group] !== undefined;
      value = m?.[x.group];
    }
    if (!found && x.default !== undefined) {
      found = true;
      value = x.default;
    }
    checks.push({ label: `extrair ${name}`, ok: found });
    if (found) ctx.vars.set(name, value);
    else {
      const how =
        x.kind === "header" ? `header ${x.name}` : x.kind === "regex" ? `/${x.re.source}/` : x.path;
      fail("check_failed", `não foi possível extrair ${name} (${how})`);
    }
  }
  return { checks, error, message };
}

export function thinkTimeMs(step: Step, ctx: RenderContext): number {
  const { minMs, maxMs } = step.think;
  return maxMs > minMs ? minMs + ctx.rng() * (maxMs - minMs) : minMs;
}

export function templateErrorMessage(e: unknown): string {
  return e instanceof TemplateError
    ? e.message
    : `erro ao montar a requisição: ${(e as Error).message}`;
}

function truncate(s: string, n = 120): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
