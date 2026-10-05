/**
 * Subconjunto de JSONPath suficiente para checagens e extração:
 *   $                 raiz
 *   .nome  ['nome']   propriedade
 *   [0]  [-1]         índice (negativo conta do fim)
 *   [*]  .*           todos os itens/valores (o resultado vira lista)
 *   .length           tamanho de lista/texto (quando não há propriedade "length")
 */
export type Segment =
  { kind: "prop"; name: string } | { kind: "index"; i: number } | { kind: "wild" };

export class JsonPathError extends Error {}

export function parseJsonPath(expr: string): Segment[] {
  const src = expr.trim();
  if (!src.startsWith("$")) throw new JsonPathError(`JSONPath "${expr}" deve começar com "$"`);
  const segs: Segment[] = [];
  let i = 1;
  while (i < src.length) {
    if (src[i] === ".") {
      i++;
      if (src[i] === "*") {
        segs.push({ kind: "wild" });
        i++;
        continue;
      }
      const m = /^[A-Za-z_$][\w$-]*/.exec(src.slice(i));
      if (!m) throw new JsonPathError(`JSONPath "${expr}": nome esperado na posição ${i}`);
      segs.push({ kind: "prop", name: m[0] });
      i += m[0].length;
    } else if (src[i] === "[") {
      const close = src.indexOf("]", i);
      if (close < 0) throw new JsonPathError(`JSONPath "${expr}": falta "]"`);
      const inner = src.slice(i + 1, close).trim();
      if (inner === "*") segs.push({ kind: "wild" });
      else if (/^-?\d+$/.test(inner)) segs.push({ kind: "index", i: Number(inner) });
      else if (/^(['"]).*\1$/.test(inner)) segs.push({ kind: "prop", name: inner.slice(1, -1) });
      else
        throw new JsonPathError(
          `JSONPath "${expr}": "[${inner}]" não suportado (use [n], [*] ou ['nome'])`,
        );
      i = close + 1;
    } else {
      throw new JsonPathError(
        `JSONPath "${expr}": caractere inesperado "${src[i]}" na posição ${i}`,
      );
    }
  }
  return segs;
}

export interface JsonPathResult {
  found: boolean;
  value: unknown;
}

export function evalJsonPath(segs: Segment[], data: unknown): JsonPathResult {
  let current: unknown[] = [data];
  let multi = false;
  for (const s of segs) {
    const next: unknown[] = [];
    for (const v of current) {
      if (s.kind === "wild") {
        multi = true;
        if (Array.isArray(v)) next.push(...v);
        else if (v && typeof v === "object") next.push(...Object.values(v));
      } else if (s.kind === "index") {
        if (Array.isArray(v)) {
          const idx = s.i < 0 ? v.length + s.i : s.i;
          if (idx >= 0 && idx < v.length) next.push(v[idx]);
        }
      } else if (v && typeof v === "object" && s.name in (v as object)) {
        next.push((v as Record<string, unknown>)[s.name]);
      } else if (s.name === "length" && (Array.isArray(v) || typeof v === "string")) {
        next.push(v.length);
      }
    }
    current = next;
  }
  if (multi) return { found: current.length > 0, value: current };
  return current.length ? { found: true, value: current[0] } : { found: false, value: undefined };
}
