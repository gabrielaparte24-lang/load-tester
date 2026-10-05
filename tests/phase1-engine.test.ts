import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseScenario, runScenario, type RunReport } from "../packages/core/src/index.js";
import { startDemo } from "./helpers.js";

// Integração da Fase 1 contra o demo-target: encadeamento, CSV, checagens, corpos e erros de template.
let demo: Awaited<ReturnType<typeof startDemo>>;
let tmp: string;
beforeAll(async () => {
  demo = await startDemo();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lt-"));
  fs.writeFileSync(path.join(tmp, "u.csv"), "nome,idade\nana,30\nbruno,41\n");
  fs.writeFileSync(path.join(tmp, "foto.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(tmp, "payload.json"), '{"de":"arquivo"}');
});
afterAll(async () => {
  await demo?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const run = (yaml: string): Promise<RunReport> =>
  runScenario(parseScenario(yaml, undefined, { baseDir: tmp }), {
    toolVersion: "test",
    connections: 16,
  });

const head = () => `
name: f1
seed: 5
target: { baseUrl: "${demo.url}" }
load: { stages: [ { duration: 2s, rps: 20 } ] }
`;

describe("Fase 1 contra o demo-target", () => {
  it("encadeia: extrai id da listagem e usa no detalhe; checagens de JSON", async () => {
    const r = await run(`${head()}
variables: { page: "\${randInt(1, 5)}" }
flow:
  - name: lista
    request: { path: /products, query: { page: "\${page}" } }
    expect: { status: 200, jsonPath: { "$.items.length": "== 10", "$.page": ">= 1" } }
    extract: { pid: "$.items[3].id", pg: "$.page" }
  - name: detalhe
    request: { path: "/products/\${pid}" }
    expect: { status: 200, jsonPath: { "$.name": "~^Produto \\\\d+$" } }
  - name: confere
    request: { method: POST, path: /echo, json: { pid: "\${pid}", pg: "\${pg}" } }
    expect:
      jsonPath: { "$.body.pid": ">= 4", "$.body.pg": ">= 1" }
      bodyContains: '"pid":'
`);
    expect(r.summary.requests.total).toBe(120);
    expect(r.summary.requests.failed).toBe(0);
    expect(r.summary.checks.failed).toBe(0);
    expect(r.steps.map((s) => s.requests)).toEqual([40, 40, 40]);
    expect(r.steps[0]!.checks.map((c) => c.name)).toEqual([
      "status = 200",
      "$.items.length == 10",
      "$.page >= 1",
      "extrair pid",
      "extrair pg",
    ]);
  });

  it("CSV, form, arquivo e multipart chegam corretos ao alvo", async () => {
    const r = await run(`${head()}
data: { file: u.csv }
flow:
  - request: { method: POST, path: /echo, form: { nome: "\${nome}", idade: "\${idade}" } }
    expect: { bodyContains: "x-www-form-urlencoded", bodyMatches: "nome=(ana|bruno)" }
  - request: { method: PUT, path: /echo, file: payload.json }
    expect: { jsonPath: { "$.body.de": arquivo } }
  - request: { method: POST, path: /echo, multipart: { nome: "\${nome}", foto: { file: foto.png } } }
    expect: { bodyContains: ['filename=\\"foto.png\\"', "image/png", "multipart/form-data"] }
`);
    expect(r.summary.requests.failed).toBe(0);
    expect(r.summary.checks.failed).toBe(0);
    expect(r.config.data).toEqual([
      { file: "u.csv", order: "sequential", rows: 2, columns: ["nome", "idade"] },
    ]);
  });

  it("falhas de checagem, extração e template são contadas e explicadas", async () => {
    const r = await run(`${head()}
data: { file: u.csv }
flow:
  - name: idade
    request: { method: POST, path: /echo, json: { idade: "\${num(idade)}" } }
    expect: { jsonPath: { "$.body.idade": "< 35" } }
  - name: quebra
    request: { path: "/echo?x=\${num(nome)}" }
`);
    const [idade, quebra] = r.steps;
    expect(idade!.requests).toBe(40);
    expect(idade!.errorsByType.check_failed).toBe(20); // bruno, 41 anos
    expect(idade!.failures[0]!.message).toBe("$.body.idade < 35 (recebido: 41)");
    expect(quebra!.requests).toBe(20); // só ana chega aqui
    expect(quebra!.errorsByType.template_error).toBe(20);
    expect(quebra!.failures[0]!.message).toMatch(/"ana" não é um número/);
  });
});
