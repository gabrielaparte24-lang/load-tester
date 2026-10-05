import { decodeHistogram } from "../metrics.js";

/** Ponto da função de distribuição acumulada: valor (ms) e fração ≤ valor. */
export interface CdfPoint {
  ms: number;
  cum: number;
}

/** CDF completa do HdrHistogram (via a saída CSV de percentis do próprio HdrHistogram). */
export function latencyCdf(b64: string): { points: CdfPoint[]; total: number } {
  if (!b64) return { points: [], total: 0 };
  const h = decodeHistogram(b64);
  const total = h.totalCount;
  if (!total) return { points: [], total: 0 };
  const csv = h.outputPercentileDistribution(5, 1000, true as false) as string;
  const points: CdfPoint[] = [];
  for (const line of csv.split("\n").slice(1)) {
    const [v, p] = line.split(",");
    const ms = Number(v);
    const cum = Number(p);
    if (Number.isFinite(ms) && Number.isFinite(cum)) points.push({ ms, cum });
  }
  return { points, total };
}

/** Curva de percentis em escala de "noves": x = log10(1 / (1 − p)), de p0 a p99.999. */
export function percentileCurve(b64: string): { x: number[]; ms: number[] } {
  if (!b64) return { x: [], ms: [] };
  const h = decodeHistogram(b64);
  if (!h.totalCount) return { x: [], ms: [] };
  const x: number[] = [];
  const ms: number[] = [];
  for (let n = 0; n <= 5.0001; n += 0.05) {
    const p = 100 * (1 - 10 ** -n);
    x.push(+n.toFixed(2));
    ms.push(h.getValueAtPercentile(Math.min(p, 99.999)) / 1000);
  }
  return { x, ms };
}

/** Histograma em faixas logarítmicas de latência (contagem por faixa), derivado da CDF. */
export function logBuckets(
  b64: string,
  buckets = 30,
): { from: number; to: number; count: number }[] {
  const { points, total } = latencyCdf(b64);
  if (!points.length) return [];
  const min = Math.max(0.001, points[0]!.ms);
  const max = points[points.length - 1]!.ms;
  if (max <= min) return [{ from: min, to: max, count: total }];
  const lmin = Math.log10(min);
  const lmax = Math.log10(max * 1.0001);
  const cdfAt = (v: number) => {
    let c = 0;
    for (const p of points) {
      if (p.ms <= v) c = p.cum;
      else break;
    }
    return c;
  };
  const out: { from: number; to: number; count: number }[] = [];
  let prev = 0;
  for (let i = 1; i <= buckets; i++) {
    const to = 10 ** (lmin + ((lmax - lmin) * i) / buckets);
    const from = 10 ** (lmin + ((lmax - lmin) * (i - 1)) / buckets);
    const c = i === buckets ? 1 : cdfAt(to);
    out.push({ from, to, count: Math.max(0, Math.round((c - prev) * total)) });
    prev = c;
  }
  return out;
}
