import fs from "node:fs";
import { randomInt } from "node:crypto";
import { LineCounter, isNode, parseDocument, type Document } from "yaml";
import { parseDuration } from "../duration.js";
import { ConfigError } from "../errors.js";
import type { RateStage } from "../schedule.js";
import { parseThreshold } from "../thresholds.js";
import { HTTP_METHODS, type HttpMethod, type Scenario, type Step } from "./types.js";

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

const ENV_RE = /\$\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}/g;
const ANY_EXPR_RE = /\$\{[^}]*\}/;

class Validator {
  readonly issues: ScenarioIssue[] = [];
  readonly secrets = new Set<string>();

  constructor(
    private readonly doc: Document,
    private readonly lc: LineCounter,
  ) {}

  fail(path: Path, message: string): void {
    const pos = this.locate(path);
    this.issues.push({ path: fmt(path), message, ...pos });
  }

  private locate(path: Path): { line?: number; col?: number } {
    for (let p = path; p.length >= 0; p = p.slice(0, -1)) {
      const node = p.length ? this.doc.getIn(p, true) : this.doc.contents;
      if (isNode(node) && node.range) {
        const { line, col } = this.lc.linePos(node.range[0]);
        return { line, col };
      }
      if (!p.length) break;
    }
    return {};
  }

  obj(v: unknown, path: Path, allowed: string[], required = true): Obj | undefined {
    if (v === undefined || v === null) {
      if (required) this.fail(path, "campo obrigatório");
      return undefined;
    }
    if (typeof v !== "object" || Array.isArray(v)) {
      this.fail(path, "deve ser um objeto");
      return undefined;
    }
    for (const k of Object.keys(v)) {
      if (!allowed.includes(k)) {
        this.fail([...path, k], `campo desconhecido "${k}" (permitidos: ${allowed.join(", ")})`);
      }
    }
    return v as Obj;
  }

  str(v: unknown, path: Path, required = true): string | undefined {
    if (v === undefined || v === null) {
      if (required) this.fail(path, "campo obrigatório");
      return undefined;
    }
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
      this.fail(path, "deve ser texto");
      return undefined;
    }
    return this.interpolate(String(v), path);
  }

  posInt(v: unknown, path: Path): number | undefined {
    if (v === undefined) return undefined;
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
      this.fail(path, "deve ser um inteiro positivo");
      return undefined;
    }
    return v;
  }

  duration(v: unknown, path: Path): number | undefined {
    if (v === undefined) return undefined;
    try {
      return parseDuration(v as string, fmt(path));
    } catch (e) {
      this.fail(path, (e as Error).message.replace(`${fmt(path)}: `, ""));
      return undefined;
    }
  }

  map(v: unknown, path: Path): Record<string, string> {
    const out: Record<string, string> = {};
    if (v === undefined || v === null) return out;
    if (typeof v !== "object" || Array.isArray(v)) {
      this.fail(path, "deve ser um mapa chave: valor");
      return out;
    }
    for (const [k, val] of Object.entries(v)) {
      const s = this.str(val, [...path, k]);
      if (s !== undefined) out[k] = s;
    }
    return out;
  }

  /** Substitui ${env.NOME}; demais expressões ${...} chegam na Fase 1 (motor de templates). */
  interpolate(s: string, path: Path): string {
    const out = s.replace(ENV_RE, (_m, name: string) => {
      const val = process.env[name];
      if (val === undefined) {
        this.fail(
          path,
          `variável de ambiente ${name} não definida (defina no .env ou no ambiente)`,
        );
        return "";
      }
      this.secrets.add(val);
      return val;
    });
    if (ANY_EXPR_RE.test(out)) {
      this.fail(
        path,
        `expressão "${ANY_EXPR_RE.exec(out)![0]}" ainda não suportada (apenas \${env.NOME} nesta versão)`,
      );
    }
    return out;
  }
}

function fmt(path: Path): string {
  return path.map((p, i) => (typeof p === "number" ? `[${p}]` : i ? `.${p}` : p)).join("");
}

function parseRps(v: unknown, path: Path, val: Validator): [number, number] | undefined {
  if (typeof v === "number" && v >= 0) return [v, v];
  if (typeof v === "string") {
    const m = /^\s*(\d+(?:\.\d+)?)\s*(?:->|→)\s*(\d+(?:\.\d+)?)\s*$/.exec(v);
    if (m) return [Number(m[1]), Number(m[2])];
    if (/^\s*\d+(?:\.\d+)?\s*$/.test(v)) return [Number(v), Number(v)];
  }
  val.fail(path, 'deve ser um número ≥ 0 ou uma rampa "50 -> 300"');
  return undefined;
}

export function parseScenario(text: string, file?: string): Scenario {
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc, prettyErrors: true });
  if (doc.errors.length) {
    throw new ScenarioError(
      doc.errors.map((e) => ({
        path: "",
        message: `YAML inválido: ${e.message.split("\n")[0]}`,
        line: e.linePos?.[0].line,
        col: e.linePos?.[0].col,
      })),
      file,
    );
  }
  const v = new Validator(doc, lc);
  const raw = v.obj(
    doc.toJS(),
    [],
    ["name", "description", "target", "load", "thresholds", "flow", "seed"],
  );
  if (!raw) throw new ScenarioError(v.issues, file);

  const name = v.str(raw.name, ["name"]) ?? "";
  const description = v.str(raw.description, ["description"], false);

  // target
  const t = v.obj(raw.target, ["target"], ["baseUrl", "headers", "timeoutMs", "timeout"]);
  let baseUrl = "";
  if (t) {
    baseUrl = v.str(t.baseUrl, ["target", "baseUrl"]) ?? "";
    if (baseUrl) {
      try {
        const u = new URL(baseUrl);
        if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
      } catch {
        v.fail(["target", "baseUrl"], `URL inválida "${baseUrl}" (use http:// ou https://)`);
      }
    }
  }
  const headers = v.map(t?.headers, ["target", "headers"]);
  const timeoutMs =
    v.posInt(t?.timeoutMs, ["target", "timeoutMs"]) ??
    v.duration(t?.timeout, ["target", "timeout"]) ??
    10_000;

  // load
  const l = v.obj(raw.load, ["load"], ["model", "stages", "warmup", "maxInFlight", "connections"]);
  const stages: RateStage[] = [];
  const model = l?.model ?? "open";
  if (model === "closed")
    v.fail(["load", "model"], 'modelo "closed" chega na Fase 2; use "open" por enquanto');
  else if (model !== "open") v.fail(["load", "model"], 'deve ser "open" ou "closed"');
  if (l) {
    if (!Array.isArray(l.stages) || !l.stages.length) {
      v.fail(["load", "stages"], "informe ao menos uma etapa: - { duration: 30s, rps: 50 }");
    } else {
      l.stages.forEach((s, i) => {
        const p = ["load", "stages", i];
        const st = v.obj(s, p, ["duration", "rps"]);
        if (!st) return;
        const durationMs = v.duration(st.duration, [...p, "duration"]);
        if (st.duration === undefined) v.fail([...p, "duration"], "campo obrigatório");
        const rps =
          st.rps === undefined
            ? (v.fail([...p, "rps"], "campo obrigatório"), undefined)
            : parseRps(st.rps, [...p, "rps"], v);
        if (durationMs !== undefined && rps)
          stages.push({ durationMs, rpsFrom: rps[0], rpsTo: rps[1] });
      });
    }
  }
  const totalMs = stages.reduce((s, st) => s + st.durationMs, 0);
  const warmupMs = v.duration(l?.warmup, ["load", "warmup"]) ?? 0;
  if (warmupMs && warmupMs >= totalMs)
    v.fail(["load", "warmup"], "o aquecimento deve ser menor que a duração total");

  // thresholds
  const thresholds: string[] = [];
  if (raw.thresholds !== undefined) {
    if (!Array.isArray(raw.thresholds))
      v.fail(["thresholds"], 'deve ser uma lista, ex.: ["p95 < 300ms"]');
    else
      raw.thresholds.forEach((th, i) => {
        const s = v.str(th, ["thresholds", i]);
        if (s === undefined) return;
        try {
          parseThreshold(s);
          thresholds.push(s);
        } catch (e) {
          v.fail(["thresholds", i], (e as Error).message);
        }
      });
  }

  // flow
  const flow: Step[] = [];
  if (!Array.isArray(raw.flow) || !raw.flow.length) {
    v.fail(["flow"], "informe ao menos uma etapa com request: { method: GET, path: / }");
  } else {
    raw.flow.forEach((s, i) => {
      const p: Path = ["flow", i];
      const st = v.obj(s, p, ["name", "request", "expect", "think"]);
      if (!st) return;
      const r = v.obj(
        st.request,
        [...p, "request"],
        ["method", "path", "headers", "query", "json", "body", "form"],
      );
      if (!r) return;
      const method = String(r.method ?? "GET").toUpperCase() as HttpMethod;
      if (!HTTP_METHODS.includes(method))
        v.fail([...p, "request", "method"], `método inválido (use ${HTTP_METHODS.join(", ")})`);
      const path = v.str(r.path, [...p, "request", "path"]) ?? "/";
      if (!path.startsWith("/"))
        v.fail([...p, "request", "path"], 'deve começar com "/" (relativo a target.baseUrl)');

      let body: string | undefined;
      let contentType: string | undefined;
      const bodyKinds = ["json", "body", "form"].filter((k) => r[k] !== undefined);
      if (bodyKinds.length > 1) v.fail([...p, "request"], "use apenas um entre json, body e form");
      if (r.json !== undefined) {
        body = v.interpolate(JSON.stringify(r.json), [...p, "request", "json"]);
        contentType = "application/json";
      } else if (r.body !== undefined) {
        body = v.str(r.body, [...p, "request", "body"]);
      } else if (r.form !== undefined) {
        body = new URLSearchParams(v.map(r.form, [...p, "request", "form"])).toString();
        contentType = "application/x-www-form-urlencoded";
      }

      const e = v.obj(st.expect, [...p, "expect"], ["status", "maxDuration"], false);
      let status: number[] | undefined;
      if (e?.status !== undefined) {
        const arr = Array.isArray(e.status) ? e.status : [e.status];
        if (arr.every((x) => Number.isInteger(x) && (x as number) >= 100 && (x as number) <= 599))
          status = arr as number[];
        else
          v.fail(
            [...p, "expect", "status"],
            "deve ser um status HTTP (100–599) ou uma lista deles",
          );
      }

      flow.push({
        name: v.str(st.name, [...p, "name"], false) ?? `${method} ${path}`,
        request: {
          method,
          path,
          headers: v.map(r.headers, [...p, "request", "headers"]),
          query: v.map(r.query, [...p, "request", "query"]),
          body,
          contentType,
        },
        expect: {
          status,
          maxDurationMs: v.duration(e?.maxDuration, [...p, "expect", "maxDuration"]),
        },
        thinkMs: v.duration(st.think, [...p, "think"]) ?? 0,
      });
    });
  }

  let seed = randomInt(1, 2 ** 31 - 1);
  if (raw.seed !== undefined) seed = v.posInt(raw.seed, ["seed"]) ?? seed;

  if (v.issues.length) throw new ScenarioError(v.issues, file);

  return {
    name,
    description,
    target: { baseUrl: baseUrl.replace(/\/+$/, ""), headers, timeoutMs },
    load: {
      model: "open",
      stages,
      warmupMs,
      maxInFlight: v.posInt(l?.maxInFlight, ["load", "maxInFlight"]),
      connections: v.posInt(l?.connections, ["load", "connections"]),
    },
    thresholds,
    flow,
    seed,
    secrets: [...v.secrets],
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
