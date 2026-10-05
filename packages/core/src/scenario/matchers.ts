/**
 * Matchers usados em expect.jsonPath e expect.headers:
 *   200 | true | null     igualdade com o valor
 *   "texto"               igualdade textual
 *   ">0"  ">= 5"  "<10"   comparação numérica
 *   "== ok"  "!= erro"    igualdade/desigualdade (numérica se ambos forem números)
 *   "~^abc"               expressão regular
 *   "exists" | "!exists"  presença
 */
export interface Matcher {
  label: string;
  test: (found: boolean, value: unknown) => boolean;
}

export class MatcherError extends Error {}

const isNum = (v: unknown) =>
  v !== "" && v !== null && typeof v !== "boolean" && Number.isFinite(Number(v));
const unquote = (s: string) => (/^(['"]).*\1$/.test(s) ? s.slice(1, -1) : s);
const text = (v: unknown) => (v !== null && typeof v === "object" ? JSON.stringify(v) : String(v));

export function parseMatcher(spec: unknown): Matcher {
  if (typeof spec !== "string") {
    return {
      label: `== ${JSON.stringify(spec)}`,
      test: (found, v) =>
        found && (isNum(spec) && isNum(v) ? Number(v) === Number(spec) : v === spec),
    };
  }
  const s = spec.trim();
  if (s === "exists") return { label: "existe", test: (found) => found };
  if (s === "!exists" || s === "notExists") return { label: "não existe", test: (found) => !found };
  if (s.startsWith("~")) {
    let re: RegExp;
    try {
      re = new RegExp(s.slice(1).trim());
    } catch (e) {
      throw new MatcherError(`regex inválida "${s.slice(1)}": ${(e as Error).message}`);
    }
    return { label: `~ /${re.source}/`, test: (found, v) => found && re.test(text(v)) };
  }
  const m = /^(>=|<=|==|!=|>|<)\s*(.*)$/.exec(s);
  if (m) {
    const op = m[1]!;
    const rhs = unquote(m[2]!.trim());
    if ([">", "<", ">=", "<="].includes(op)) {
      if (!isNum(rhs)) throw new MatcherError(`"${s}": ${op} exige um número`);
      const n = Number(rhs);
      return {
        label: `${op} ${rhs}`,
        test: (found, v) => {
          if (!found || !isNum(v)) return false;
          const x = Number(v);
          return op === ">" ? x > n : op === "<" ? x < n : op === ">=" ? x >= n : x <= n;
        },
      };
    }
    const eq = (v: unknown) =>
      isNum(rhs) && isNum(v) ? Number(v) === Number(rhs) : text(v) === rhs;
    return op === "=="
      ? { label: `== ${rhs}`, test: (found, v) => found && eq(v) }
      : { label: `!= ${rhs}`, test: (found, v) => !found || !eq(v) };
  }
  return { label: `== ${JSON.stringify(s)}`, test: (found, v) => found && text(v) === s };
}
