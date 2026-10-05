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
import { scenarioSchema } from "./schema.js";
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
  for (const e of errors) {
    if (e.keyword === "propertyNames") continue; // o erro do pattern interno já descreve
    if (e.keyword !== "type" && typeErrorPaths.has(e.instancePath)) continue;
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
  };
  try {
    new URL(target.baseUrl);
  } catch {
    loc.fail(["target", "baseUrl"], `URL inválida "${target.baseUrl}"`);
  }

  // carga
  const l = r.load as Obj;
  if (l.model === "closed") {
    loc.fail(["load", "model"], 'modelo "closed" chega na Fase 2; use "open" por enquanto');
  }
  const stages: RateStage[] = (l.stages as Obj[]).map((s) => {
    const [from, to] =
      typeof s.rps === "number"
        ? [s.rps, s.rps]
        : (s.rps as string).split(/->|→/).map((x) => Number(x.trim()));
    return { durationMs: parseDuration(s.duration as string), rpsFrom: from!, rpsTo: to ?? from! };
  });
  const totalMs = stages.reduce((s, st) => s + st.durationMs, 0);
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
  const compileStep = (s: Obj, p: Path, scope: Set<string>, later: Map<string, number>): Step => {
    const rq = s.request as Obj;
    const rp: Path = [...p, "request"];
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
      if (data)
        body = {
          kind: "file",
          data,
          source: rq.file as string,
          contentType: ctype ?? guessType(rq.file as string),
        };
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

    const request: RequestSpec = {
      method,
      path: tpl(rq.path, [...rp, "path"], scope, later),
      headers: tplEntries(rq.headers, [...rp, "headers"], scope, later),
      query,
      body,
    };

    const e = (s.expect as Obj) ?? {};
    const ep: Path = [...p, "expect"];
    const expect: ExpectSpec = {
      status:
        e.status === undefined ? undefined : ([] as number[]).concat(e.status as number | number[]),
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

    const extract: [string, Extractor][] = [];
    for (const [name, spec] of Object.entries((s.extract as Obj) ?? {})) {
      const xp: Path = [...p, "extract", name];
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

    let think = { minMs: 0, maxMs: 0 };
    if (s.think !== undefined) {
      const [a, b] = (s.think as string).split("..").map((x) => parseDuration(x.trim()));
      think = { minMs: a!, maxMs: b ?? a! };
      if (think.maxMs < think.minMs)
        loc.fail([...p, "think"], "intervalo invertido (use menor..maior)");
    }

    return {
      name: (s.name as string | undefined) ?? `${method} ${rq.path as string}`,
      label: `${method} ${rq.path as string}`,
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

  const compileFlow = (steps: Obj[], p: Path): Step[] => {
    const scope = new Set(varScope);
    const later = new Map<string, number>();
    steps.forEach((s, i) => {
      for (const k of Object.keys((s.extract as Obj) ?? {})) if (!later.has(k)) later.set(k, i);
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
      model: "open",
      stages,
      warmupMs,
      maxInFlight: l.maxInFlight as number | undefined,
      connections: l.connections as number | undefined,
    },
    thresholds,
    variables,
    data: datasets,
    flows,
    seed: (r.seed as number | undefined) ?? randomInt(1, 2 ** 31 - 1),
    secrets: [...secrets],
    sourceFile: file,
  };
}

export function loadScenarioFile(file: string): Scenario {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    throw new ConfigError(
      `não foi possível ler o cenário "${file}": ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`,
    );
  }
  // JSON é YAML válido: o mesmo parser atende .yaml/.yml/.json com linha/coluna nos erros
  return parseScenario(text, file);
}
