import { parse } from "yaml";
import { ConfigError } from "../errors.js";
import type { ImportResult } from "./curl.js";

/**
 * Gera um cenário a partir de uma especificação OpenAPI 3.x ou Swagger 2.0.
 * Por segurança, inclui apenas métodos sem efeito colateral (GET/HEAD); --all-methods inclui os demais.
 * Cada operação vira um fluxo de peso 1 (a carga se divide igualmente entre os endpoints).
 */
export interface OpenApiOptions {
  name?: string;
  baseUrl?: string;
  allMethods?: boolean;
}

type Obj = Record<string, unknown>;
const SAFE = ["get", "head"];
const METHODS = ["get", "head", "post", "put", "patch", "delete", "options"];

export function importOpenApi(text: string, opts: OpenApiOptions = {}): ImportResult {
  let spec: Obj;
  try {
    spec = parse(text) as Obj;
  } catch (e) {
    throw new ConfigError(`especificação inválida: ${(e as Error).message.split("\n")[0]}`);
  }
  if (!spec || typeof spec !== "object") throw new ConfigError("especificação vazia");
  const isV3 = typeof spec.openapi === "string" && spec.openapi.startsWith("3");
  const isV2 = spec.swagger === "2.0";
  if (!isV3 && !isV2)
    throw new ConfigError('não é OpenAPI 3.x nem Swagger 2.0 (campo "openapi"/"swagger")');

  const notes: string[] = [];
  const env = new Set<string>();

  const resolve = (v: unknown, depth = 0): Obj => {
    let o = v as Obj;
    while (o && typeof o.$ref === "string" && depth++ < 20) {
      const ref = o.$ref as string;
      if (!ref.startsWith("#/")) throw new ConfigError(`$ref externo não suportado: ${ref}`);
      o = ref
        .slice(2)
        .split("/")
        .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"))
        .reduce<unknown>((acc, k) => (acc as Obj)?.[k], spec) as Obj;
    }
    return o ?? {};
  };

  // URL base
  let baseUrl = opts.baseUrl;
  if (!baseUrl) {
    if (isV3) {
      const server = resolve((spec.servers as Obj[] | undefined)?.[0]);
      let url = server.url as string | undefined;
      for (const [k, v] of Object.entries((server.variables as Obj) ?? {})) {
        url = url?.replace(`{${k}}`, String((v as Obj).default ?? ""));
      }
      baseUrl = url;
    } else if (spec.host) {
      const scheme = (spec.schemes as string[] | undefined)?.[0] ?? "https";
      baseUrl = `${scheme}://${spec.host}${(spec.basePath as string) ?? ""}`;
    }
  }
  if (!baseUrl || !/^https?:\/\//.test(baseUrl)) {
    notes.push(
      `URL base ${baseUrl ? `relativa ("${baseUrl}")` : "ausente"} na especificação; ajuste target.baseUrl ou use --base-url`,
    );
    baseUrl = `http://localhost:8080${baseUrl && baseUrl.startsWith("/") ? baseUrl : ""}`;
  }

  // exemplo de valor a partir do schema
  const sample = (schemaIn: unknown, depth = 0): unknown => {
    const s = resolve(schemaIn);
    if (s.example !== undefined) return s.example;
    if (s.default !== undefined) return s.default;
    if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
    const all = (s.allOf as unknown[] | undefined)?.map((x) => resolve(x));
    if (all?.length) return Object.assign({}, ...all.map((x) => sample(x, depth)));
    const alt = ((s.oneOf ?? s.anyOf) as unknown[] | undefined)?.[0];
    if (alt) return sample(alt, depth);
    const type = Array.isArray(s.type)
      ? s.type[0]
      : (s.type ?? (s.properties ? "object" : "string"));
    switch (type) {
      case "integer":
        return `\${randInt(${(s.minimum as number) ?? 1}, ${(s.maximum as number) ?? 100})}`;
      case "number":
        return `\${randFloat(${(s.minimum as number) ?? 1}, ${(s.maximum as number) ?? 100})}`;
      case "boolean":
        return true;
      case "array":
        return depth > 3 ? [] : [sample(s.items, depth + 1)];
      case "object": {
        if (depth > 3) return {};
        const out: Obj = {};
        for (const [k, v] of Object.entries((s.properties as Obj) ?? {}))
          out[k] = sample(v, depth + 1);
        return out;
      }
      default:
        switch (s.format) {
          case "uuid":
            return "${uuid()}";
          case "email":
            return "usuario${randInt(1, 100000)}@exemplo.test";
          case "date-time":
            return "${isoNow()}";
          case "date":
            return "2026-01-01";
          default:
            return `exemplo-\${randString(6)}`;
        }
    }
  };
  const paramValue = (p: Obj) => {
    const v =
      p.example ??
      (p.schema ? sample(p.schema) : sample({ type: p.type, format: p.format, enum: p.enum }));
    return typeof v === "object" ? JSON.stringify(v) : v;
  };

  // segurança: Bearer/API key viram ${env.*}
  const securityHeaders: Record<string, string> = {};
  const schemes = isV3
    ? ((spec.components as Obj | undefined)?.securitySchemes as Obj)
    : (spec.securityDefinitions as Obj);
  const used = new Set(((spec.security as Obj[] | undefined) ?? []).flatMap((s) => Object.keys(s)));
  for (const [name, raw] of Object.entries(schemes ?? {})) {
    if (used.size && !used.has(name)) continue;
    const s = resolve(raw);
    if (
      (s.type === "http" && s.scheme === "bearer") ||
      s.type === "oauth2" ||
      s.type === "openIdConnect"
    ) {
      securityHeaders.Authorization = "Bearer ${env.LT_API_TOKEN}";
      env.add("LT_API_TOKEN");
    } else if (s.type === "http" && s.scheme === "basic") {
      securityHeaders.Authorization = "Basic ${base64(env.LT_BASIC_AUTH)}";
      env.add("LT_BASIC_AUTH");
    } else if (s.type === "apiKey" && s.in === "header") {
      securityHeaders[s.name as string] = "${env.LT_API_KEY}";
      env.add("LT_API_KEY");
    }
  }

  const flows: Obj[] = [];
  const skipped: string[] = [];
  for (const [p, rawItem] of Object.entries((spec.paths as Obj) ?? {})) {
    const item = resolve(rawItem);
    const shared = ((item.parameters as unknown[]) ?? []).map((x) => resolve(x));
    for (const method of METHODS) {
      const op = item[method] as Obj | undefined;
      if (!op) continue;
      if (!opts.allMethods && !SAFE.includes(method)) {
        skipped.push(`${method.toUpperCase()} ${p}`);
        continue;
      }
      const params = [...shared, ...((op.parameters as unknown[]) ?? []).map((x) => resolve(x))];
      let path = p;
      const query: Obj = {};
      const headers: Obj = {};
      let json: unknown;
      for (const prm of params) {
        if (prm.in === "path") path = path.replace(`{${prm.name}}`, String(paramValue(prm)));
        else if (prm.in === "query" && prm.required) query[prm.name as string] = paramValue(prm);
        else if (prm.in === "header" && prm.required) headers[prm.name as string] = paramValue(prm);
        else if (prm.in === "body") json = sample(prm.schema);
      }
      const content = (resolve(op.requestBody).content as Obj | undefined) ?? {};
      const jsonMedia = Object.entries(content).find(([k]) => /json/.test(k))?.[1] as
        Obj | undefined;
      if (jsonMedia) json = jsonMedia.example ?? sample(jsonMedia.schema);

      const codes = Object.keys((op.responses as Obj) ?? {}).filter((c) => /^2\d\d$/.test(c));
      const request: Obj = { method: method.toUpperCase(), path };
      if (Object.keys(query).length) request.query = query;
      if (Object.keys(headers).length) request.headers = headers;
      if (json !== undefined) request.json = json;
      const step: Obj = {
        name: (op.operationId as string) ?? `${method.toUpperCase()} ${p}`,
        request,
      };
      if (codes.length)
        step.expect = { status: codes.length === 1 ? Number(codes[0]) : codes.map(Number) };
      flows.push({ name: step.name, weight: 1, steps: [step] });
    }
  }
  if (skipped.length) {
    notes.push(
      `${skipped.length} operação(ões) que alteram dados foram omitidas (use --all-methods): ${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? "…" : ""}`,
    );
  }
  if (!flows.length) throw new ConfigError("nenhuma operação encontrada para gerar o cenário");
  if (env.size)
    notes.push(`autenticação via variáveis de ambiente; defina no .env: ${[...env].join(", ")}`);
  notes.push(
    "valores de exemplo foram gerados a partir dos schemas; revise caminhos e corpos antes de rodar",
  );

  const info = (spec.info as Obj) ?? {};
  const target: Obj = { baseUrl: baseUrl.replace(/\/+$/, ""), timeoutMs: 10_000 };
  if (Object.keys(securityHeaders).length) target.headers = securityHeaders;
  return {
    scenario: {
      name: opts.name ?? (info.title as string) ?? "openapi",
      ...(info.description ? { description: String(info.description).split("\n")[0] } : {}),
      target,
      load: { model: "open", stages: [{ duration: "30s", rps: 5 }] },
      thresholds: ["p95 < 500ms", "errorRate < 1%"],
      ...(flows.length === 1 ? { flow: flows[0]!.steps } : { flows }),
    },
    env: [...env],
    notes,
  };
}
