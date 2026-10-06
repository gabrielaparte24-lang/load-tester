import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseScenario, runScenario, type RunReport } from "../packages/core/src/index.js";
import { startDemo } from "./helpers.js";

// Validação da própria ferramenta contra um alvo de comportamento conhecido.
let demo: Awaited<ReturnType<typeof startDemo>>;
beforeAll(async () => {
  demo = await startDemo();
});
afterAll(async () => {
  await demo?.stop();
});

const scenario = (load: string, path: string) =>
  parseScenario(`
name: teste
target: { baseUrl: "${demo.url}", timeoutMs: 5000 }
load:
${load}
flow:
  - request: { method: GET, path: "${path}" }
`);

const run = (sc: ReturnType<typeof parseScenario>, signal?: AbortSignal): Promise<RunReport> =>
  runScenario(sc, { toolVersion: "test", connections: 64, stopSignal: signal });

describe("motor de carga contra o demo-target", () => {
  it("taxa enviada fica dentro de ±2% da pedida", async () => {
    const r = await run(
      scenario(
        `  warmup: 1s\n  stages:\n    - { duration: 1s, rps: 400 }\n    - { duration: 6s, rps: 400 }`,
        "/fast",
      ),
    );
    expect(r.run.status).toBe("completed");
    expect(r.summary.iterations.scheduled).toBe(2400);
    expect(Math.abs(r.summary.rps.sent - 400) / 400).toBeLessThan(0.02);
    expect(Math.abs(r.summary.rps.achieved - 400) / 400).toBeLessThan(0.02);
    expect(r.summary.requests.failed).toBe(0);
  });

  it("percentis conferem com a latência conhecida (/slow?ms=100)", async () => {
    const r = await run(scenario(`  stages:\n    - { duration: 5s, rps: 50 }`, "/slow?ms=100"));
    const l = r.summary.latencyMs;
    expect(l.count).toBe(250);
    // Garantias da medição: nenhuma latência abaixo da conhecida e a mediana colada nela.
    expect(l.min).toBeGreaterThanOrEqual(100);
    expect(l.p50).toBeGreaterThanOrEqual(100);
    expect(l.p50).toBeLessThan(110);
    // Os percentis precisam ser coerentes entre si (cálculo do histograma).
    expect(l.p50).toBeLessThanOrEqual(l.p90);
    expect(l.p90).toBeLessThanOrEqual(l.p99);
    expect(l.p99).toBeLessThanOrEqual(l.max);
    // Cauda: com 250 amostras o p99 é a ~3ª maior latência, então pausas de runners compartilhados
    // (observado: 122 ms no GitHub Actions/Windows) não podem reprovar. A folga é grande de propósito;
    // a tolerância fina da cauda é validada manualmente (README, "Validação da própria ferramenta").
    expect(l.p99).toBeLessThan(200);
  });

  it("conta erros exatamente (/flaky?every=20 → 5%)", async () => {
    const r = await run(scenario(`  stages:\n    - { duration: 4s, rps: 250 }`, "/flaky?every=20"));
    expect(r.summary.requests.total).toBe(1000);
    expect(r.summary.errorRate).toBe(0.05);
    expect(r.summary.errorsByType.http_5xx).toBe(50);
    expect(r.summary.statusCodes).toEqual({ "200": 950, "500": 50 });
  });

  it("taxa de erro aleatória (/flaky?rate=0.05) fica a menos de 4σ de 5%", async () => {
    const r = await run(
      scenario(`  stages:\n    - { duration: 5s, rps: 800 }`, "/flaky?rate=0.05"),
    );
    const n = r.summary.requests.total;
    const sigma = Math.sqrt((0.05 * 0.95) / n);
    expect(Math.abs(r.summary.errorRate - 0.05)).toBeLessThan(4 * sigma);
  });

  it("classifica timeout e conexão recusada", async () => {
    const timeout = parseScenario(`
name: t
target: { baseUrl: "${demo.url}", timeoutMs: 200 }
load: { stages: [ { duration: 1s, rps: 5 } ] }
flow: [ { request: { path: "/slow?ms=1000" } } ]
`);
    const r1 = await run(timeout);
    expect(r1.summary.errorsByType.timeout).toBe(5);

    const refused = parseScenario(`
name: r
target: { baseUrl: "http://127.0.0.1:1" }
load: { stages: [ { duration: 1s, rps: 5 } ] }
flow: [ { request: { path: "/" } } ]
`);
    const r2 = await run(refused);
    expect(r2.summary.errorsByType.connection_refused).toBe(5);
  });

  it("kill switch: parada graciosa em poucos segundos com resultado parcial", async () => {
    const ac = new AbortController();
    const t0 = Date.now();
    setTimeout(() => ac.abort(), 1500);
    const r = await run(
      scenario(`  stages:\n    - { duration: 60s, rps: 100 }`, "/slow?ms=200"),
      ac.signal,
    );
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(3000);
    expect(r.run.status).toBe("interrupted");
    expect(r.summary.requests.total).toBeGreaterThan(100);
    expect(r.summary.requests.failed).toBe(0); // em andamento foram drenadas, não abortadas
  });

  it("relatório JSON tem o formato estável", async () => {
    const r = await run(scenario(`  stages:\n    - { duration: 1s, rps: 20 }`, "/fast"));
    expect(r.schemaVersion).toBe(1);
    expect(Object.keys(r)).toEqual([
      "schemaVersion",
      "tool",
      "run",
      "environment",
      "config",
      "summary",
      "steps",
      "timeline",
      "thresholds",
      "generator",
      "machine",
      "histograms",
    ]);
    expect(r.histograms.latencyUs.length).toBeGreaterThan(10);
    expect(r.timeline.length).toBeGreaterThanOrEqual(1);
  });
});
