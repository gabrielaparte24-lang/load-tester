import type { RunReport } from "./report.js";
import {
  bootstrapDiffCI,
  holm,
  hodgesLehmann,
  mannWhitney,
  median,
  twoProportionZ,
  type Interval,
} from "./stats/stats.js";

export type Verdict = "pior" | "melhor" | "pequena" | "sem diferença" | "amostra insuficiente";

export interface MetricComparison {
  metric: string;
  label: string;
  unit: "ms" | "req/s" | "%";
  better: "lower" | "higher";
  /** Valor de A e de B (execução única: resumo da execução; benchmark: mediana das rodadas). */
  a: number;
  b: number;
  delta: number;
  /** Variação relativa (B − A) / A em %; null quando A = 0. */
  deltaPct: number | null;
  /** Deslocamento estimado B − A nas amostras (Hodges-Lehmann). */
  estimate: number;
  /** IC 95% da diferença de medianas (B − A), por bootstrap. */
  ci: Interval;
  p: number;
  /** p ajustado por Holm sobre todas as métricas comparadas. */
  pAdj: number;
  test: string;
  nA: number;
  nB: number;
  verdict: Verdict;
}

export interface ComparisonOptions {
  /** Nível de significância (padrão 0,05). */
  alpha?: number;
  /** Efeito mínimo relevante em % para latência e vazão (padrão 5%). */
  minEffectPct?: number;
  /** Diferença absoluta mínima de latência em ms (padrão 1 ms). */
  minAbsMs?: number;
  /** Diferença mínima de taxa de erro em pontos percentuais (padrão 0,5 pp). */
  minErrorPp?: number;
  /** Tamanho do bloco (s) ao comparar execuções únicas (padrão 5). */
  blockSeconds?: number;
}

export interface ComparisonResult {
  kind: "runs" | "bench";
  a: { label: string; id: string; scenario: string; n: number };
  b: { label: string; id: string; scenario: string; n: number };
  method: string;
  alpha: number;
  minEffectPct: number;
  metrics: MetricComparison[];
  /** Alguma métrica significativamente e relevantemente PIOR em B. */
  regression: boolean;
  improvement: boolean;
  conclusion: string;
  warnings: string[];
}

/** Métricas por rodada usadas nos benchmarks (unidade de análise = rodada). */
export interface RunMetrics {
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  mean: number;
  rps: number;
  errorRate: number;
}

const LAT = ["p50", "p95", "p99"] as const;
const LABEL: Record<string, string> = {
  p50: "latência p50",
  p90: "latência p90",
  p95: "latência p95",
  p99: "latência p99",
  mean: "latência média",
  rps: "vazão",
  errorRate: "taxa de erro",
};

function defaults(o: ComparisonOptions) {
  return {
    alpha: o.alpha ?? 0.05,
    minEffectPct: o.minEffectPct ?? 5,
    minAbsMs: o.minAbsMs ?? 1,
    minErrorPp: o.minErrorPp ?? 0.5,
    blockSeconds: o.blockSeconds ?? 5,
  };
}

function verdictFor(m: MetricComparison, o: ReturnType<typeof defaults>, minN: number): Verdict {
  if (m.nA < minN || m.nB < minN) return "amostra insuficiente";
  if (!(m.pAdj < o.alpha)) return "sem diferença";
  const worse = m.better === "lower" ? m.delta > 0 : m.delta < 0;
  let relevant: boolean;
  if (m.metric === "errorRate") relevant = Math.abs(m.delta) * 100 >= o.minErrorPp;
  else {
    const rel = m.deltaPct === null ? Infinity : Math.abs(m.deltaPct);
    relevant = rel >= o.minEffectPct && (m.unit !== "ms" || Math.abs(m.delta) >= o.minAbsMs);
  }
  if (!relevant) return "pequena";
  return worse ? "pior" : "melhor";
}

function finish(
  base: Omit<ComparisonResult, "regression" | "improvement" | "conclusion" | "metrics">,
  metrics: Omit<MetricComparison, "pAdj" | "verdict">[],
  o: ReturnType<typeof defaults>,
  minN: number,
): ComparisonResult {
  const adj = holm(metrics.map((m) => m.p));
  const full: MetricComparison[] = metrics.map((m, i) => {
    const mm = { ...m, pAdj: adj[i]!, verdict: "sem diferença" as Verdict };
    mm.verdict = verdictFor(mm, o, minN);
    return mm;
  });
  const worse = full.filter((m) => m.verdict === "pior");
  const better = full.filter((m) => m.verdict === "melhor");
  const insufficient = full.every((m) => m.verdict === "amostra insuficiente");
  let conclusion: string;
  if (insufficient)
    conclusion = "amostra insuficiente para concluir (rode mais tempo ou use lt bench)";
  else if (worse.length) {
    conclusion = `REGRESSÃO em B: ${worse.map((m) => m.label).join(", ")}`;
    if (better.length) conclusion += `; melhora em ${better.map((m) => m.label).join(", ")}`;
  } else if (better.length) conclusion = `B é melhor em: ${better.map((m) => m.label).join(", ")}`;
  else conclusion = "sem diferença detectável";
  return {
    ...base,
    metrics: full,
    regression: worse.length > 0,
    improvement: better.length > 0,
    conclusion,
  };
}

const pct = (a: number, b: number) => (a === 0 ? null : ((b - a) / Math.abs(a)) * 100);

/** Diferenças de configuração que tornam a comparação menos significativa. */
function configWarnings(a: RunReport, b: RunReport): string[] {
  const w: string[] = [];
  if (a.run.scenario !== b.run.scenario)
    w.push(`cenários diferentes ("${a.run.scenario}" × "${b.run.scenario}")`);
  if (a.run.model !== b.run.model)
    w.push(`modelos de carga diferentes (${a.run.model} × ${b.run.model})`);
  if (
    JSON.stringify(a.config.load.stages) !== JSON.stringify(b.config.load.stages) ||
    JSON.stringify(a.config.load.vuStages) !== JSON.stringify(b.config.load.vuStages)
  ) {
    w.push("cargas configuradas diferentes: a comparação mede também a diferença de carga");
  }
  for (const [l, r] of [
    ["A", a],
    ["B", b],
  ] as const) {
    if (r.run.invalid)
      w.push(`${l} foi marcada inválida (gerador saturado): os números não representam o alvo`);
    if (r.run.status !== "completed") w.push(`${l} não terminou normalmente (${r.run.status})`);
  }
  return w;
}

/**
 * Compara duas execuções únicas. Requisições de uma mesma execução não são independentes, então
 * as amostras são BLOCOS de N segundos da linha do tempo (após o aquecimento). Sem rodadas
 * repetidas, a variação entre execuções é desconhecida: para conclusões robustas, use lt bench.
 */
export function compareRuns(
  a: RunReport,
  b: RunReport,
  opts: ComparisonOptions = {},
): ComparisonResult {
  const o = defaults(opts);
  const blocks = (r: RunReport) => {
    const pts = r.timeline.filter((p) => !p.warmup && p.rps > 0);
    const out: { p50: number; p95: number; p99: number; rps: number }[] = [];
    for (let i = 0; i + o.blockSeconds <= pts.length; i += o.blockSeconds) {
      const g = pts.slice(i, i + o.blockSeconds);
      out.push({
        p50: median(g.map((p) => p.latencyMs.p50)),
        p95: median(g.map((p) => p.latencyMs.p95)),
        p99: median(g.map((p) => p.latencyMs.p99)),
        rps: g.reduce((s, p) => s + p.rps, 0) / g.length,
      });
    }
    return out;
  };
  const ba = blocks(a);
  const bb = blocks(b);
  const metrics: Omit<MetricComparison, "pAdj" | "verdict">[] = [];
  for (const k of LAT) {
    const xa = ba.map((x) => x[k]);
    const xb = bb.map((x) => x[k]);
    const va = a.summary.latencyMs[k];
    const vb = b.summary.latencyMs[k];
    const mw = mannWhitney(xa, xb);
    metrics.push({
      metric: k,
      label: LABEL[k]!,
      unit: "ms",
      better: "lower",
      a: va,
      b: vb,
      delta: vb - va,
      deltaPct: pct(va, vb),
      estimate: hodgesLehmann(xa, xb),
      ci: bootstrapDiffCI(xa, xb),
      p: mw.p,
      test: `Mann-Whitney (${mw.method})`,
      nA: xa.length,
      nB: xb.length,
    });
  }
  const ra = ba.map((x) => x.rps);
  const rb = bb.map((x) => x.rps);
  const mwr = mannWhitney(ra, rb);
  metrics.push({
    metric: "rps",
    label: LABEL.rps!,
    unit: "req/s",
    better: "higher",
    a: a.summary.rps.achieved,
    b: b.summary.rps.achieved,
    delta: b.summary.rps.achieved - a.summary.rps.achieved,
    deltaPct: pct(a.summary.rps.achieved, b.summary.rps.achieved),
    estimate: hodgesLehmann(ra, rb),
    ci: bootstrapDiffCI(ra, rb),
    p: mwr.p,
    test: `Mann-Whitney (${mwr.method})`,
    nA: ra.length,
    nB: rb.length,
  });
  // taxa de erro: proporção sobre todas as requisições (teste z de duas proporções)
  const ea = a.summary.requests;
  const eb = b.summary.requests;
  const pa = ea.total ? ea.failed / ea.total : 0;
  const pb = eb.total ? eb.failed / eb.total : 0;
  const se = Math.sqrt(
    (ea.total ? (pa * (1 - pa)) / ea.total : 0) + (eb.total ? (pb * (1 - pb)) / eb.total : 0),
  );
  metrics.push({
    metric: "errorRate",
    label: LABEL.errorRate!,
    unit: "%",
    better: "lower",
    a: pa,
    b: pb,
    delta: pb - pa,
    deltaPct: pct(pa, pb),
    estimate: pb - pa,
    ci: { lo: pb - pa - 1.96 * se, hi: pb - pa + 1.96 * se },
    p: twoProportionZ(ea.failed, ea.total, eb.failed, eb.total),
    test: "z de duas proporções",
    nA: ba.length,
    nB: bb.length,
  });

  const warnings = configWarnings(a, b);
  warnings.push(
    "comparação de execuções únicas: a variação entre execuções não é conhecida. Para uma conclusão robusta use lt bench (≥ 5 rodadas) ou lt bench --ab.",
  );
  return finish(
    {
      kind: "runs",
      a: { label: "A", id: a.run.id, scenario: a.run.scenario, n: ba.length },
      b: { label: "B", id: b.run.id, scenario: b.run.scenario, n: bb.length },
      method: `blocos de ${o.blockSeconds} s da linha do tempo; Mann-Whitney U; IC 95% por bootstrap; Holm sobre ${metrics.length} métricas; α = ${o.alpha}; efeito mínimo ${o.minEffectPct}%`,
      alpha: o.alpha,
      minEffectPct: o.minEffectPct,
      warnings,
    },
    metrics,
    o,
    3,
  );
}

/** Compara dois grupos de rodadas (unidade de análise = rodada; ≥ 5 por grupo recomendado). */
export function compareGroups(
  a: { id: string; scenario: string; runs: RunMetrics[] },
  b: { id: string; scenario: string; runs: RunMetrics[] },
  opts: ComparisonOptions = {},
  extraWarnings: string[] = [],
): ComparisonResult {
  const o = defaults(opts);
  const keys = ["p50", "p95", "p99", "rps", "errorRate"] as const;
  const metrics = keys.map((k) => {
    const xa = a.runs.map((r) => r[k]);
    const xb = b.runs.map((r) => r[k]);
    const va = median(xa);
    const vb = median(xb);
    const mw = mannWhitney(xa, xb);
    return {
      metric: k,
      label: LABEL[k]!,
      unit: (k === "rps" ? "req/s" : k === "errorRate" ? "%" : "ms") as MetricComparison["unit"],
      better: (k === "rps" ? "higher" : "lower") as MetricComparison["better"],
      a: va,
      b: vb,
      delta: vb - va,
      deltaPct: pct(va, vb),
      estimate: hodgesLehmann(xa, xb),
      ci: bootstrapDiffCI(xa, xb),
      p: mw.p,
      test: `Mann-Whitney (${mw.method})`,
      nA: xa.length,
      nB: xb.length,
    };
  });
  const warnings = [...extraWarnings];
  if (a.runs.length < 5 || b.runs.length < 5) {
    warnings.push("menos de 5 rodadas válidas por grupo: o teste tem pouco poder estatístico.");
  }
  // Com poucas rodadas, nem uma separação perfeita alcança α após a correção de Holm.
  const minP = minAttainableP(a.runs.length, b.runs.length) * keys.length;
  if (a.runs.length && b.runs.length && minP >= o.alpha) {
    warnings.push(
      `com ${a.runs.length} × ${b.runs.length} rodadas o menor p possível (após Holm) é ${minP.toFixed(3)} ≥ α = ${o.alpha}: nenhuma diferença pode ser declarada. Aumente --runs.`,
    );
  } else if (a.runs.length && b.runs.length && minP > o.alpha / 2) {
    warnings.push(
      `com ${a.runs.length} × ${b.runs.length} rodadas só uma separação completa entre os grupos é detectável (menor p após Holm = ${minP.toFixed(3)}); 7–10 rodadas dão mais poder.`,
    );
  }
  return finish(
    {
      kind: "bench",
      a: { label: "A", id: a.id, scenario: a.scenario, n: a.runs.length },
      b: { label: "B", id: b.id, scenario: b.scenario, n: b.runs.length },
      method: `uma amostra por rodada; Mann-Whitney U exato; deslocamento de Hodges-Lehmann; IC 95% por bootstrap; Holm sobre ${metrics.length} métricas; α = ${o.alpha}; efeito mínimo ${o.minEffectPct}%`,
      alpha: o.alpha,
      minEffectPct: o.minEffectPct,
      warnings,
    },
    metrics,
    o,
    3,
  );
}

/** Menor p bilateral exato possível no Mann-Whitney com n1 × n2 (separação total): 2 / C(n1+n2, n1). */
export function minAttainableP(n1: number, n2: number): number {
  let c = 1;
  for (let i = 1; i <= n1; i++) c = (c * (n2 + i)) / i;
  return Math.min(1, 2 / c);
}

export function runMetrics(r: RunReport): RunMetrics {
  const l = r.summary.latencyMs;
  return {
    p50: l.p50,
    p90: l.p90,
    p95: l.p95,
    p99: l.p99,
    mean: l.mean,
    rps: r.summary.rps.achieved,
    errorRate: r.summary.errorRate,
  };
}
