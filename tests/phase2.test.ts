import fs from "node:fs";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  nextActivation,
  parseScenario,
  resolveWorkers,
  runScenario,
  vusAt,
  type RunOptions,
  type RunReport,
} from "../packages/core/src/index.js";
import { ROOT, startDemo } from "./helpers.js";

const TLS = path.join(ROOT, "tests/fixtures/tls");
let demo: Awaited<ReturnType<typeof startDemo>>;
let tlsServer: http2.Http2SecureServer;
let tlsUrl: string;

beforeAll(async () => {
  demo = await startDemo();
  tlsServer = http2.createSecureServer(
    {
      key: fs.readFileSync(path.join(TLS, "server-key.pem")),
      cert: fs.readFileSync(path.join(TLS, "server.pem")),
      allowHTTP1: true,
    },
    (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: req.httpVersion }));
    },
  );
  await new Promise<void>((r) => tlsServer.listen(0, "127.0.0.1", r));
  tlsUrl = `https://localhost:${(tlsServer.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await demo?.stop();
  await new Promise((r) => tlsServer?.close(r));
});

const run = (yaml: string, opts: Partial<RunOptions> = {}, baseDir?: string): Promise<RunReport> =>
  runScenario(parseScenario(yaml, undefined, { baseDir }), {
    toolVersion: "test",
    connections: 32,
    systemMetrics: false,
    ...opts,
  });

describe("agenda de VUs (modelo fechado)", () => {
  const stages = [
    { durationMs: 10_000, vusFrom: 0, vusTo: 10 },
    { durationMs: 5_000, vusFrom: 10, vusTo: 10 },
    { durationMs: 10_000, vusFrom: 10, vusTo: 0 },
  ];
  it("interpola e encontra a ativação de cada VU", () => {
    expect(vusAt(stages, 5_000)).toBe(5);
    expect(vusAt(stages, 20_000)).toBe(5);
    expect(nextActivation(stages, 0, 0)).toBeCloseTo(0, 1);
    expect(nextActivation(stages, 4, 0)).toBeCloseTo(4_000, 0);
    expect(nextActivation(stages, 9, 0)).toBeCloseTo(9_000, 0);
    expect(nextActivation(stages, 9, 21_000)).toBeNull(); // na descida, o VU 9 não volta
    expect(nextActivation(stages, 10, 0)).toBeNull();
  });
});

describe("workers", () => {
  it("auto escala pela carga; explícito prevalece", () => {
    const sc = (rps: number, workers = "auto") =>
      parseScenario(`
name: w
target: { baseUrl: "http://127.0.0.1:1" }
load: { workers: ${workers}, stages: [ { duration: 1s, rps: ${rps} } ] }
flow: [ { request: { path: / } } ]
`);
    expect(resolveWorkers(sc(100))).toBe(1);
    expect(resolveWorkers(sc(3000))).toBeGreaterThanOrEqual(Math.min(2, 1));
    expect(resolveWorkers(sc(100, "3"))).toBe(3);
    expect(resolveWorkers(sc(100), 2)).toBe(2);
  });

  it("com a mesma semente, 1 ou 3 workers geram exatamente os mesmos dados", async () => {
    const yaml = `
name: repro
seed: 99
target: { baseUrl: "${demo.url}" }
load: { stages: [ { duration: 3s, rps: 100 } ] }
variables: { n: "\${randInt(1, 100)}" }
flow:
  - request: { path: "/echo?n=\${n}" }
    expect: { jsonPath: { "$.query.n": "<= 50" } }
`;
    const one = await run(yaml, { workers: 1 });
    const three = await run(yaml, { workers: 3 });
    expect(three.generator.workers).toBe(3);
    expect(three.summary.requests.total).toBe(300);
    expect(one.summary.requests.total).toBe(300);
    // as falhas dependem só de (seed, índice da iteração): idênticas
    expect(three.summary.errorsByType.check_failed).toBe(one.summary.errorsByType.check_failed);
    expect(one.summary.errorsByType.check_failed).toBeGreaterThan(100);
    expect(Math.abs(three.summary.rps.sent - 100)).toBeLessThan(2);
  });
});

describe("protocolos e fases", () => {
  it("HTTP/2 sem TLS (h2c) contra o demo-target", async () => {
    const r = await run(`
name: h2c
target: { baseUrl: "${demo.h2Url}", http2: true }
load: { stages: [ { duration: 2s, rps: 50 } ] }
flow: [ { request: { path: "/products?page=2" }, expect: { status: 200, jsonPath: { "$.page": 2 } } } ]
`);
    expect(r.summary.requests.failed).toBe(0);
    expect(r.summary.connections.byProtocol).toEqual({ h2: 1 }); // multiplexado numa conexão
    expect(r.config.target.http2).toBe(true);
  });

  it("HTTPS com CA própria: TLS medido, h2 via ALPN ou HTTP/1.1", async () => {
    const yaml = (h2: boolean) => `
name: tls
target: { baseUrl: "${tlsUrl}", http2: ${h2}, tls: { ca: ca.pem } }
load: { stages: [ { duration: 1s, rps: 20 } ] }
flow: [ { request: { path: / }, expect: { jsonPath: { "$.version": "${h2 ? "2.0" : "1.1"}" } } } ]
`;
    const h2 = await run(yaml(true), {}, TLS);
    expect(h2.summary.requests.failed).toBe(0);
    expect(Object.keys(h2.summary.connections.byProtocol)).toEqual(["h2"]);
    expect(h2.summary.connections.tlsMs.max).toBeGreaterThan(0);
    expect(h2.summary.connections.dnsMs.max).toBeGreaterThanOrEqual(0); // "localhost" passa por DNS

    const h1 = await run(yaml(false), {}, TLS);
    expect(h1.summary.requests.failed).toBe(0);
    expect(Object.keys(h1.summary.connections.byProtocol)).toEqual(["http/1.1"]);
  });

  it("sem a CA, o certificado é rejeitado (nada de modo inseguro)", async () => {
    const r = await run(`
name: tls-sem-ca
target: { baseUrl: "${tlsUrl}" }
load: { stages: [ { duration: 1s, rps: 5 } ] }
flow: [ { request: { path: / } } ]
`);
    expect(r.summary.requests.failed).toBe(r.summary.requests.total);
    expect(r.steps[0]!.failures[0]!.message).toMatch(/certificate|certificado/i);
  });

  it("TTFB e download separados", async () => {
    const r = await run(`
name: fases
target: { baseUrl: "${demo.url}" }
load: { stages: [ { duration: 2s, rps: 10 } ] }
flow:
  - request: { path: "/slow?ms=80" }
  - request: { path: "/bytes?n=2000000" }
`);
    expect(r.summary.ttfbMs.p50).toBeGreaterThan(0.1);
    expect(r.summary.ttfbMs.max).toBeGreaterThanOrEqual(80);
    expect(r.summary.downloadMs.max).toBeGreaterThan(0.5); // 2 MB não chegam num único pedaço
    expect(r.summary.connections.opened).toBeGreaterThan(0);
  });
});

describe("modelo fechado", () => {
  it("rampa de VUs aparece na linha do tempo e a vazão segue os VUs", async () => {
    const r = await run(`
name: closed
target: { baseUrl: "${demo.url}" }
load:
  model: closed
  stages:
    - { duration: 3s, vus: 0 -> 9 }
    - { duration: 3s, vus: 9 }
flow: [ { request: { path: "/slow?ms=100" } } ]
`);
    expect(r.run.model).toBe("closed");
    expect(r.summary.rps.requested).toBeNull();
    expect(r.summary.maxConcurrency).toBe(9);
    const steady = r.timeline.filter((p) => p.t >= 3 && p.t <= 5);
    for (const p of steady) {
      expect(p.concurrency).toBe(9);
      expect(p.rps).toBeGreaterThan(80); // 9 VUs / 0,1 s ≈ 90 req/s
      expect(p.rps).toBeLessThan(95);
    }
    expect(r.run.warnings.join(" ")).toMatch(/sem pacing/);
  });

  it("teto de RPS segura VUs rápidos e avisa", async () => {
    const r = await run(
      `
name: teto
target: { baseUrl: "${demo.url}" }
load: { model: closed, stages: [ { duration: 3s, vus: 30 } ] }
flow: [ { request: { path: /fast } } ]
`,
      { maxRps: 200 },
    );
    expect(r.summary.rps.achieved).toBeLessThan(200 * 1.1);
    expect(r.summary.rps.achieved).toBeGreaterThan(200 * 0.9);
    expect(r.generator.throttled).toBeGreaterThan(0);
  });

  it("pacing: atraso acumulado entra na latência (omissão coordenada corrigida)", async () => {
    const r = await run(`
name: pacing
target: { baseUrl: "${demo.url}" }
load: { model: closed, pacing: 50ms, stages: [ { duration: 3s, vus: 2 } ] }
flow: [ { request: { path: "/slow?ms=150" } } ]
`);
    expect(r.summary.serviceTimeMs.p50).toBeLessThan(170);
    expect(r.summary.latencyMs.p99).toBeGreaterThan(1000);
  });
});

describe("parada", () => {
  it("stopWhen encerra no ponto de ruptura e registra onde foi", async () => {
    const t0 = Date.now();
    const r = await run(`
name: stress
target: { baseUrl: "${demo.url}" }
load:
  stages: [ { duration: 30s, rps: 20 -> 200 } ]
  stopWhen: ["errorRate > 10%"]
flow: [ { request: { path: "/flaky?rate=0.5" } } ]
`);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(r.run.status).toBe("completed");
    expect(r.run.stopReason).toMatch(/errorRate > 10%/);
    expect(r.run.breakingPoint).toMatchObject({ condition: "errorRate > 10%", t: 0 });
    expect(r.run.breakingPoint!.measured).toBeGreaterThan(0.3);
  });

  it("parada durante think termina rápido (pausas são acordadas)", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 800);
    const t0 = Date.now();
    const r = await run(
      `
name: think
target: { baseUrl: "${demo.url}" }
load: { stages: [ { duration: 30s, rps: 20 } ] }
flow:
  - request: { path: /fast }
    think: 10s
  - request: { path: /fast }
`,
      { stopSignal: ac.signal },
    );
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r.run.status).toBe("interrupted");
    expect(r.steps[1]!.requests).toBe(0);
  });

  it("parada com vários workers também drena e consolida", async () => {
    const ac = new AbortController();
    const r = await run(
      `
name: stop-w
target: { baseUrl: "${demo.url}" }
load: { stages: [ { duration: 60s, rps: 200 } ] }
flow: [ { request: { path: "/slow?ms=100" } } ]
`,
      {
        stopSignal: ac.signal,
        workers: 3,
        // para depois de 2 s de teste efetivo (a subida das threads não conta)
        onProgress: (p) => p.elapsedMs >= 2000 && ac.abort(),
      },
    );
    expect(r.run.status).toBe("interrupted");
    expect(r.summary.requests.total).toBeGreaterThan(150);
    expect(r.summary.requests.failed).toBe(0);
  });
});
