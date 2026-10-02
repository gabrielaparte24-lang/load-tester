const SENSITIVE_HEADER =
  /authorization|cookie|token|secret|api[-_]?key|password|passwd|credential/i;
export const MASK = "***";

/** Mascara valores secretos em texto livre (logs, relatórios, dashboard). */
export function maskText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s.length >= 3) out = out.split(s).join(MASK);
  }
  return out;
}

/** Mascara headers sensíveis preservando o esquema (ex.: "Bearer ***"). */
export function maskHeaders(
  headers: Record<string, string>,
  secrets: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (SENSITIVE_HEADER.test(k)) {
      const scheme = /^(Bearer|Basic|Token|Digest)\s+/i.exec(v);
      out[k] = scheme ? `${scheme[1]} ${MASK}` : MASK;
    } else {
      out[k] = maskText(v, secrets);
    }
  }
  return out;
}

/** Mascara recursivamente qualquer string dentro de um objeto JSON-serializável. */
export function maskDeep<T>(value: T, secrets: readonly string[]): T {
  if (typeof value === "string") return maskText(value, secrets) as T;
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, secrets)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] =
        k === "headers" && v && typeof v === "object" && !Array.isArray(v)
          ? maskHeaders(v as Record<string, string>, secrets)
          : maskDeep(v, secrets);
    }
    return out as T;
  }
  return value;
}
