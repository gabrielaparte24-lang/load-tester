import path from "node:path";
import { stringify } from "yaml";
import { maskHeaders, maskText } from "../secrets.js";
import { buildRequest, createIteration, templateErrorMessage } from "./execute.js";
import type { Scenario } from "./types.js";

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
        method: step.request.method,
        url: "",
        headers: {},
      };
      try {
        const req = buildRequest(sc, step, it.ctx, basePath, base.host);
        entry.url = maskText(`${base.origin}${req.path}`, sc.secrets);
        entry.headers = maskHeaders(req.headers, sc.secrets);
        if (req.body !== undefined) {
          const text = typeof req.body === "string" ? req.body : `<${req.body.length} bytes>`;
          entry.body = maskText(text.length > 500 ? `${text.slice(0, 500)}…` : text, sc.secrets);
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
