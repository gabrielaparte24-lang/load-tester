/** Etapa do modelo aberto: taxa de chegada que varia linearmente de rpsFrom a rpsTo. */
export interface RateStage {
  durationMs: number;
  rpsFrom: number;
  rpsTo: number;
}

/**
 * Gera os instantes de chegada (ms desde o início) de um processo de chegada
 * determinístico com taxa r(t) linear por etapa.
 *
 * A k-ésima chegada (k = 0, 1, 2…) acontece quando a contagem acumulada
 * N(t) = ∫ r(t) dt atinge k + ½ (ponto médio: funciona também para rampas que partem de 0). Dentro de uma etapa de duração T com taxa de r0 a r1:
 *   N(t) = r0·t + (r1 − r0)·t² / (2T)
 * e resolvemos a equação de 2º grau na forma numericamente estável
 *   t = 2n / (r0 + √(r0² + 2n(r1 − r0)/T)).
 * Assim uma etapa de 10 s a 100 rps gera exatamente 1000 chegadas.
 */
export class ArrivalSchedule {
  private stageIndex = 0;
  private stageStartMs = 0;
  private stageBaseCount = 0;
  private k = 0;
  readonly totalMs: number;
  readonly expectedCount: number;

  constructor(readonly stages: RateStage[]) {
    this.totalMs = stages.reduce((s, st) => s + st.durationMs, 0);
    this.expectedCount = Math.round(stages.reduce((s, st) => s + stageCount(st), 0));
  }

  /** Instante (ms) da próxima chegada, ou null quando o cronograma terminou. */
  next(): number | null {
    while (this.stageIndex < this.stages.length) {
      const st = this.stages[this.stageIndex]!;
      const n = this.k + 0.5 - this.stageBaseCount;
      const t = timeForCount(st, n);
      if (t !== null && t < st.durationMs) {
        this.k++;
        return this.stageStartMs + t;
      }
      this.stageBaseCount += stageCount(st);
      this.stageStartMs += st.durationMs;
      this.stageIndex++;
    }
    return null;
  }

  /** Taxa pedida (rps) no instante t (ms). */
  rateAt(tMs: number): number {
    let start = 0;
    for (const st of this.stages) {
      if (tMs < start + st.durationMs) {
        const f = st.durationMs ? (tMs - start) / st.durationMs : 0;
        return st.rpsFrom + (st.rpsTo - st.rpsFrom) * f;
      }
      start += st.durationMs;
    }
    return 0;
  }

  /** Índice da etapa vigente no instante t (ms); -1 após o fim. */
  stageAt(tMs: number): number {
    let start = 0;
    for (let i = 0; i < this.stages.length; i++) {
      start += this.stages[i]!.durationMs;
      if (tMs < start) return i;
    }
    return -1;
  }

  /** Número de chegadas pedidas no intervalo [a, b) ms. */
  countBetween(aMs: number, bMs: number): number {
    return cumulative(this.stages, bMs) - cumulative(this.stages, aMs);
  }

  get peakRps(): number {
    return Math.max(0, ...this.stages.map((s) => Math.max(s.rpsFrom, s.rpsTo)));
  }
}

function stageCount(st: RateStage): number {
  return ((st.rpsFrom + st.rpsTo) / 2) * (st.durationMs / 1000);
}

function cumulative(stages: RateStage[], tMs: number): number {
  let total = 0;
  let start = 0;
  for (const st of stages) {
    if (tMs <= start) break;
    const dt = Math.min(tMs - start, st.durationMs) / 1000;
    const T = st.durationMs / 1000;
    total += st.rpsFrom * dt + (T ? ((st.rpsTo - st.rpsFrom) * dt * dt) / (2 * T) : 0);
    start += st.durationMs;
  }
  return total;
}

/** Tempo (ms, relativo ao início da etapa) em que a contagem acumulada atinge n. */
function timeForCount(st: RateStage, n: number): number | null {
  const r0 = st.rpsFrom;
  const T = st.durationMs / 1000;
  const slope = T ? (st.rpsTo - r0) / T : 0;
  const disc = r0 * r0 + 2 * n * slope;
  if (disc < 0) return null; // rampa de descida que termina antes de atingir n
  const denom = r0 + Math.sqrt(disc);
  if (denom <= 0) return null;
  return ((2 * n) / denom) * 1000;
}
