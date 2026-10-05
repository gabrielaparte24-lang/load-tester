import { createRng, type Rng } from "../scenario/random.js";

/**
 * Estatística para comparar execuções. Escolhas (documentadas no README):
 *  - Mann-Whitney U (não paramétrico): latências não são normais e têm caudas longas.
 *    Exato por enumeração das permutações dos postos quando C(n1+n2, n1) ≤ 200 mil (trata
 *    empates corretamente); senão, aproximação normal com correção de empates e de continuidade.
 *  - Hodges-Lehmann: estimativa robusta do deslocamento (mediana das diferenças par a par).
 *  - Bootstrap percentil com semente fixa: IC 95% reprodutível para a diferença de medianas.
 *  - Holm: controla a taxa de falsos positivos quando várias métricas são testadas juntas.
 */

export function sorted(xs: readonly number[]): number[] {
  return [...xs].sort((a, b) => a - b);
}

/** Quantil com interpolação linear (tipo 7, o padrão do R/NumPy). */
export function quantile(xs: readonly number[], q: number): number {
  if (!xs.length) return NaN;
  const s = sorted(xs);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

export const median = (xs: readonly number[]) => quantile(xs, 0.5);

export function mean(xs: readonly number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

/** Desvio-padrão amostral (n − 1). */
export function stdev(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

/** Estimador de Hodges-Lehmann do deslocamento B − A. */
export function hodgesLehmann(a: readonly number[], b: readonly number[]): number {
  const diffs: number[] = [];
  for (const x of a) for (const y of b) diffs.push(y - x);
  return median(diffs);
}

/** Postos médios (empates recebem a média dos postos). */
export function ranks(xs: readonly number[]): number[] {
  const idx = xs.map((x, i) => [x, i] as const).sort((p, q) => p[0] - q[0]);
  const r = new Array<number>(xs.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k]![1]] = avg;
    i = j + 1;
  }
  return r;
}

function binom(n: number, k: number): number {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

/** Função de distribuição da normal padrão (Abramowitz–Stegun 7.1.26 via erf). */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z / Math.SQRT2));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

export interface MannWhitney {
  /** U do grupo A (número de pares com a > b, empates contam ½). */
  u: number;
  /** p bilateral. */
  p: number;
  method: "exact" | "normal";
  /** Correlação rank-biserial em [−1, 1]: > 0 quando B tende a ser maior que A. */
  effect: number;
}

export const EXACT_LIMIT = 200_000;

export function mannWhitney(a: readonly number[], b: readonly number[]): MannWhitney {
  const n1 = a.length;
  const n2 = b.length;
  if (!n1 || !n2) return { u: NaN, p: 1, method: "exact", effect: 0 };
  const all = [...a, ...b];
  const r = ranks(all);
  const r1 = r.slice(0, n1).reduce((x, y) => x + y, 0);
  const u1 = r1 - (n1 * (n1 + 1)) / 2;
  const mu = (n1 * n2) / 2;
  const effect = 1 - (2 * u1) / (n1 * n2); // > 0 ⇒ B maior

  if (binom(n1 + n2, n1) <= EXACT_LIMIT) {
    // enumera todas as formas de escolher n1 postos (com empates) para o grupo A
    const obs = Math.abs(r1 - (n1 * (n1 + n2 + 1)) / 2);
    const expected = (n1 * (n1 + n2 + 1)) / 2;
    const N = n1 + n2;
    let extreme = 0;
    let total = 0;
    const eps = 1e-9;
    const rec = (start: number, left: number, acc: number) => {
      if (left === 0) {
        total++;
        if (Math.abs(acc - expected) >= obs - eps) extreme++;
        return;
      }
      for (let i = start; i <= N - left; i++) rec(i + 1, left - 1, acc + r[i]!);
    };
    rec(0, n1, 0);
    return { u: u1, p: Math.min(1, extreme / total), method: "exact", effect };
  }

  // aproximação normal com correção de empates e de continuidade
  const N = n1 + n2;
  const counts = new Map<number, number>();
  for (const x of all) counts.set(x, (counts.get(x) ?? 0) + 1);
  let tie = 0;
  for (const t of counts.values()) tie += t ** 3 - t;
  const sigma = Math.sqrt(((n1 * n2) / 12) * (N + 1 - tie / (N * (N - 1))));
  if (sigma === 0) return { u: u1, p: 1, method: "normal", effect };
  const z = (Math.abs(u1 - mu) - 0.5) / sigma;
  return { u: u1, p: Math.min(1, 2 * (1 - normalCdf(Math.max(0, z)))), method: "normal", effect };
}

export interface Interval {
  lo: number;
  hi: number;
}

/** IC percentil por bootstrap de uma estatística de uma amostra. */
export function bootstrapCI(
  xs: readonly number[],
  stat: (s: number[]) => number = median,
  opts: { iterations?: number; level?: number; seed?: number } = {},
): Interval {
  const { iterations = 5000, level = 0.95, seed = 12345 } = opts;
  if (xs.length < 2) return { lo: xs[0] ?? NaN, hi: xs[0] ?? NaN };
  const rng = createRng(seed);
  const vals = new Array<number>(iterations);
  for (let i = 0; i < iterations; i++) vals[i] = stat(resample(xs, rng));
  return { lo: quantile(vals, (1 - level) / 2), hi: quantile(vals, 1 - (1 - level) / 2) };
}

/** IC percentil por bootstrap da diferença de medianas (B − A). */
export function bootstrapDiffCI(
  a: readonly number[],
  b: readonly number[],
  opts: { iterations?: number; level?: number; seed?: number } = {},
): Interval {
  const { iterations = 5000, level = 0.95, seed = 54321 } = opts;
  if (!a.length || !b.length) return { lo: NaN, hi: NaN };
  const rng = createRng(seed);
  const vals = new Array<number>(iterations);
  for (let i = 0; i < iterations; i++)
    vals[i] = median(resample(b, rng)) - median(resample(a, rng));
  return { lo: quantile(vals, (1 - level) / 2), hi: quantile(vals, 1 - (1 - level) / 2) };
}

function resample(xs: readonly number[], rng: Rng): number[] {
  const out = new Array<number>(xs.length);
  for (let i = 0; i < xs.length; i++) out[i] = xs[Math.floor(rng() * xs.length)]!;
  return out;
}

/** Correção de Holm–Bonferroni: devolve os p-valores ajustados na ordem original. */
export function holm(ps: readonly number[]): number[] {
  const order = ps.map((p, i) => [p, i] as const).sort((x, y) => x[0] - y[0]);
  const m = ps.length;
  const adj = new Array<number>(m);
  let running = 0;
  order.forEach(([p, i], k) => {
    running = Math.max(running, Math.min(1, (m - k) * p));
    adj[i] = running;
  });
  return adj;
}

/** Teste z de duas proporções (bilateral), ex.: taxas de erro com muitas requisições. */
export function twoProportionZ(x1: number, n1: number, x2: number, n2: number): number {
  if (!n1 || !n2) return 1;
  const p = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (se === 0) return 1;
  const z = Math.abs(x1 / n1 - x2 / n2) / se;
  return Math.min(1, 2 * (1 - normalCdf(z)));
}
