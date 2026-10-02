import { describe, expect, it } from "vitest";
import {
  ScenarioError,
  checkTarget,
  enforceLimits,
  parseScenario,
} from "../packages/core/src/index.js";

const valid = `
name: checkout
target:
  baseUrl: http://localhost:3000/api/
  headers: { Authorization: "Bearer \${env.LT_TEST_TOKEN}" }
  timeoutMs: 5000
load:
  model: open
  warmup: 10s
  stages:
    - { duration: 30s, rps: 50 }
    - { duration: 2m, rps: 50 -> 300 }
thresholds: ["p95 < 300ms", "errorRate < 1%"]
flow:
  - name: listar
    request: { method: get, path: /products, query: { page: 2 } }
    expect: { status: 200 }
  - request: { method: POST, path: /cart, json: { id: 1 } }
    expect: { status: [200, 201], maxDuration: 500ms }
    think: 500ms
`;

describe("parser de cenários", () => {
  it("interpreta um cenário completo", () => {
    process.env.LT_TEST_TOKEN = "tok-123456";
    const sc = parseScenario(valid, "c.yaml");
    expect(sc.name).toBe("checkout");
    expect(sc.target.baseUrl).toBe("http://localhost:3000/api");
    expect(sc.target.headers.Authorization).toBe("Bearer tok-123456");
    expect(sc.secrets).toContain("tok-123456");
    expect(sc.load.stages).toEqual([
      { durationMs: 30_000, rpsFrom: 50, rpsTo: 50 },
      { durationMs: 120_000, rpsFrom: 50, rpsTo: 300 },
    ]);
    expect(sc.load.warmupMs).toBe(10_000);
    expect(sc.flow[0]!.request).toMatchObject({
      method: "GET",
      path: "/products",
      query: { page: "2" },
    });
    expect(sc.flow[1]!.name).toBe("POST /cart");
    expect(sc.flow[1]!.request.body).toBe('{"id":1}');
    expect(sc.flow[1]!.request.contentType).toBe("application/json");
    expect(sc.flow[1]!.expect).toEqual({ status: [200, 201], maxDurationMs: 500 });
    expect(sc.flow[1]!.thinkMs).toBe(500);
  });

  it("aponta linha e coluna de cada erro", () => {
    const bad = `name: x
target:
  baseUrl: ftp://nope
load:
  stages:
    - { duration: 30, rps: 50 }
    - { duration: 10s, rps: "muito" }
thresholds: ["p95 300ms"]
flow:
  - request: { method: FETCH, path: products }
    extra: 1
`;
    try {
      parseScenario(bad, "bad.yaml");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ScenarioError);
      const issues = (e as ScenarioError).issues;
      const byPath = Object.fromEntries(issues.map((i) => [i.path, i]));
      expect(byPath["target.baseUrl"]).toMatchObject({ line: 3 });
      expect(byPath["load.stages[0].duration"]!.message).toMatch(/unidade/);
      expect(byPath["load.stages[0].duration"]).toMatchObject({ line: 6 });
      expect(byPath["load.stages[1].rps"]).toMatchObject({ line: 7 });
      expect(byPath["thresholds[0]"]).toMatchObject({ line: 8 });
      expect(byPath["flow[0].request.method"]).toMatchObject({ line: 10 });
      expect(byPath["flow[0].request.path"]!.message).toMatch(/começar com/);
      expect(byPath["flow[0].extra"]!.message).toMatch(/campo desconhecido/);
      expect((e as Error).message).toMatch(/linha 3, coluna \d+: target.baseUrl/);
    }
  });

  it("reporta YAML malformado com posição", () => {
    expect(() => parseScenario("name: [x\n", "x.yaml")).toThrow(/linha \d+/);
  });

  it("exige variáveis de ambiente definidas", () => {
    delete process.env.LT_TEST_MISSING;
    expect(() =>
      parseScenario(valid.replace("LT_TEST_TOKEN", "LT_TEST_MISSING"), "c.yaml"),
    ).toThrow(/LT_TEST_MISSING não definida/);
  });
});

describe("segurança", () => {
  it("allowlist: loopback sempre; IPs privados só via ALLOWED_TARGETS", async () => {
    expect((await checkTarget("http://localhost:3000", [])).allowed).toBe(true);
    expect((await checkTarget("http://127.0.0.1:3000", [])).allowed).toBe(true);
    expect((await checkTarget("http://[::1]:3000", [])).allowed).toBe(true);
    expect((await checkTarget("http://10.1.2.3", [])).allowed).toBe(false);
    expect((await checkTarget("http://10.1.2.3", ["10.0.0.0/8"])).allowed).toBe(true);
    expect((await checkTarget("http://192.168.1.10", ["10.0.0.0/8"])).allowed).toBe(false);
    expect((await checkTarget("http://api.interna.test", ["*.interna.test"])).allowed).toBe(true);
    expect((await checkTarget("http://93.184.215.14", [])).allowed).toBe(false);
  });

  it("aplica tetos de RPS, conexões e duração", () => {
    process.env.LT_TEST_TOKEN = "x";
    const sc = parseScenario(valid);
    expect(() =>
      enforceLimits(sc, { maxRps: 100, maxConnections: 512, maxDurationMs: 3_600_000 }),
    ).toThrow(/300 rps excede/);
    expect(() =>
      enforceLimits(sc, { maxRps: 1000, maxConnections: 512, maxDurationMs: 60_000 }),
    ).toThrow(/duração/);
    expect(
      enforceLimits(sc, { maxRps: 1000, maxConnections: 512, maxDurationMs: 3_600_000 }),
    ).toMatchObject({
      peakRps: 300,
      durationMs: 150_000,
    });
  });
});
