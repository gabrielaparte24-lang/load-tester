import { ConfigError } from "./errors.js";

const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/**
 * Converte "500ms", "30s", "2m", "1h", "1m30s" em milissegundos.
 * Números puros são recusados para evitar ambiguidade de unidade.
 */
export function parseDuration(input: string | number, field = "duração"): number {
  if (typeof input === "number") {
    throw new ConfigError(
      `${field}: informe a unidade (ex.: "${input}s" ou "${input}ms"), número puro é ambíguo`,
    );
  }
  const text = input.trim();
  const re = /(\d+(?:\.\d+)?)\s*(ms|s|m|h)/gy;
  let total = 0;
  let consumed = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    total += Number(match[1]) * UNIT_MS[match[2]!]!;
    consumed = re.lastIndex;
  }
  if (consumed === 0 || consumed !== text.length) {
    throw new ConfigError(`${field}: "${input}" não é uma duração válida (use ms, s, m ou h)`);
  }
  return total;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${+totalSec.toFixed(1)}s`;
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.round(totalSec % 60);
  return [h ? `${h}h` : "", m ? `${m}m` : "", s ? `${s}s` : ""].join("") || "0s";
}
