import { performance } from "node:perf_hooks";

/**
 * Agendador de alta precisão.
 *
 * No Windows, setTimeout tem granularidade de ~15,6 ms (medido: setTimeout(1) dispara
 * ~15 ms depois). Como a latência é medida a partir do instante em que a requisição
 * *deveria* ter saído, esse atraso viraria latência fantasma. Estratégia híbrida:
 * dorme com setTimeout até `margin` ms antes do prazo e faz a aproximação final com
 * setImmediate (precisão de microssegundos, ao custo de CPU durante a aproximação).
 */
export const TIMER_MARGIN_MS = process.platform === "win32" ? 17 : 2;

interface Entry {
  at: number;
  fn: () => void;
}

export class PreciseScheduler {
  private heap: Entry[] = [];
  private timer: NodeJS.Timeout | null = null;
  private timerAt = Infinity;
  private immediate: NodeJS.Immediate | null = null;

  constructor(private readonly margin = TIMER_MARGIN_MS) {}

  /** Agenda `fn` para o instante absoluto `at` (relógio de performance.now()). */
  at(at: number, fn: () => void): void {
    this.push({ at, fn });
    this.arm();
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.at(performance.now() + ms, resolve));
  }

  get pending(): number {
    return this.heap.length;
  }

  clear(): void {
    this.heap = [];
    this.disarm();
  }

  private pump = (): void => {
    this.immediate = null;
    this.timer = null;
    this.timerAt = Infinity;
    let now = performance.now();
    while (this.heap.length && this.heap[0]!.at <= now) {
      const entry = this.pop()!;
      entry.fn();
      now = performance.now();
    }
    this.arm();
  };

  private arm(): void {
    if (!this.heap.length) {
      this.disarm();
      return;
    }
    if (this.immediate) return; // já em aproximação fina; o próximo pump verá a nova entrada
    const delay = this.heap[0]!.at - performance.now();
    if (delay <= this.margin) {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
        this.timerAt = Infinity;
      }
      this.immediate = setImmediate(this.pump);
      return;
    }
    const wakeAt = this.heap[0]!.at - this.margin;
    if (this.timer && this.timerAt <= wakeAt) return;
    if (this.timer) clearTimeout(this.timer);
    this.timerAt = wakeAt;
    this.timer = setTimeout(this.pump, delay - this.margin);
  }

  private disarm(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.immediate) clearImmediate(this.immediate);
    this.timer = null;
    this.immediate = null;
    this.timerAt = Infinity;
  }

  private push(e: Entry): void {
    const h = this.heap;
    h.push(e);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (h[p]!.at <= e.at) break;
      h[i] = h[p]!;
      i = p;
    }
    h[i] = e;
  }

  private pop(): Entry | undefined {
    const h = this.heap;
    const top = h[0];
    const last = h.pop()!;
    if (!h.length) return top;
    const n = h.length;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = -1;
      let best = last.at;
      if (l < n && h[l]!.at < best) {
        m = l;
        best = h[l]!.at;
      }
      if (r < n && h[r]!.at < best) m = r;
      if (m < 0) break;
      h[i] = h[m]!;
      i = m;
    }
    h[i] = last;
    return top;
  }
}
