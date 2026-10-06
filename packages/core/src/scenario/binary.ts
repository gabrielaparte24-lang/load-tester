import { TemplateError } from "./template.js";

/** Maior arquivo aceito em sendBinary.file (lido uma vez, na validação). */
export const MAX_BINARY_FILE = 16 * 1024 * 1024;

/** Motivo pelo qual o texto não é hex/base64 válido, ou undefined. Espaços são ignorados. */
export function binaryProblem(encoding: "hex" | "base64", text: string): string | undefined {
  const t = text.replace(/\s+/g, "");
  if (encoding === "hex") {
    if (!/^[0-9a-fA-F]*$/.test(t)) return 'hex inválido: use só 0-9 e a-f (ex.: "cafe babe")';
    if (t.length % 2) return "hex inválido: número ímpar de dígitos";
    return undefined;
  }
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(t) || t.length % 4 === 1) return "base64 inválido";
  return undefined;
}

/** Decodifica hex/base64 (depois dos templates). Erro vira template_error na execução. */
export function decodeBinary(encoding: "hex" | "base64", text: string): Buffer {
  const problem = binaryProblem(encoding, text);
  if (problem) throw new TemplateError(`sendBinary: ${problem}`);
  return Buffer.from(text.replace(/\s+/g, ""), encoding);
}
