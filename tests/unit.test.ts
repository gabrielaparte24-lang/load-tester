import { describe, expect, it } from "vitest";
import {
  ArrivalSchedule,
  ConfigError,
  evaluateThresholds,
  formatDuration,
  latencyStats,
  maskDeep,
  maskHeaders,
  newHistogram,
  parseDuration,
  parseThreshold,
  recordMs,
  resolveInside,
} from "../packages/core/src/index.js";

describe("parseDuration", () => {
  it("converte unidades e combinações", () => {
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("2m")).toBe(120_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(parseDuration("1m30s")).toBe(90_000);
    expect(parseDuration("1.5s")).toBe(1500);
  });
  it("recusa entradas ambíguas ou inválidas", () => {
    expect(() => parseDuration(30)).toThrow(ConfigError);
    expect(() => parseDuration("30")).toThrow(/não é uma duração válida/);
    expect(() => parseDuration("10x")).toThrow();
    expect(() => parseDuration("")).toThrow();
  });
  it("formata", () => {
    expect(formatDuration(500)).toBe("500ms");
    expect(formatDuration(90_000)).toBe("1m30s");
  });
});

describe("ArrivalSchedule (modelo aberto)", () => {
  const drain = (s: ArrivalSchedule) => {
    const out: number[] = [];
    for (let t = s.next(); t !== null; t = s.next()) out.push(t);
    return out;
  };

  it("taxa constante gera exatamente rps × duração chegadas, uniformes", () => {
    const times = drain(new ArrivalSchedule([{ durationMs: 10_000, rpsFrom: 100, rpsTo: 100 }]));
    expect(times).toHaveLength(1000);
    expect(times[0]).toBeCloseTo(5, 6); // ponto médio do primeiro intervalo
    expect(times[1]! - times[0]!).toBeCloseTo(10, 6);
    expect(times.at(-1)!).toBeLessThan(10_000);
  });

  it("rampa linear segue a integral da taxa", () => {
    const s = new ArrivalSchedule([{ durationMs: 120_000, rpsFrom: 50, rpsTo: 300 }]);
    const times = drain(s);
    expect(times).toHaveLength(21_000); // (50+300)/2 × 120
    // primeira metade: ∫0..60 (50 + 250t/120) dt = 3000 + 3750 = 6750
    expect(times.filter((t) => t < 60_000)).toHaveLength(6750);
    for (let i = 1; i < times.length; i++) expect(times[i]!).toBeGreaterThan(times[i - 1]!);
  });

  it("rampa a partir de 0 e múltiplas etapas encadeadas", () => {
    const s = new ArrivalSchedule([
      { durationMs: 10_000, rpsFrom: 0, rpsTo: 100 },
      { durationMs: 5_000, rpsFrom: 100, rpsTo: 100 },
      { durationMs: 10_000, rpsFrom: 100, rpsTo: 0 },
    ]);
    const times = drain(s);
    expect(times).toHaveLength(500 + 500 + 500);
    expect(s.peakRps).toBe(100);
    expect(s.countBetween(10_000, 15_000)).toBeCloseTo(500, 6);
    expect(s.rateAt(5_000)).toBeCloseTo(50, 6);
  });
});

describe("percentis com HdrHistogram", () => {
  it("bate com o percentil exato de uma distribuição conhecida (erro ≤ 0,1%)", () => {
    const h = newHistogram();
    const values: number[] = [];
    for (let i = 1; i <= 10_000; i++) {
      const v = i / 10; // 0,1 ms … 1000 ms
      values.push(v);
      recordMs(h, v);
    }
    const exact = (p: number) => values[Math.ceil((p / 100) * values.length) - 1]!;
    const s = latencyStats(h);
    for (const [p, got] of [
      [50, s.p50],
      [90, s.p90],
      [95, s.p95],
      [99, s.p99],
      [99.9, s.p999],
    ] as const) {
      expect(Math.abs(got - exact(p)) / exact(p)).toBeLessThan(0.001);
    }
    expect(s.max).toBeCloseTo(1000, 0);
    expect(s.mean).toBeCloseTo(500.05, 0);
    expect(s.count).toBe(10_000);
  });

  it("distribuição bimodal: a média esconde a cauda, os percentis não", () => {
    const h = newHistogram();
    for (let i = 0; i < 9_900; i++) recordMs(h, 10);
    for (let i = 0; i < 100; i++) recordMs(h, 1000);
    const s = latencyStats(h);
    expect(s.p50).toBeCloseTo(10, 1);
    expect(s.p99).toBeCloseTo(10, 1);
    expect(s.p999).toBeCloseTo(1000, -1);
    expect(s.mean).toBeCloseTo(19.9, 0);
  });
});

describe("thresholds", () => {
  it("interpreta unidades", () => {
    expect(parseThreshold("p95 < 300ms")).toMatchObject({ metric: "p95", op: "<", value: 300 });
    expect(parseThreshold("p99.9 <= 1s")).toMatchObject({ metric: "p99.9", value: 1000 });
    expect(parseThreshold("errorRate < 1%")).toMatchObject({ metric: "errorRate", value: 0.01 });
    expect(parseThreshold("errorRate < 0.02")).toMatchObject({ value: 0.02 });
    expect(parseThreshold("avg < 50ms")).toMatchObject({ metric: "mean" });
    expect(parseThreshold("rps >= 100")).toMatchObject({ metric: "rps", op: ">=", value: 100 });
  });
  it("recusa expressões inválidas", () => {
    expect(() => parseThreshold("p95 300ms")).toThrow(ConfigError);
    expect(() => parseThreshold("errorRate < 5")).toThrow();
    expect(() => parseThreshold("p95 < 5%")).toThrow();
    expect(() => parseThreshold("p101 < 5ms")).toThrow();
  });
  it("avalia aprovado/reprovado", () => {
    const res = evaluateThresholds(
      ["p95 < 300ms", "errorRate < 1%", "rps > 10"].map(parseThreshold),
      (m) => ({ p95: 250, errorRate: 0.02, rps: 10 })[m] ?? null,
    );
    expect(res.map((r) => r.passed)).toEqual([true, false, false]);
  });
});

describe("segredos", () => {
  it("mascara headers sensíveis e valores secretos em qualquer lugar", () => {
    expect(
      maskHeaders({ Authorization: "Bearer abc123", "X-Api-Key": "k", Accept: "json" }, []),
    ).toEqual({
      Authorization: "Bearer ***",
      "X-Api-Key": "***",
      Accept: "json",
    });
    const masked = maskDeep({ url: "http://h/?token=s3cr3t", nested: ["s3cr3t!"] }, ["s3cr3t"]);
    expect(JSON.stringify(masked)).not.toContain("s3cr3t");
  });
});

describe("caminhos", () => {
  it("recusa gravar fora do projeto", () => {
    expect(() => resolveInside("/proj", "../fora")).toThrow(/fora da pasta do projeto/);
    expect(resolveInside("/proj", "./reports").replace(/\\/g, "/")).toMatch(/\/proj\/reports$/);
  });
});
