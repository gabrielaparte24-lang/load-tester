import path from "node:path";
import { stringify } from "yaml";
import { maskHeaders, maskText } from "../secrets.js";
import { buildRequest, createIteration, templateErrorMessage } from "./execute.js";
import { renderJson, renderTemplate, type RenderContext, type Template } from "./template.js";
import { decodeBinary } from "./binary.js";
import type { BinarySource, Scenario, StreamAction } from "./types.js";

export interface PreviewRequest {
  iteration: number;
  flow: string;
  step: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  error?: string;
}

function describeBinary(b: BinarySource, ctx: RenderContext): string {
  let data = b.encoding === "file" ? b.data : undefined;
  if (b.encoding !== "file") {
    const text = renderTemplate(b.template, ctx);
    // valor que só existe após um extract aparece como <nome>: mostra o texto
    if (/<[^>]+>/.test(text)) return `${b.encoding} ${text}`;
    data = decodeBinary(b.encoding, text);
  }
  data = data!;
  const hex = data.subarray(0, 32).toString("hex");
  return `${data.length} bytes: ${hex}${data.length > 32 ? "…" : ""}`;
}

/** Roteiro de mensagens (WebSocket ou stream gRPC), uma ação por linha. */
function describeScript(script: StreamAction[], ctx: RenderContext): string {
  return script
    .map((a) =>
      a.kind === "send"
        ? a.binary
          ? `sendBinary ${describeBinary(a.binary, ctx)}`
          : `send ${a.text ? renderTemplate(a.text, ctx) : JSON.stringify(renderJson(a.json!, ctx))}`
        : a.kind === "sleep"
          ? `sleep ${a.ms}ms`
          : a.kind === "end"
            ? "end"
            : `expect msg ${a.index} (timeout ${a.timeoutMs}ms)`,
    )
    .join("\n");
}

const clip = (text: string) => (text.length > 500 ? `${text.slice(0, 500)}…` : text);

function renderHeaders(list: [string, Template][], ctx: RenderContext): Record<string, string> {
  const h: Record<string, string> = {};
  for (const [k, t] of list) h[k.toLowerCase()] = renderTemplate(t, ctx);
  return h;
}

/**
 * Monta (sem enviar) as requisições das primeiras N iterações, para conferir templates e dados.
 * Valores que só existem após uma resposta (extract) aparecem como <nome>. Segredos são mascarados.
 */
export function previewIterations(sc: Scenario, n: number): PreviewRequest[] {
  const base = new URL(sc.target.baseUrl);
  const basePath = base.pathname.replace(/\/+$/, "");
  const out: PreviewRequest[] = [];
  for (let i = 0; i < n; i++) {
    let it;
    try {
      it = createIteration(sc, i, true);
    } catch (e) {
      out.push({
        iteration: i,
        flow: "",
        step: "variables",
        method: "",
        url: "",
        headers: {},
        error: templateErrorMessage(e),
      });
      continue;
    }
    for (const step of it.flow.steps) {
      const entry: PreviewRequest = {
        iteration: i,
        flow: it.flow.name,
        step: step.name,
        method: step.method,
        url: "",
        headers: {},
      };
      try {
        if (step.ws) {
          const scheme = base.protocol === "https:" ? "wss:" : "ws:";
          entry.url = maskText(
            `${scheme}//${base.host}${basePath}${renderTemplate(step.ws.path, it.ctx)}`,
            sc.secrets,
          );
          entry.headers = maskHeaders(
            renderHeaders([...sc.target.headers, ...step.ws.headers], it.ctx),
            sc.secrets,
          );
          entry.body = maskText(clip(describeScript(step.ws.script, it.ctx)), sc.secrets);
          out.push(entry);
          continue;
        }
        if (step.grpc) {
          entry.url = maskText(`grpc://${base.host}${step.grpc.path}`, sc.secrets);
          entry.headers = maskHeaders(
            renderHeaders([...sc.target.headers, ...step.grpc.metadata], it.ctx),
            sc.secrets,
          );
          const g = step.grpc;
          const lines =
            g.mode === "unary" || g.mode === "server"
              ? [
                  `${g.mode === "server" ? "message " : ""}${JSON.stringify(renderJson(g.message, it.ctx))}`,
                ]
              : [];
          if (g.mode !== "unary") {
            lines.unshift(`(${g.mode} streaming)`);
            if (g.script.length) lines.push(describeScript(g.script, it.ctx));
          }
          entry.body = maskText(clip(lines.join("\n")), sc.secrets);
          out.push(entry);
          continue;
        }
        const req = buildRequest(sc, step, it.ctx, basePath, base.host);
        entry.url = maskText(`${base.origin}${req.path}`, sc.secrets);
        entry.headers = maskHeaders(req.headers, sc.secrets);
        if (req.body !== undefined) {
          const text = typeof req.body === "string" ? req.body : `<${req.body.length} bytes>`;
          entry.body = maskText(clip(text), sc.secrets);
        }
      } catch (e) {
        entry.error = templateErrorMessage(e);
      }
      out.push(entry);
    }
  }
  return out;
}

/** Caminho do JSON Schema relativo ao arquivo gerado (para autocompletar no VS Code / yaml-language-server). */
export function schemaRef(outFile: string | undefined, root: string): string {
  const schema = path.join(root, "schema", "scenario.schema.json");
  const from = outFile ? path.dirname(path.resolve(outFile)) : process.cwd();
  return path.relative(from, schema).split(path.sep).join("/");
}

/** Serializa um cenário (objeto simples) em YAML com cabeçalho de comentários. */
export function scenarioToYaml(obj: unknown, header: string[], schemaPath?: string): string {
  const lines = [
    ...(schemaPath ? [`# yaml-language-server: $schema=${schemaPath}`] : []),
    ...header.map((h) => (h ? `# ${h}` : "#")),
    "",
  ];
  return lines.join("\n") + stringify(obj, { lineWidth: 0, flowCollectionPadding: true });
}
