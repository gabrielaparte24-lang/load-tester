import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { getConfig } from "../packages/core/src/index.js";
import { buildApp } from "../packages/server/src/app.js";
import { Store } from "../packages/server/src/store.js";
import { startDemo } from "./helpers.js";

let app: FastifyInstance;
let tmp: string;
let base: string;
let demo: Awaited<ReturnType<typeof startDemo>>;
const H = { host: "127.0.0.1:4000", "content-type": "application/json" };

const scenario = (name: string, extra = "", path = "/fast", seconds = 2) => `
name: ${name}
target: { baseUrl: "${demo.url}" }
load: { stages: [ { duration: ${seconds}s, rps: 20 } ] }
thresholds: ["p95 < 500ms"]
flow: [ { request: { path: "${path}" } } ]
${extra}`;

const req = async <T = Record<string, unknown>>(method: string, url: string, payload?: unknown) => {
  const res = await app.inject({
    method: method as "GET",
    url,
    // como o navegador: content-type só quando há corpo
    headers: payload === undefined ? { host: H.host } : H,
    payload: payload as object,
  });
  const isJson = String(res.headers["content-type"] ?? "").includes("json");
  return {
    status: res.statusCode,
    body: (isJson && res.body ? res.json() : null) as T,
    raw: res.body,
    headers: res.headers,
  };
};

const waitFinished = async (id: string, timeoutMs = 20_000) => {
  const t0 = Date.now();
  for (;;) {
    const r = await req<{ run: { status: string } }>("GET", `/api/runs/${id}`);
    if (r.body.run && r.body.run.status !== "running") return r.body;
    if (Date.now() - t0 > timeoutMs) throw new Error("execução não terminou");
    await new Promise((res) => setTimeout(res, 200));
  }
};

beforeAll(async () => {
  demo = await startDemo();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lt-p5-"));
  fs.mkdirSync(path.join(tmp, "reports"), { recursive: true });
  app = await buildApp({
    config: {
      ...getConfig(),
      dataDir: path.join(tmp, "data"),
      reportsDir: path.join(tmp, "reports"),
    },
    seed: false,
    webDist: path.join(tmp, "sem-web"),
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await app?.close();
  await demo?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("cenários (CRUD + validação)", () => {
  let id = "";
  it("cria, lista, lê, atualiza e exclui", async () => {
    const c = await req<{ id: string; name: string }>("POST", "/api/scenarios", {
      yaml: scenario("Meu Teste"),
    });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ id: "meu-teste", name: "Meu Teste" });
    id = c.body.id;
    const dup = await req<{ id: string }>("POST", "/api/scenarios", {
      yaml: scenario("Meu Teste"),
    });
    expect(dup.body.id).toBe("meu-teste-2");
    expect((await req<unknown[]>("GET", "/api/scenarios")).body).toHaveLength(2);
    const u = await req<{ name: string }>("PUT", `/api/scenarios/${id}`, {
      yaml: scenario("Renomeado"),
    });
    expect(u.body.name).toBe("Renomeado");
    expect((await req("GET", `/api/scenarios/${id}`)).body).toMatchObject({ name: "Renomeado" });
    expect((await req("DELETE", "/api/scenarios/meu-teste-2")).status).toBe(204);
    expect((await req("GET", "/api/scenarios/meu-teste-2")).status).toBe(404);
  });

  it("entrada inválida → 400; YAML de rascunho é aceito para salvar", async () => {
    expect((await req("POST", "/api/scenarios", {})).status).toBe(400);
    expect((await req("POST", "/api/scenarios", { yaml: "x", extra: 1 })).status).toBe(400);
    const draft = await req<{ name: string }>("POST", "/api/scenarios", {
      yaml: "name: [quebrado",
    });
    expect(draft.status).toBe(201);
    expect(draft.body.name).toBe("sem nome");
  });

  it("validação para o editor: problemas com linha/coluna, resumo e prévia", async () => {
    const bad = await req<{ valid: boolean; issues: { line: number; path: string }[] }>(
      "POST",
      "/api/scenarios/validate",
      {
        yaml: "name: x\ntarget: { baseUrl: ftp://a }\nload: { stages: [] }\nflow: []",
      },
    );
    expect(bad.body.valid).toBe(false);
    expect(bad.body.issues[0]).toMatchObject({ path: "target.baseUrl", line: 2 });
    const ok = await req<{ valid: boolean; summary: { peakRps: number }; preview: unknown[] }>(
      "POST",
      "/api/scenarios/validate",
      {
        yaml: scenario("v"),
        preview: 2,
      },
    );
    expect(ok.body.valid).toBe(true);
    expect(ok.body.summary.peakRps).toBe(20);
    expect(ok.body.preview).toHaveLength(2);
  });
});

describe("execuções, tempo real e relatórios", () => {
  let runA = "";
  let runB = "";

  it("inicia pela API, transmite progresso por SSE e grava o relatório", async () => {
    const ctl = new AbortController();
    const sse = await fetch(`${base}/api/events`, { signal: ctl.signal });
    expect(sse.headers.get("content-type")).toMatch(/text\/event-stream/);
    const reader = sse.body!.getReader();
    let text = "";
    const reading = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
        if (text.includes("event: run-finished")) break;
      }
    })();

    const start = await req<{ id: string; totalMs: number }>("POST", "/api/runs", {
      yaml: scenario("sse", "", "/slow?ms=20", 3),
    });
    expect(start.status).toBe(202);
    runA = start.body.id;
    const busy = await req("POST", "/api/runs", { yaml: scenario("outra") });
    expect(busy.status).toBe(409); // uma execução por vez

    const live = await req<{ live: { history: unknown[]; logs: unknown[] } }>(
      "GET",
      `/api/runs/${runA}`,
    );
    expect(live.body.live).toBeDefined();

    const done = await waitFinished(runA);
    await Promise.race([reading, new Promise((r) => setTimeout(r, 3000))]);
    ctl.abort();
    expect(text).toContain("event: hello");
    expect(text).toContain("event: run-started");
    expect(text).toContain("event: progress");
    expect(text).toContain("event: log");
    expect(text).toContain("event: run-finished");
    expect(done).toMatchObject({
      run: { status: "completed", thresholdsPassed: 1, thresholdsTotal: 1 },
    });

    const html = await req("GET", `/api/runs/${runA}/report`);
    expect(html.headers["content-type"]).toMatch(/text\/html/);
    expect(html.raw).toContain("<svg");
    const md = await req("GET", `/api/runs/${runA}/report?format=md`);
    expect(md.raw).toMatch(/^### /);
    expect((await req("GET", `/api/runs/${runA}/report?format=pdf`)).status).toBe(400);
  });

  it("kill switch: parada em poucos segundos com parcial salvo como interrompido", async () => {
    const start = await req<{ id: string }>("POST", "/api/runs", {
      yaml: scenario("longo", "", "/slow?ms=30", 60),
    });
    runB = start.body.id;
    await new Promise((r) => setTimeout(r, 2500));
    const t0 = Date.now();
    expect((await req("POST", `/api/runs/${runB}/stop`)).status).toBe(202);
    const done = await waitFinished(runB);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(done).toMatchObject({ run: { status: "interrupted" } });
    expect((await req("POST", `/api/runs/${runB}/stop`)).status).toBe(409);
  });

  it("histórico com filtros, baseline e comparação", async () => {
    const all = await req<{ total: number; items: { id: string }[]; scenarios: string[] }>(
      "GET",
      "/api/runs",
    );
    expect(all.body.total).toBe(2);
    expect(all.body.scenarios).toEqual(["longo", "sse"]);
    const f = await req<{ total: number }>("GET", "/api/runs?status=interrupted");
    expect(f.body.total).toBe(1);
    expect((await req("GET", "/api/runs?status=xyz")).status).toBe(400);

    const bl = await req<{ scenario: string }>("POST", `/api/runs/${runA}/baseline`);
    expect(bl.body.scenario).toBe("sse");
    const listed = await req<{ items: { id: string; isBaseline: boolean }[] }>(
      "GET",
      "/api/runs?scenario=sse",
    );
    expect(listed.body.items[0]).toMatchObject({ id: runA, isBaseline: true });
    expect((await req<unknown[]>("GET", "/api/baselines")).body).toHaveLength(1);
    expect((await req("DELETE", "/api/baselines/sse")).status).toBe(204);

    const cmp = await req<{ metrics: { metric: string }[]; conclusion: string }>(
      "POST",
      "/api/compare",
      { a: runA, b: runB },
    );
    expect(cmp.status).toBe(200);
    expect(cmp.body.metrics.map((m) => m.metric)).toEqual([
      "p50",
      "p95",
      "p99",
      "rps",
      "errorRate",
    ]);
    expect((await req("POST", "/api/compare", { a: runA, b: "nao-existe" })).status).toBe(404);
  });

  it("execução com cenário inválido → 422 com problemas; cenário inexistente → 404", async () => {
    const bad = await req<{ code: string; issues: unknown[] }>("POST", "/api/runs", {
      yaml: "name: x",
    });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe("invalid_scenario");
    expect((await req("POST", "/api/runs", { scenarioId: "nao-existe" })).status).toBe(404);
    expect((await req("POST", "/api/runs", {})).status).toBe(400);
  });

  it("alvo fora da allowlist exige autorização e o host digitado (sem enviar tráfego)", async () => {
    const yaml = scenario("externo").replace(demo.url, "http://192.0.2.10"); // TEST-NET-1 (RFC 5737)
    const a = await req<{ code: string; needs: string; target: { host: string } }>(
      "POST",
      "/api/runs",
      { yaml },
    );
    expect(a.status).toBe(403);
    expect(a.body).toMatchObject({
      code: "target_confirmation_required",
      needs: "flag",
      target: { host: "192.0.2.10" },
    });
    const b = await req<{ needs: string }>("POST", "/api/runs", { yaml, iOwnThisTarget: true });
    expect(b.body.needs).toBe("confirm");
    const c = await req<{ needs: string }>("POST", "/api/runs", {
      yaml,
      iOwnThisTarget: true,
      confirmTarget: "outro.host",
    });
    expect(c.body.needs).toBe("mismatch");
    expect((await req<{ total: number }>("GET", "/api/runs")).body.total).toBe(2); // nada foi iniciado
  });

  it("tetos de segurança valem na API", async () => {
    const yaml = scenario("pesado").replace("rps: 20", "rps: 999999");
    const r = await req<{ error: string }>("POST", "/api/runs", { yaml });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/excede o teto/);
  });

  it("status, /metrics e fallback sem dashboard compilado", async () => {
    const s = await req<{ limits: { maxRps: number }; storage: { runs: Record<string, number> } }>(
      "GET",
      "/api/status",
    );
    expect(s.body.limits.maxRps).toBeGreaterThan(0);
    expect(s.body.storage.runs).toEqual({ completed: 1, interrupted: 1 });
    const m = await req("GET", "/metrics");
    expect(m.headers["content-type"]).toMatch(/text\/plain; version=0.0.4/);
    expect(m.raw).toContain('lt_server_runs_total{status="completed"} 1');
    expect((await req("GET", "/")).raw).toContain("dashboard não foi compilado");
    expect((await req("GET", "/api/rota-que-nao-existe")).status).toBe(404);
  });
});

describe("persistência", () => {
  it("importa execuções do CLI e recupera execuções interrompidas por queda do servidor", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lt-store-"));
    const reports = path.join(dir, "reports");
    fs.mkdirSync(path.join(reports, "r1"), { recursive: true });
    const fake = {
      schemaVersion: 1,
      run: {
        id: "r1",
        scenario: "cli",
        status: "completed",
        model: "open",
        startedAt: "2026-01-01T00:00:00Z",
        endedAt: "x",
        durationMs: 1,
        invalid: false,
      },
      config: { target: { baseUrl: "http://x" } },
      summary: {
        requests: { total: 1 },
        errorRate: 0,
        latencyMs: { p50: 1, p95: 2, p99: 3 },
        rps: { achieved: 1 },
      },
      thresholds: [],
    };
    fs.writeFileSync(path.join(reports, "r1", "report.json"), JSON.stringify(fake));
    const store = new Store(path.join(dir, "lt.db"));
    expect(store.syncReports(reports)).toBe(1);
    expect(store.syncReports(reports)).toBe(0); // idempotente
    expect(store.getRun("r1")).toMatchObject({ source: "cli", p95: 2 });
    store.insertRunning({
      id: "r2",
      scenarioId: null,
      scenario: "x",
      model: "open",
      baseUrl: "http://x",
      startedAt: "2026-01-01T00:00:00Z",
    });
    expect(store.recoverStale()).toBe(1);
    expect(store.getRun("r2")?.status).toBe("failed");
    expect(store.seedExamples(path.resolve(import.meta.dirname, ".."))).toBeGreaterThan(10);
    expect(store.seedExamples(path.resolve(import.meta.dirname, ".."))).toBe(0); // só na primeira vez
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
