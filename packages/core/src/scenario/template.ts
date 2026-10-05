import { randInt, uuidV4, type Rng } from "./random.js";

/**
 * Templates `${...}` avaliados por iteração.
 *
 *   ${productId}            variável (de `variables`, colunas de CSV ou `extract`)
 *   ${user.email}           acesso a propriedade (dataset com `name`, objetos extraídos)
 *   ${items[0].id}          índice
 *   ${randInt(1, 20)}       função (ver FUNCTIONS)
 *   ${env.API_TOKEN}        variável de ambiente — resolvida ao carregar e tratada como segredo
 *   $${literal}             escape: produz o texto "${literal}"
 */
export type Expr =
  | { kind: "lit"; value: string | number }
  | { kind: "var"; root: string; path: (string | number)[] }
  | { kind: "call"; name: string; args: Expr[] };

export type TemplatePart = string | Expr;

export interface Template {
  source: string;
  parts: TemplatePart[];
  /** Sem expressões: o texto final já é conhecido. */
  isStatic: boolean;
}

export class TemplateError extends Error {}

export interface RenderContext {
  rng: Rng;
  vars: Map<string, unknown>;
  iteration: number;
  /** Prévia: variáveis ausentes (ex.: valores extraídos) viram "<nome>" em vez de erro. */
  placeholders?: boolean;
}

interface FnSpec {
  min: number;
  max: number;
  fn: (ctx: RenderContext, args: unknown[]) => unknown;
  doc: string;
}

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const num = (v: unknown, name: string): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new TemplateError(`${name}: "${String(v)}" não é um número`);
  return n;
};

export const FUNCTIONS: Record<string, FnSpec> = {
  randInt: {
    min: 2,
    max: 2,
    doc: "randInt(min, max) — inteiro uniforme, inclusivo",
    fn: (c, [a, b]) => randInt(c.rng, num(a, "randInt"), num(b, "randInt")),
  },
  randFloat: {
    min: 2,
    max: 3,
    doc: "randFloat(min, max, casas=2) — decimal uniforme",
    fn: (c, [a, b, d]) => {
      const lo = num(a, "randFloat");
      const hi = num(b, "randFloat");
      return Number((lo + c.rng() * (hi - lo)).toFixed(d === undefined ? 2 : num(d, "randFloat")));
    },
  },
  uuid: { min: 0, max: 0, doc: "uuid() — UUID v4 (derivado da semente)", fn: (c) => uuidV4(c.rng) },
  pick: {
    min: 1,
    max: Infinity,
    doc: "pick(a, b, c) ou pick(lista) — escolhe um item",
    fn: (c, args) => {
      const list = args.length === 1 && Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
      if (!list.length) throw new TemplateError("pick: lista vazia");
      return list[Math.floor(c.rng() * list.length)];
    },
  },
  randString: {
    min: 1,
    max: 2,
    doc: "randString(tamanho, caracteres?) — texto aleatório (alfanumérico por padrão)",
    fn: (c, [n, chars]) => {
      const set = chars === undefined ? ALNUM : String(chars);
      let s = "";
      for (let i = 0; i < num(n, "randString"); i++) s += set[Math.floor(c.rng() * set.length)];
      return s;
    },
  },
  iteration: {
    min: 0,
    max: 0,
    doc: "iteration() — índice global da iteração (0, 1, 2…)",
    fn: (c) => c.iteration,
  },
  now: { min: 0, max: 0, doc: "now() — epoch em ms", fn: () => Date.now() },
  isoNow: {
    min: 0,
    max: 0,
    doc: "isoNow() — data/hora atual ISO 8601",
    fn: () => new Date().toISOString(),
  },
  num: { min: 1, max: 1, doc: "num(x) — converte para número", fn: (_c, [v]) => num(v, "num") },
  str: { min: 1, max: 1, doc: "str(x) — converte para texto", fn: (_c, [v]) => String(v) },
  base64: {
    min: 1,
    max: 1,
    doc: "base64(texto) — ex.: Basic auth",
    fn: (_c, [v]) => Buffer.from(String(v)).toString("base64"),
  },
  urlencode: {
    min: 1,
    max: 1,
    doc: "urlencode(texto)",
    fn: (_c, [v]) => encodeURIComponent(String(v)),
  },
  lower: { min: 1, max: 1, doc: "lower(texto)", fn: (_c, [v]) => String(v).toLowerCase() },
  upper: { min: 1, max: 1, doc: "upper(texto)", fn: (_c, [v]) => String(v).toUpperCase() },
};

export const BUILTIN_VARS = ["__iteration"];

// ---------------------------------------------------------------- parser

class Parser {
  private i = 0;
  constructor(private readonly src: string) {}

  parse(): Expr {
    const e = this.expr();
    this.ws();
    if (this.i < this.src.length) this.fail(`caractere inesperado "${this.src[this.i]}"`);
    return e;
  }

  private fail(msg: string): never {
    throw new TemplateError(`expressão "\${${this.src}}": ${msg}`);
  }

  private ws(): void {
    while (/\s/.test(this.src[this.i] ?? "")) this.i++;
  }

  private expr(): Expr {
    this.ws();
    const ch = this.src[this.i];
    if (ch === '"' || ch === "'") return { kind: "lit", value: this.string(ch) };
    if (ch !== undefined && /[-\d]/.test(ch)) {
      const m = /^-?\d+(\.\d+)?/.exec(this.src.slice(this.i));
      if (!m) this.fail("número inválido");
      this.i += m[0].length;
      return { kind: "lit", value: Number(m[0]) };
    }
    const id = this.ident();
    this.ws();
    if (this.src[this.i] === "(") {
      this.i++;
      const args: Expr[] = [];
      this.ws();
      if (this.src[this.i] !== ")") {
        for (;;) {
          args.push(this.expr());
          this.ws();
          if (this.src[this.i] === ",") {
            this.i++;
            continue;
          }
          break;
        }
      }
      if (this.src[this.i] !== ")") this.fail('falta ")"');
      this.i++;
      const spec = FUNCTIONS[id];
      if (!spec)
        this.fail(
          `função desconhecida "${id}" (disponíveis: ${Object.keys(FUNCTIONS).join(", ")})`,
        );
      if (args.length < spec.min || args.length > spec.max) this.fail(`uso: ${spec.doc}`);
      return { kind: "call", name: id, args };
    }
    const path: (string | number)[] = [];
    for (;;) {
      if (this.src[this.i] === ".") {
        this.i++;
        path.push(this.ident());
      } else if (this.src[this.i] === "[") {
        this.i++;
        this.ws();
        const m = /^\d+/.exec(this.src.slice(this.i));
        if (m) {
          this.i += m[0].length;
          path.push(Number(m[0]));
        } else {
          const q = this.src[this.i];
          if (q !== '"' && q !== "'") this.fail("índice deve ser número ou texto entre aspas");
          path.push(this.string(q));
        }
        this.ws();
        if (this.src[this.i] !== "]") this.fail('falta "]"');
        this.i++;
      } else break;
    }
    return { kind: "var", root: id, path };
  }

  private ident(): string {
    const m = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(this.src.slice(this.i));
    if (!m)
      this.fail(
        this.i >= this.src.length
          ? "expressão vazia"
          : `nome inválido em "${this.src.slice(this.i)}"`,
      );
    this.i += m[0].length;
    return m[0];
  }

  private string(q: string): string {
    this.i++;
    let out = "";
    while (this.i < this.src.length && this.src[this.i] !== q) {
      if (this.src[this.i] === "\\" && this.i + 1 < this.src.length) this.i++;
      out += this.src[this.i++];
    }
    if (this.src[this.i] !== q) this.fail("texto sem aspas de fechamento");
    this.i++;
    return out;
  }
}

export interface CompileOptions {
  /** Resolve ${env.X} no carregamento; devolve undefined se não definida. */
  env?: (name: string) => string | undefined;
  onSecret?: (value: string) => void;
}

/** Compila um texto com ${...}. Lança TemplateError com mensagem amigável. */
export function compileTemplate(source: string, opts: CompileOptions = {}): Template {
  const parts: TemplatePart[] = [];
  let lit = "";
  let i = 0;
  while (i < source.length) {
    if (source.startsWith("$${", i)) {
      lit += "${";
      i += 3;
      continue;
    }
    if (!source.startsWith("${", i)) {
      lit += source[i++];
      continue;
    }
    // encontra o "}" de fechamento respeitando textos entre aspas
    let j = i + 2;
    let quote: string | null = null;
    for (; j < source.length; j++) {
      const ch = source[j];
      if (quote) {
        if (ch === "\\") j++;
        else if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "}") break;
    }
    if (j >= source.length) throw new TemplateError(`"\${" sem "}" de fechamento em "${source}"`);
    const inner = source.slice(i + 2, j).trim();
    const expr = resolveEnv(new Parser(inner).parse(), opts);
    if (expr.kind === "lit") {
      lit += String(expr.value);
    } else {
      if (lit) parts.push(lit);
      lit = "";
      parts.push(expr);
    }
    i = j + 1;
  }
  if (lit || !parts.length) parts.push(lit);
  return { source, parts, isStatic: parts.every((p) => typeof p === "string") };
}

/** Substitui env.X (em qualquer ponto da expressão) pelo valor literal, registrando-o como segredo. */
function resolveEnv(e: Expr, opts: CompileOptions): Expr {
  if (e.kind === "call") return { ...e, args: e.args.map((a) => resolveEnv(a, opts)) };
  if (e.kind !== "var" || e.root !== "env") return e;
  const name = e.path[0];
  if (typeof name !== "string" || e.path.length !== 1) {
    throw new TemplateError(`use \${env.NOME} para variáveis de ambiente`);
  }
  const val = opts.env?.(name);
  if (val === undefined) {
    throw new TemplateError(
      `variável de ambiente ${name} não definida (defina no .env ou no ambiente)`,
    );
  }
  opts.onSecret?.(val);
  return { kind: "lit", value: val };
}

/** Variáveis referenciadas (raiz), para validação estática. */
export function referencedVars(t: Template): string[] {
  const out: string[] = [];
  const walk = (e: Expr) => {
    if (e.kind === "var") out.push(e.root);
    else if (e.kind === "call") e.args.forEach(walk);
  };
  for (const p of t.parts) if (typeof p !== "string") walk(p);
  return out;
}

// ---------------------------------------------------------------- avaliação

function evalExpr(e: Expr, ctx: RenderContext): unknown {
  switch (e.kind) {
    case "lit":
      return e.value;
    case "call":
      return FUNCTIONS[e.name]!.fn(
        ctx,
        e.args.map((a) => evalExpr(a, ctx)),
      );
    case "var": {
      if (e.root === "__iteration") return ctx.iteration;
      if (!ctx.vars.has(e.root)) {
        if (ctx.placeholders) return `<${[e.root, ...e.path].join(".")}>`;
        throw new TemplateError(`variável "${e.root}" não definida nesta iteração`);
      }
      let v: unknown = ctx.vars.get(e.root);
      for (const k of e.path) {
        if (v === null || v === undefined || typeof v !== "object") {
          if (ctx.placeholders) return `<${[e.root, ...e.path].join(".")}>`;
          throw new TemplateError(`"${e.root}.${e.path.join(".")}" não existe`);
        }
        v = (v as Record<string | number, unknown>)[k];
      }
      return v;
    }
  }
}

const toText = (v: unknown): string =>
  v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);

export function renderTemplate(t: Template, ctx: RenderContext): string {
  if (t.isStatic) return t.parts[0] as string;
  let out = "";
  for (const p of t.parts) out += typeof p === "string" ? p : toText(evalExpr(p, ctx));
  return out;
}

/** Como renderTemplate, mas um template que é uma única expressão preserva o tipo (número, objeto…). */
export function renderValue(t: Template, ctx: RenderContext): unknown {
  if (t.parts.length === 1 && typeof t.parts[0] !== "string") return evalExpr(t.parts[0]!, ctx);
  return renderTemplate(t, ctx);
}

// ---------------------------------------------------------------- JSON com templates

export type JsonTemplate =
  | { kind: "tpl"; t: Template }
  | { kind: "raw"; v: unknown }
  | { kind: "arr"; items: JsonTemplate[] }
  | { kind: "obj"; entries: [Template, JsonTemplate][] };

export function compileJson(
  value: unknown,
  opts: CompileOptions,
  onTemplate?: (t: Template, path: (string | number)[]) => void,
  path: (string | number)[] = [],
): JsonTemplate {
  if (typeof value === "string") {
    const t = compileTemplate(value, opts);
    onTemplate?.(t, path);
    return t.isStatic ? { kind: "raw", v: t.parts[0] } : { kind: "tpl", t };
  }
  if (Array.isArray(value)) {
    return {
      kind: "arr",
      items: value.map((v, i) => compileJson(v, opts, onTemplate, [...path, i])),
    };
  }
  if (value && typeof value === "object") {
    return {
      kind: "obj",
      entries: Object.entries(value).map(([k, v]) => {
        const kt = compileTemplate(k, opts);
        onTemplate?.(kt, path);
        return [kt, compileJson(v, opts, onTemplate, [...path, k])];
      }),
    };
  }
  return { kind: "raw", v: value };
}

export function renderJson(j: JsonTemplate, ctx: RenderContext): unknown {
  switch (j.kind) {
    case "raw":
      return j.v;
    case "tpl":
      return renderValue(j.t, ctx);
    case "arr":
      return j.items.map((x) => renderJson(x, ctx));
    case "obj": {
      const out: Record<string, unknown> = {};
      for (const [k, v] of j.entries) out[renderTemplate(k, ctx)] = renderJson(v, ctx);
      return out;
    }
  }
}
