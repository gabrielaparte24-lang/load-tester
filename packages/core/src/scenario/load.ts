import fs from "node:fs";
import path from "node:path";
import { randomInt } from "node:crypto";
import { Ajv, type ErrorObject } from "ajv";
import { LineCounter, isNode, parseDocument, type Document } from "yaml";
import { parseDuration } from "../duration.js";
import { ConfigError } from "../errors.js";
import type { RateStage } from "../schedule.js";
import { parseThreshold } from "../thresholds.js";
import { csvToTable } from "./csv.js";
import { parseJsonPath } from "./jsonpath.js";
import { parseMatcher } from "./matchers.js";
import { GRPC_CODES, scenarioSchema } from "./schema.js";
import * as protoLoader from "@grpc/proto-loader";
import {
  BUILTIN_VARS,
  compileJson,
  compileTemplate,
  referencedVars,
  type CompileOptions,
  type Template,
} from "./template.js";
import type {
  BodySpec,
  Dataset,
  ExpectSpec,
  Extractor,
  Flow,
  HttpMethod,
  RequestSpec,
  Scenario,
  Step,
  VuStage,
  WsAction,
  WsSpec,
  GrpcSpec,
} from "./types.js";

export interface ScenarioIssue {
  path: string;
  message: string;
  line?: number;
  col?: number;
}

export class ScenarioError extends ConfigError {
  constructor(
    readonly issues: ScenarioIssue[],
    readonly file?: string,
  ) {
    const where = file ? `${file}` : "cenário";
    super(
      `${where}: ${issues.length} problema(s)\n` +
        issues
          .map(
            (i) =>
              `  - ${i.line ? `linha ${i.line}, coluna ${i.col}: ` : ""}${i.path || "(raiz)"}: ${i.message}`,
          )
          .join("\n"),
    );
  }
}

type Path = (string | number)[];
type Obj = Record<string, unknown>;

const ajv = new Ajv({ allErrors: true, strict: false, verbose: true });
const validateStructure = ajv.compile(scenarioSchema);

const TYPE_PT: Record<string, string> = {
  string: "texto",
  number: "número",
  integer: "inteiro",
  boolean: "booleano (true/false)",
  object: "objeto (chave: valor)",
  array: "lista",
  null: "null",
};

export function fmtPath(path: Path): string {
  return path.map((p, i) => (typeof p === "number" ? `[${p}]` : i ? `.${p}` : p)).join("");
}

class Locator {
  readonly issues: ScenarioIssue[] = [];
  constructor(
    private readonly doc: Document,
    private readonly lc: LineCounter,
  ) {}

  fail(path: Path, message: string): void {
    if (this.issues.some((i) => i.path === fmtPath(path) && i.message === message)) return;
    this.issues.push({ path: fmtPath(path), message, ...this.locate(path) });
  }

  private locate(path: Path): { line?: number; col?: number } {
    for (let p = path; ; p = p.slice(0, -1)) {
      const node = p.length ? this.doc.getIn(p, true) : this.doc.contents;
      if (isNode(node) && node.range) {
        const { line, col } = this.lc.linePos(node.range[0]);
        return { line, col };
      }
      if (!p.length) return {};
    }
  }
}

/** Converte o instancePath do ajv ("/flow/0/request") em caminho, distinguindo índices de chaves. */
function toPath(instancePath: string, root: unknown): Path {
  const out: Path = [];
  let cur: unknown = root;
  for (const raw of instancePath.split("/").slice(1)) {
    const seg = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    const key = Array.isArray(cur) ? Number(seg) : seg;
    out.push(key);
    cur =
      cur && typeof cur === "object" ? (cur as Record<string | number, unknown>)[key] : undefined;
  }
  return out;
}

function schemaIssues(errors: ErrorObject[], raw: unknown, loc: Locator): void {
  const typeErrorPaths = new Set(
    errors.filter((e) => e.keyword === "type").map((e) => e.instancePath),
  );
  // anyOf: os ramos geram erros próprios; mostra só uma mensagem para o campo
  const anyOfPaths = errors.filter((e) => e.keyword === "anyOf").map((e) => e.instancePath);
  for (const e of errors) {
    if (e.keyword === "propertyNames") continue; // o erro do pattern interno já descreve
    if (
      e.keyword !== "anyOf" &&
      anyOfPaths.some((p) => e.instancePath === p || e.instancePath.startsWith(`${p}/`))
    ) {
      continue;
    }
    if (e.keyword !== "type" && e.keyword !== "anyOf" && typeErrorPaths.has(e.instancePath))
      continue;
    const base = toPath(e.instancePath, raw);
    const params = e.params as Record<string, unknown>;
    const parent = (e.parentSchema ?? {}) as Record<string, unknown>;
    switch (e.keyword) {
      case "required":
        loc.fail([...base, params.missingProperty as string], "campo obrigatório");
        break;
      case "additionalProperties": {
        const allowed = Object.keys((parent.properties as object) ?? {}).filter(
          (k) => k !== "$schema",
        );
        loc.fail(
          [...base, params.additionalProperty as string],
          `campo desconhecido "${params.additionalProperty}"` +
            (allowed.length ? ` (permitidos: ${allowed.join(", ")})` : ""),
        );
        break;
      }
      case "type": {
        const types = ([] as string[]).concat(params.type as string | string[]);
        // campos com formato próprio (ex.: duração) explicam melhor que "deve ser texto"
        loc.fail(
          base,
          (parent["x-erro"] as string) ??
            `deve ser ${types.map((t) => TYPE_PT[t] ?? t).join(" ou ")}`,
        );
        break;
      }
      case "enum": {
        // métodos aceitam maiúsculas e minúsculas; mostra só uma forma
        const vals = (params.allowedValues as unknown[]).map(String);
        const shown = vals.filter((x) => x === x.toUpperCase() || !vals.includes(x.toUpperCase()));
        loc.fail(base, `deve ser um de: ${shown.join(", ")}`);
        break;
      }
      case "pattern":
        if (params.propertyName !== undefined) {
          loc.fail(
            [...base, params.propertyName as string],
            `"${params.propertyName}": ${(parent["x-erro"] as string) ?? "nome inválido"}`,
          );
        } else
          loc.fail(base, (parent["x-erro"] as string) ?? `formato inválido (${params.pattern})`);
        break;
      case "minimum":
      case "maximum":
      case "exclusiveMinimum":
        loc.fail(base, `deve ser ${params.comparison} ${params.limit}`);
        break;
      case "anyOf":
        loc.fail(
          base,
          (parent["x-erro"] as string) ??
            `valor inválido (${(parent.description as string) ?? "formato não reconhecido"})`,
        );
        break;
      case "minItems":
        loc.fail(base, `informe ao menos ${params.limit} item(ns)`);
        break;
      case "minLength":
        loc.fail(base, "não pode ser vazio");
        break;
      case "maxLength":
        loc.fail(base, `no máximo ${params.limit} caractere(s)`);
        break;
      default:
        loc.fail(base, e.message ?? "inválido");
    }
  }
}

const CONTENT_TYPES: Record<string, string> = {
  ".json": "application/json",
  ".xml": "application/xml",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".html": "text/html",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
};
const guessType = (file: string) =>
  CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";

export interface ParseOptions {
  /** Base para arquivos relativos (CSV, corpos). Padrão: pasta do arquivo do cenário ou cwd. */
  baseDir?: string;
  /** Força a semente (workers recebem a do coordenador para gerar os mesmos dados). */
  seed?: number;
}

/** Interpreta e valida um cenário YAML/JSON. Lança ScenarioError com linha/coluna de cada problema. */
export function parseScenario(text: string, file?: string, opts: ParseOptions = {}): Scenario {
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc, prettyErrors: true, merge: true });
  if (doc.errors.length) {
    throw new ScenarioError(
      doc.errors.map((e) => ({
        path: "",
        message: `YAML inválido: ${e.message.split("\n")[0]!.replace(/ at line \d+, column \d+:?\s*$/, "")}`,
        line: e.linePos?.[0].line,
        col: e.linePos?.[0].col,
      })),
      file,
    );
  }
  const raw = doc.toJS() as unknown;
  const loc = new Locator(doc, lc);

  // 1) estrutura (JSON Schema)
  if (!validateStructure(raw)) {
    schemaIssues(validateStructure.errors ?? [], raw, loc);
    // checagens independentes da estrutura, para mostrar todos os problemas de uma vez
    const ths = (raw as Obj | null)?.thresholds;
    if (Array.isArray(ths)) {
      ths.forEach((th, i) => {
        if (typeof th !== "string") return;
        try {
          parseThreshold(th);
        } catch (e) {
          loc.fail(["thresholds", i], (e as Error).message);
        }
      });
    }
    throw new ScenarioError(loc.issues, file);
  }
  const r = raw as unknown as Obj;
  const baseDir = opts.baseDir ?? (file ? path.dirname(path.resolve(file)) : process.cwd());

  // 2) semântica
  const secrets = new Set<string>();
  const copts: CompileOptions = { env: (n) => process.env[n], onSecret: (s) => secrets.add(s) };
  const checkRefs = (t: Template, p: Path, scope: Set<string>, later?: Map<string, number>) => {
    for (const root of referencedVars(t)) {
      if (scope.has(root) || BUILTIN_VARS.includes(root)) continue;
      const hint = later?.has(root)
        ? ` (ela só é extraída na etapa ${later.get(root)! + 1}, depois desta)`
        : scope.size
          ? ` (disponíveis: ${[...scope].join(", ")})`
          : "";
      loc.fail(p, `variável "${root}" não definida${hint}`);
    }
  };
  const tpl = (
    value: unknown,
    p: Path,
    scope: Set<string>,
    later?: Map<string, number>,
  ): Template => {
    try {
      const t = compileTemplate(String(value), copts);
      checkRefs(t, p, scope, later);
      return t;
    } catch (e) {
      loc.fail(p, (e as Error).message);
      return compileTemplate("");
    }
  };
  const tplEntries = (
    m: unknown,
    p: Path,
    scope: Set<string>,
    later?: Map<string, number>,
  ): [string, Template][] =>
    Object.entries((m as Obj) ?? {}).map(([k, v]) => [k, tpl(v, [...p, k], scope, later)]);
  const readFile = (f: string, p: Path): Buffer | undefined => {
    const full = path.resolve(baseDir, f);
    try {
      return fs.readFileSync(full);
    } catch (e) {
      loc.fail(
        p,
        `não foi possível ler "${f}" (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}; procurado em ${full})`,
      );
      return undefined;
    }
  };

  // dados (CSV)
  const datasets: Dataset[] = [];
  const dataScope = new Set<string>();
  const rawData = (r.data === undefined ? [] : Array.isArray(r.data) ? r.data : [r.data]) as Obj[];
  rawData.forEach((d, i) => {
    const p: Path = Array.isArray(r.data) ? ["data", i] : ["data"];
    const buf = readFile(d.file as string, [...p, "file"]);
    if (!buf) return;
    try {
      const table = csvToTable(buf.toString("utf8"), (d.delimiter as string) ?? ",");
      const names = d.name ? [d.name as string] : table.columns;
      for (const n of names) {
        if (dataScope.has(n))
          loc.fail(p, `"${n}" já é definido por outro dataset (use name: para separar)`);
        dataScope.add(n);
      }
      datasets.push({
        file: d.file as string,
        name: d.name as string | undefined,
        order: (d.order as Dataset["order"]) ?? "sequential",
        ...table,
      });
    } catch (e) {
      loc.fail([...p, "file"], `${d.file}: ${(e as Error).message}`);
    }
  });

  // variáveis (em ordem; cada uma enxerga dados e as anteriores)
  const varScope = new Set(dataScope);
  const variables: [string, Template][] = Object.entries((r.variables as Obj) ?? {}).map(
    ([k, v]) => {
      const t = tpl(v, ["variables", k], varScope);
      varScope.add(k);
      return [k, t];
    },
  );

  // alvo
  const t = r.target as Obj;
  const target = {
    baseUrl: (t.baseUrl as string).replace(/\/+$/, ""),
    headers: tplEntries(t.headers, ["target", "headers"], varScope),
    timeoutMs:
      (t.timeoutMs as number | undefined) ??
      (t.timeout !== undefined ? parseDuration(t.timeout as string) : 10_000),
    http2: (t.http2 as boolean | undefined) ?? false,
    ca: undefined as string | undefined,
  };
  const tlsOpts = t.tls as Obj | undefined;
  if (tlsOpts?.ca !== undefined) {
    target.ca = readFile(tlsOpts.ca as string, ["target", "tls", "ca"])?.toString("utf8");
    if (!target.baseUrl.startsWith("https:")) {
      loc.fail(["target", "tls"], "tls só se aplica a alvos https://");
    }
  }
  try {
    new URL(target.baseUrl);
  } catch {
    loc.fail(["target", "baseUrl"], `URL inválida "${target.baseUrl}"`);
  }

  // carga
  const l = r.load as Obj;
  const model = (l.model as "open" | "closed" | undefined) ?? "open";
  const range = (v: unknown): [number, number] => {
    if (typeof v === "number") return [v, v];
    const [a, b] = String(v)
      .split(/->|→/)
      .map((x) => Number(x.trim()));
    return [a!, b ?? a!];
  };
  const stages: RateStage[] = [];
  const vuStages: VuStage[] = [];
  (l.stages as Obj[]).forEach((st, i) => {
    const p: Path = ["load", "stages", i];
    const durationMs = parseDuration(st.duration as string);
    const unit = model === "open" ? "rps" : "vus";
    const other = model === "open" ? "vus" : "rps";
    if (st[other] !== undefined) {
      loc.fail(
        [...p, other],
        `modelo ${model} usa "${unit}" (${other} é do modelo ${model === "open" ? "closed" : "open"})`,
      );
    }
    if (st[unit] === undefined) {
      loc.fail(p, `informe "${unit}" (modelo ${model})`);
      return;
    }
    const [from, to] = range(st[unit]);
    if (model === "open") stages.push({ durationMs, rpsFrom: from, rpsTo: to });
    else {
      vuStages.push({ durationMs, vusFrom: from, vusTo: to });
      // o cronograma de chegadas não se aplica; mantém só a duração para relatórios
      stages.push({ durationMs, rpsFrom: 0, rpsTo: 0 });
    }
  });
  const totalMs = stages.reduce((s, st) => s + st.durationMs, 0);
  if (model === "open" && l.pacing !== undefined) {
    loc.fail(
      ["load", "pacing"],
      "pacing só se aplica ao modelo closed (no open, a taxa já define o ritmo)",
    );
  }
  if (model === "closed" && l.maxInFlight !== undefined) {
    loc.fail(
      ["load", "maxInFlight"],
      "maxInFlight só se aplica ao modelo open (no closed, use vus)",
    );
  }
  const stopWhen: string[] = [];
  ((l.stopWhen as string[] | undefined) ?? []).forEach((c, i) => {
    try {
      parseThreshold(c);
      stopWhen.push(c);
    } catch (e) {
      loc.fail(["load", "stopWhen", i], (e as Error).message.replace("threshold", "condição"));
    }
  });
  const warmupMs = l.warmup !== undefined ? parseDuration(l.warmup as string) : 0;
  if (warmupMs && warmupMs >= totalMs) {
    loc.fail(["load", "warmup"], "o aquecimento deve ser menor que a duração total");
  }

  // thresholds
  const thresholds: string[] = [];
  ((r.thresholds as string[]) ?? []).forEach((th, i) => {
    try {
      parseThreshold(th);
      thresholds.push(th);
    } catch (e) {
      loc.fail(["thresholds", i], (e as Error).message);
    }
  });

  // fluxos
  const compileExpect = (e: Obj, ep: Path): ExpectSpec => {
    const expect: ExpectSpec = {
      status:
        e.status === undefined ? undefined : ([] as number[]).concat(e.status as number | number[]),
      grpcStatus:
        e.grpcStatus === undefined
          ? undefined
          : ([] as (number | string)[])
              .concat(e.grpcStatus as number | string)
              .map((c) => (typeof c === "number" ? c : GRPC_CODES.indexOf(c))),
      maxDurationMs:
        e.maxDuration !== undefined ? parseDuration(e.maxDuration as string) : undefined,
      jsonPath: [],
      headers: [],
      bodyContains:
        e.bodyContains === undefined ? [] : ([] as string[]).concat(e.bodyContains as string),
    };
    for (const [jp, m] of Object.entries((e.jsonPath as Obj) ?? {})) {
      try {
        expect.jsonPath.push({ path: jp, segments: parseJsonPath(jp), matcher: parseMatcher(m) });
      } catch (err) {
        loc.fail([...ep, "jsonPath", jp], (err as Error).message);
      }
    }
    for (const [h, m] of Object.entries((e.headers as Obj) ?? {})) {
      try {
        expect.headers.push({ name: h.toLowerCase(), matcher: parseMatcher(m) });
      } catch (err) {
        loc.fail([...ep, "headers", h], (err as Error).message);
      }
    }
    if (e.bodyMatches !== undefined) {
      try {
        expect.bodyMatches = new RegExp(e.bodyMatches as string);
      } catch (err) {
        loc.fail([...ep, "bodyMatches"], `regex inválida: ${(err as Error).message}`);
      }
    }
    return expect;
  };

  const compileExtract = (x: Obj | undefined, xpBase: Path): [string, Extractor][] => {
    const extract: [string, Extractor][] = [];
    for (const [name, spec] of Object.entries(x ?? {})) {
      const xp: Path = [...xpBase, name];
      try {
        if (typeof spec === "string") {
          extract.push([name, { kind: "jsonPath", path: spec, segments: parseJsonPath(spec) }]);
          continue;
        }
        const o = spec as Obj;
        const which = ["jsonPath", "regex", "header"].filter((k) => o[k] !== undefined);
        if (which.length !== 1) {
          loc.fail(xp, "informe exatamente um entre jsonPath, regex e header");
          continue;
        }
        if (o.jsonPath !== undefined) {
          const jp = o.jsonPath as string;
          extract.push([
            name,
            { kind: "jsonPath", path: jp, segments: parseJsonPath(jp), default: o.default },
          ]);
        } else if (o.regex !== undefined) {
          const re = new RegExp(o.regex as string);
          const groups = new RegExp(`${re.source}|`).exec("")!.length - 1;
          const group = (o.group as number | undefined) ?? (groups ? 1 : 0);
          if (group > groups) loc.fail([...xp, "group"], `a regex tem só ${groups} grupo(s)`);
          extract.push([name, { kind: "regex", re, group, default: o.default }]);
        } else {
          extract.push([
            name,
            { kind: "header", name: (o.header as string).toLowerCase(), default: o.default },
          ]);
        }
      } catch (err) {
        loc.fail(xp, (err as Error).message);
      }
    }
    return extract;
  };

  const compileHttp = (
    rq: Obj,
    rp: Path,
    scope: Set<string>,
    later: Map<string, number>,
  ): RequestSpec => {
    const method = String(rq.method ?? "GET").toUpperCase() as HttpMethod;
    const query: [string, Template][] = [];
    for (const [k, v] of Object.entries((rq.query as Obj) ?? {})) {
      for (const [i, item] of (Array.isArray(v) ? v : [v]).entries()) {
        query.push([
          k,
          tpl(item, Array.isArray(v) ? [...rp, "query", k, i] : [...rp, "query", k], scope, later),
        ]);
      }
    }
    const kinds = ["json", "body", "form", "file", "multipart"].filter((k) => rq[k] !== undefined);
    if (kinds.length > 1) loc.fail(rp, `use apenas um corpo (encontrados: ${kinds.join(", ")})`);
    let body: BodySpec | undefined;
    const ctype = rq.contentType as string | undefined;
    if (rq.json !== undefined) {
      const value = compileJson(rq.json, copts, (tt, jp) =>
        checkRefs(tt, [...rp, "json", ...jp], scope, later),
      );
      body = { kind: "json", value, contentType: ctype ?? "application/json" };
    } else if (rq.body !== undefined) {
      body = {
        kind: "text",
        template: tpl(rq.body, [...rp, "body"], scope, later),
        contentType: ctype,
      };
    } else if (rq.form !== undefined) {
      body = {
        kind: "form",
        fields: tplEntries(rq.form, [...rp, "form"], scope, later),
        contentType: ctype ?? "application/x-www-form-urlencoded",
      };
    } else if (rq.file !== undefined) {
      const data = readFile(rq.file as string, [...rp, "file"]);
      if (data) {
        body = {
          kind: "file",
          data,
          source: rq.file as string,
          contentType: ctype ?? guessType(rq.file as string),
        };
      }
    } else if (rq.multipart !== undefined) {
      const parts: Extract<BodySpec, { kind: "multipart" }>["parts"] = [];
      for (const [name, v] of Object.entries(rq.multipart as Obj)) {
        if (v && typeof v === "object") {
          const f = v as { file: string; contentType?: string; filename?: string };
          const data = readFile(f.file, [...rp, "multipart", name, "file"]);
          if (data) {
            parts.push({
              name,
              file: data,
              filename: f.filename ?? path.basename(f.file),
              contentType: f.contentType ?? guessType(f.file),
            });
          }
        } else parts.push({ name, value: tpl(v, [...rp, "multipart", name], scope, later) });
      }
      body = { kind: "multipart", parts };
    }
    return {
      method,
      path: tpl(rq.path, [...rp, "path"], scope, later),
      headers: tplEntries(rq.headers, [...rp, "headers"], scope, later),
      query,
      body,
    };
  };

  const compileWs = (w: Obj, wp: Path, scope: Set<string>, later: Map<string, number>): WsSpec => {
    const local = new Set(scope); // extrações do roteiro valem para as ações seguintes
    const script: WsAction[] = [];
    let expects = 0;
    ((w.script as Obj[] | undefined) ?? []).forEach((a, i) => {
      const ap: Path = [...wp, "script", i];
      const kinds = ["send", "sendJson", "expect", "sleep"].filter((k) => a[k] !== undefined);
      if (kinds.length !== 1) {
        loc.fail(ap, "cada ação precisa de exatamente um entre send, sendJson, expect e sleep");
        return;
      }
      if (a.extract !== undefined && a.expect === undefined) {
        loc.fail(
          [...ap, "extract"],
          "extract só vale junto de expect (extrai da mensagem recebida)",
        );
      }
      if (a.send !== undefined)
        script.push({ kind: "send", text: tpl(a.send, [...ap, "send"], local, later) });
      else if (a.sendJson !== undefined) {
        script.push({
          kind: "send",
          json: compileJson(a.sendJson, copts, (tt, jp) =>
            checkRefs(tt, [...ap, "sendJson", ...jp], local, later),
          ),
        });
      } else if (a.sleep !== undefined)
        script.push({ kind: "sleep", ms: parseDuration(a.sleep as string) });
      else {
        const e = a.expect as Obj;
        const extract = compileExtract(a.extract as Obj | undefined, [...ap, "extract"]);
        for (const [k, x] of extract) {
          if (x.kind === "header")
            loc.fail([...ap, "extract", k], "mensagens WebSocket não têm headers");
          local.add(k);
        }
        script.push({
          kind: "expect",
          timeoutMs:
            e.timeout !== undefined ? parseDuration(e.timeout as string) : target.timeoutMs,
          expect: compileExpect(e, [...ap, "expect"]),
          extract,
          index: ++expects,
        });
      }
    });
    if (!script.length) loc.fail(wp, "informe um script com ao menos uma ação (send/expect/sleep)");
    return {
      path: tpl(w.path, [...wp, "path"], scope, later),
      headers: tplEntries(w.headers, [...wp, "headers"], scope, later),
      subprotocols: (w.subprotocols as string[] | undefined) ?? [],
      script,
    };
  };

  const compileGrpc = (
    g: Obj,
    gp: Path,
    scope: Set<string>,
    later: Map<string, number>,
  ): GrpcSpec | undefined => {
    const protoFile = path.resolve(baseDir, g.proto as string);
    let def: protoLoader.PackageDefinition;
    try {
      def = protoLoader.loadSync(protoFile, {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
      });
    } catch (e) {
      loc.fail(
        [...gp, "proto"],
        `não foi possível carregar "${g.proto}": ${(e as Error).message.split("\n")[0]}`,
      );
      return undefined;
    }
    const services = Object.entries(def).filter(([, v]) =>
      Object.values(v as object).some((m) => m && typeof m === "object" && "path" in (m as object)),
    );
    const svc = services.find(([k]) => k === g.service)?.[1] as
      Record<string, protoLoader.MethodDefinition<unknown, unknown>> | undefined;
    if (!svc) {
      loc.fail(
        [...gp, "service"],
        `serviço "${g.service}" não existe no .proto (disponíveis: ${services.map(([k]) => k).join(", ") || "nenhum"})`,
      );
      return undefined;
    }
    const m = svc[g.method as string];
    if (!m) {
      loc.fail(
        [...gp, "method"],
        `método "${g.method}" não existe em ${g.service} (disponíveis: ${Object.keys(svc).join(", ")})`,
      );
      return undefined;
    }
    if (m.requestStream || m.responseStream) {
      loc.fail(
        [...gp, "method"],
        "métodos com streaming ainda não são suportados; use chamadas unárias",
      );
      return undefined;
    }
    return {
      protoFile,
      service: g.service as string,
      method: g.method as string,
      path: m.path,
      message: compileJson(g.message ?? {}, copts, (tt, jp) =>
        checkRefs(tt, [...gp, "message", ...jp], scope, later),
      ),
      metadata: tplEntries(g.metadata, [...gp, "metadata"], scope, later),
      requestSerialize: m.requestSerialize as (v: unknown) => Buffer,
      responseSerialize: m.responseSerialize as (v: unknown) => Buffer,
      responseDeserialize: m.responseDeserialize as (b: Buffer) => unknown,
    };
  };

  const compileStep = (s: Obj, p: Path, scope: Set<string>, later: Map<string, number>): Step => {
    const kinds = (["request", "ws", "grpc"] as const).filter((k) => s[k] !== undefined);
    if (kinds.length !== 1) {
      loc.fail(
        p,
        "cada etapa precisa de exatamente um entre request (HTTP), ws (WebSocket) e grpc",
      );
    }
    const kind = kinds[0] === "ws" ? "ws" : kinds[0] === "grpc" ? "grpc" : "http";
    const e = (s.expect as Obj) ?? {};
    const ep: Path = [...p, "expect"];
    const expect = compileExpect(e, ep);
    const extract = compileExtract(s.extract as Obj | undefined, [...p, "extract"]);
    let think = { minMs: 0, maxMs: 0 };
    if (s.think !== undefined) {
      const [a, b] = (s.think as string).split("..").map((x) => parseDuration(x.trim()));
      think = { minMs: a!, maxMs: b ?? a! };
      if (think.maxMs < think.minMs)
        loc.fail([...p, "think"], "intervalo invertido (use menor..maior)");
    }
    if (kind !== "grpc" && e.grpcStatus !== undefined)
      loc.fail([...ep, "grpcStatus"], "grpcStatus só vale em etapas grpc");

    if (kind === "ws") {
      const w = s.ws as Obj;
      for (const k of Object.keys(e).filter((k) => k !== "maxDuration")) {
        loc.fail([...ep, k], "em etapas ws, as checagens ficam em script[].expect (por mensagem)");
      }
      if (s.extract !== undefined)
        loc.fail([...p, "extract"], "em etapas ws, use extract dentro do script (junto do expect)");
      const ws = compileWs(w, [...p, "ws"], scope, later);
      return {
        name: (s.name as string | undefined) ?? `WS ${w.path as string}`,
        kind,
        method: "WS",
        path: w.path as string,
        label: `WS ${w.path as string}`,
        ws,
        expect,
        extract: [],
        think,
        needsBody: false,
      };
    }
    if (kind === "grpc") {
      const g = s.grpc as Obj;
      if (e.status !== undefined)
        loc.fail([...ep, "status"], "em etapas grpc use grpcStatus (OK, NOT_FOUND…)");
      if (e.headers !== undefined)
        loc.fail([...ep, "headers"], "checagem de headers não se aplica a gRPC");
      for (const [k, x] of extract) {
        if (x.kind === "header")
          loc.fail([...p, "extract", k], "extração por header não se aplica a gRPC");
      }
      const grpc = compileGrpc(g, [...p, "grpc"], scope, later);
      const label = `${g.service as string}/${g.method as string}`;
      return {
        name: (s.name as string | undefined) ?? `GRPC ${label}`,
        kind,
        method: "GRPC",
        path: label,
        label: `GRPC ${label}`,
        grpc,
        expect,
        extract,
        think,
        needsBody: true,
      };
    }
    const rq = (s.request as Obj) ?? { path: "/" };
    const request = compileHttp(rq, [...p, "request"], scope, later);
    return {
      name: (s.name as string | undefined) ?? `${request.method} ${rq.path as string}`,
      kind: "http",
      method: request.method,
      path: rq.path as string,
      label: `${request.method} ${rq.path as string}`,
      request,
      expect,
      extract,
      think,
      needsBody:
        expect.jsonPath.length > 0 ||
        expect.bodyContains.length > 0 ||
        !!expect.bodyMatches ||
        extract.some(([, x]) => x.kind !== "header"),
    };
  };

  /** Variáveis que uma etapa extrai (inclui as do roteiro WebSocket). */
  const extractNames = (s: Obj): string[] => [
    ...Object.keys((s.extract as Obj) ?? {}),
    ...(((s.ws as Obj | undefined)?.script as Obj[] | undefined) ?? []).flatMap((a) =>
      Object.keys((a.extract as Obj) ?? {}),
    ),
  ];

  const compileFlow = (steps: Obj[], p: Path): Step[] => {
    const scope = new Set(varScope);
    const later = new Map<string, number>();
    steps.forEach((s, i) => {
      for (const k of extractNames(s)) if (!later.has(k)) later.set(k, i);
    });
    return steps.map((s, i) => {
      for (const [k, idx] of later) if (idx < i) scope.add(k);
      const later2 = new Map([...later].filter(([, idx]) => idx >= i));
      return compileStep(s, [...p, i], scope, later2);
    });
  };

  let flows: Flow[] = [];
  if (r.flow !== undefined && r.flows !== undefined)
    loc.fail(["flows"], "use flow (um fluxo) ou flows (vários), não ambos");
  else if (r.flow !== undefined) {
    flows = [{ name: "principal", weight: 1, steps: compileFlow(r.flow as Obj[], ["flow"]) }];
  } else if (r.flows !== undefined) {
    flows = (r.flows as Obj[]).map((f, i) => ({
      name: (f.name as string | undefined) ?? `fluxo ${i + 1}`,
      weight: (f.weight as number | undefined) ?? 1,
      steps: compileFlow(f.steps as Obj[], ["flows", i, "steps"]),
    }));
  } else loc.fail([], "informe flow (lista de etapas) ou flows (fluxos com pesos)");

  if (loc.issues.length) throw new ScenarioError(loc.issues, file);

  return {
    name: r.name as string,
    description: r.description as string | undefined,
    target,
    load: {
      model,
      stages,
      vuStages,
      pacingMs: l.pacing !== undefined ? parseDuration(l.pacing as string) : undefined,
      workers: (l.workers as number | "auto" | undefined) ?? "auto",
      stopWhen,
      warmupMs,
      maxInFlight: l.maxInFlight as number | undefined,
      connections: l.connections as number | undefined,
    },
    thresholds,
    variables,
    data: datasets,
    flows,
    seed: opts.seed ?? (r.seed as number | undefined) ?? randomInt(1, 2 ** 31 - 1),
    secrets: [...secrets],
    sourceFile: file,
    source: { text, file, baseDir },
  };
}

export function loadScenarioFile(file: string, opts: ParseOptions = {}): Scenario {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    throw new ConfigError(
      `não foi possível ler o cenário "${file}": ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`,
    );
  }
  // JSON é YAML válido: o mesmo parser atende .yaml/.yml/.json com linha/coluna nos erros
  return parseScenario(text, file, opts);
}
