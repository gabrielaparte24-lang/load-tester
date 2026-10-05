import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  benchOrder,
  bootstrapDiffCI,
  checkBaseline,
  clearBaseline,
  compareGroups,
  compareRuns,
  createRng,
  getBaseline,
  hodgesLehmann,
  holm,
  listBaselines,
  loadReport,
  mannWhitney,
  median,
  minAttainableP,
  parseScenario,
  quantile,
  ranks,
  runBench,
  setBaseline,
  stdev,
  twoProportionZ,
  type RunMetrics,
  type RunReport,
} from "../packages/core/src/index.js";
import { startDemo } from "./helpers.js";

/** Permutação exata ingênua, independente da implementação (para conferir o Mann-Whitney). */
function bruteForceP(a: number[], b: number[]): number {
  const all = [...a, ...b];
  const r = ranks(all);
  const n1 = a.length;
  const obs = r.slice(0, n1).reduce((x, y) => x + y, 0);
  const exp = (n1 * (all.length + 1)) / 2;
  let ext = 0;
  let tot = 0;
  const idx = all.map((_, i) => i);
  const combos = (k: number, start = 0, acc: number[] = []): void => {
    if (acc.length === k) {
      tot++;
      const s = acc.reduce((x, i) => x + r[i]!, 0);
      if (Math.abs(s - exp) >= Math.abs(obs - exp) - 1e-9) ext++;
      return;
    }
    for (let i = start; i < idx.length; i++) combos(k, i + 1, [...acc, i]);
  };
  combos(n1);
  return ext / tot;
}

describe("estatística descritiva", () => {
  it("quantis (tipo 7), mediana, desvio-padrão e postos com empates", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(quantile([1, 2, 3, 4, 5], 0.9)).toBeCloseTo(4.6, 10);
    expect(stdev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3);
    expect(ranks([10, 20, 20, 30])).toEqual([1, 2.5, 2.5, 4]);
  });
});

describe("Mann-Whitney U", () => {
  it("valores exatos conhecidos", () => {
    expect(mannWhitney([1, 2, 3, 4, 5], [6, 7, 8, 9, 10]).p).toBeCloseTo(2 / 252, 10);
    expect(mannWhitney([1, 2, 3], [4, 5, 6]).p).toBeCloseTo(0.1, 10);
    expect(mannWhitney([1, 2, 3, 4], [5, 6, 7, 8]).p).toBeCloseTo(2 / 70, 10);
    expect(mannWhitney([1, 2, 3], [1, 2, 3]).p).toBe(1);
    expect(minAttainableP(5, 5)).toBeCloseTo(2 / 252, 10);
  });

  it("confere com permutação ingênua, inclusive com empates", () => {
    const rng = createRng(4);
    for (let t = 0; t < 30; t++) {
      const n1 = 2 + Math.floor(rng() * 5);
      const n2 = 2 + Math.floor(rng() * 5);
      const a = Array.from({ length: n1 }, () => Math.round(rng() * 6));
      const b = Array.from({ length: n2 }, () => Math.round(rng() * 6) + (t % 3));
      expect(mannWhitney(a, b).p).toBeCloseTo(bruteForceP(a, b), 10);
    }
  });

  it("aproximação normal para amostras grandes", () => {
    const rng = createRng(8);
    const a = Array.from({ length: 200 }, () => rng());
    const b = Array.from({ length: 200 }, () => rng() + 0.5);
    const r = mannWhitney(a, b);
    expect(r.method).toBe("normal");
    expect(r.p).toBeLessThan(1e-6);
    expect(r.effect).toBeGreaterThan(0.5); // B tende a ser maior
    const c = Array.from({ length: 200 }, () => rng());
    expect(mannWhitney(a, c).p).toBeGreaterThan(0.01);
  });
});

describe("estimativas e correções", () => {
  it("Hodges-Lehmann e IC por bootstrap recuperam o deslocamento", () => {
    const rng = createRng(2);
    const a = Array.from({ length: 30 }, () => 100 + rng() * 10);
    const b = a.map((x) => x + 7);
    expect(hodgesLehmann(a, b)).toBeCloseTo(7, 5);
    const ci = bootstrapDiffCI(a, b);
    expect(ci.lo).toBeLessThan(7);
    expect(ci.hi).toBeGreaterThan(7);
    expect(bootstrapDiffCI(a, b)).toEqual(ci); // semente fixa → reprodutível
  });

  it("Holm-Bonferroni", () => {
    const adj = holm([0.01, 0.04, 0.03, 0.005]);
    expect(adj.map((x) => +x.toFixed(4))).toEqual([0.03, 0.06, 0.06, 0.02]);
  });

  it("z de duas proporções", () => {
    expect(twoProportionZ(50, 1000, 50, 1000)).toBeCloseTo(1, 6);
    expect(twoProportionZ(50, 1000, 100, 1000)).toBeLessThan(0.001);
  });

  it("ordem A/B contrabalançada", () => {
    expect(benchOrder("ab", 4)).toEqual(["A", "B", "B", "A", "A", "B", "B", "A"]);
    expect(benchOrder("single", 3)).toEqual(["A", "A", "A"]);
  });
});

const runs = (p50s: number[], extra: Partial<RunMetrics> = {}): RunMetrics[] =>
  p50s.map((p50) => ({
    p50,
    p90: p50 * 1.2,
    p95: p50 * 1.3,
    p99: p50 * 1.5,
    mean: p50,
    rps: 100,
    errorRate: 0,
    ...extra,
  }));

describe("comparação de grupos (rodadas)", () => {
  const A = runs([10, 10.2, 9.9, 10.1, 10]);
  it("diferença grande e separada → pior", () => {
    const r = compareGroups(
      { id: "a", scenario: "s", runs: A },
      { id: "b", scenario: "s", runs: runs([12, 12.1, 11.9, 12.2, 12]) },
    );
    expect(r.metrics.find((m) => m.metric === "p50")!.verdict).toBe("pior");
    expect(r.regression).toBe(true);
  });
  it("mesmos números → sem diferença detectável", () => {
    const r = compareGroups(
      { id: "a", scenario: "s", runs: A },
      { id: "b", scenario: "s", runs: runs([10.1, 9.9, 10, 10.2, 10]) },
    );
    expect(r.conclusion).toBe("sem diferença detectável");
  });
  it("separada mas abaixo do efeito mínimo → diferença pequena (não é regressão)", () => {
    const r = compareGroups(
      { id: "a", scenario: "s", runs: A },
      { id: "b", scenario: "s", runs: runs([10.3, 10.5, 10.4, 10.45, 10.35]) },
    );
    const p50 = r.metrics.find((m) => m.metric === "p50")!;
    expect(p50.pAdj).toBeLessThan(0.05);
    expect(p50.verdict).toBe("pequena");
    expect(r.regression).toBe(false);
  });
  it("avisa quando o α pedido é inalcançável com poucas rodadas", () => {
    const r = compareGroups(
      { id: "a", scenario: "s", runs: A },
      { id: "b", scenario: "s", runs: runs([20, 21, 22, 23, 24]) },
      { alpha: 0.01 },
    );
    expect(r.regression).toBe(false);
    expect(r.warnings.join(" ")).toMatch(/nenhuma diferença pode ser declarada/);
  });
});

/** Execução sintética: timeline com p50 por segundo (para testar compareRuns sem rede). */
function fakeRun(id: string, perSecond: number[], failed = 0): RunReport {
  const lat = (v: number) => ({
    count: 1,
    min: v,
    mean: v,
    stdev: 0,
    p50: v,
    p75: v,
    p90: v,
    p95: v,
    p99: v,
    p999: v,
    max: v,
  });
  const m = median(perSecond);
  return {
    run: { id, scenario: "s", status: "completed", invalid: false, model: "open" },
    config: { load: { stages: [], vuStages: [] } },
    summary: {
      latencyMs: lat(m),
      rps: { achieved: 100, requested: 100, sent: 100 },
      requests: { total: 1000, ok: 1000 - failed, failed },
      errorRate: failed / 1000,
    },
    timeline: perSecond.map((v, t) => ({
      t,
      warmup: false,
      rps: 100,
      errors: 0,
      latencyMs: { p50: v, p95: v * 1.2, p99: v * 1.5, max: v * 2 },
    })),
  } as unknown as RunReport;
}

describe("comparação de execuções únicas (blocos)", () => {
  const rng = createRng(11);
  const noise = (base: number) => Array.from({ length: 40 }, () => base + rng() * 2);
  it("detecta regressão clara e ignora ruído", () => {
    const a = fakeRun("a", noise(20));
    expect(compareRuns(a, fakeRun("b", noise(30))).regression).toBe(true);
    const same = compareRuns(a, fakeRun("c", noise(20)));
    expect(same.regression).toBe(false);
    expect(same.metrics.find((m) => m.metric === "p50")!.nA).toBe(8); // 40 s / blocos de 5 s
  });
  it("taxa de erro: teste de proporções e diferença mínima em pontos percentuais", () => {
    const a = fakeRun("a", noise(20), 0);
    expect(
      compareRuns(a, fakeRun("b", noise(20), 50)).metrics.find((m) => m.metric === "errorRate")!
        .verdict,
    ).toBe("pior");
    expect(
      compareRuns(a, fakeRun("b", noise(20), 2)).metrics.find((m) => m.metric === "errorRate")!
        .verdict,
    ).not.toBe("pior");
  });
  it("execução curta demais → amostra insuficiente", () => {
    const r = compareRuns(fakeRun("a", [10, 10, 10]), fakeRun("b", [20, 20, 20]));
    expect(r.conclusion).toMatch(/amostra insuficiente/);
  });
});

describe("baseline", () => {
  let dir: string;
  beforeAll(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "lt-bl-"))));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("salva, lê, lista, compara e remove", () => {
    const base = fakeRun(
      "base",
      Array.from({ length: 30 }, (_, i) => 20 + (i % 3) * 0.1),
    );
    setBaseline(dir, base, "reports/base/report.json");
    expect(listBaselines(dir).map((b) => b.scenario)).toEqual(["s"]);
    const entry = getBaseline(dir, "s")!;
    const slower = fakeRun(
      "cur",
      Array.from({ length: 30 }, (_, i) => 26 + (i % 3) * 0.1),
    );
    expect(checkBaseline(slower, entry, { thresholdPct: 10 }).regression).toBe(true);
    const slightly = fakeRun(
      "cur2",
      Array.from({ length: 30 }, (_, i) => 21 + (i % 3) * 0.1),
    );
    expect(checkBaseline(slightly, entry, { thresholdPct: 10 }).regression).toBe(false); // +5% < limite
    expect(clearBaseline(dir, "s")).toBe(true);
    expect(getBaseline(dir, "s")).toBeNull();
  });

  it("recusa execução inválida e carrega relatórios por caminho ou id", () => {
    const bad = fakeRun("x", [1, 2, 3]);
    (bad.run as { invalid: boolean }).invalid = true;
    expect(() => setBaseline(dir, bad, "x")).toThrow(/inválida/);
    const runDir = path.join(dir, "reports", "r1");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, "report.json"),
      JSON.stringify({ schemaVersion: 1, ...fakeRun("r1", [1]) }),
    );
    expect(loadReport("r1", path.join(dir, "reports")).report).toMatchObject({ run: { id: "r1" } });
    expect(() => loadReport("nao-existe", dir)).toThrow(/não encontrado/);
  });
});

describe("lt bench contra o demo-target", () => {
  let demo: Awaited<ReturnType<typeof startDemo>>;
  let out: string;
  beforeAll(async () => {
    demo = await startDemo();
    out = fs.mkdtempSync(path.join(os.tmpdir(), "lt-bench-"));
  });
  afterAll(async () => {
    await demo?.stop();
    fs.rmSync(out, { recursive: true, force: true });
  });

  const scenario = (ms: number, name: string) =>
    parseScenario(`
name: ${name}
seed: 5
target: { baseUrl: "${demo.url}" }
load: { warmup: 500ms, stages: [ { duration: 2500ms, rps: 40 } ] }
flow: [ { request: { path: "/slow?ms=${ms}" } } ]
`);
  const bench = (b: ReturnType<typeof scenario>) =>
    runBench({
      groups: [
        { label: "A", scenario: scenario(15, "a") },
        { label: "B", scenario: b },
      ],
      runs: 5,
      intervalMs: 0,
      reportsDir: out,
      toolVersion: "test",
      runOptions: { connections: 16, systemMetrics: false },
    });

  it("A/A: sem diferença relevante (honestidade contra falso positivo)", async () => {
    const { report, file } = await bench(scenario(15, "a"));
    expect(fs.existsSync(file)).toBe(true);
    expect(report.bench.order).toEqual([
      "A01",
      "B01",
      "B02",
      "A02",
      "A03",
      "B03",
      "B04",
      "A04",
      "A05",
      "B05",
    ]);
    expect(report.groups[0]!.summary.p50.n).toBe(5);
    expect(report.comparison!.regression).toBe(false);
    expect(report.comparison!.improvement).toBe(false);
  });

  it("A/B com +15 ms: regressão detectada em p50", async () => {
    const { report } = await bench(scenario(30, "b"));
    const p50 = report.comparison!.metrics.find((m) => m.metric === "p50")!;
    expect(p50.verdict).toBe("pior");
    expect(p50.ci.lo).toBeGreaterThan(10);
    expect(p50.ci.hi).toBeLessThan(20);
    expect(report.comparison!.regression).toBe(true);
  });
});
