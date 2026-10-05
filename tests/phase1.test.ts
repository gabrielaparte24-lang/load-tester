import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ScenarioError,
  TemplateError,
  compileTemplate,
  createIteration,
  createRng,
  csvToTable,
  evalJsonPath,
  importCurl,
  importOpenApi,
  loadScenarioFile,
  parseCsv,
  parseJsonPath,
  parseMatcher,
  parseScenario,
  previewIterations,
  randInt,
  renderTemplate,
  renderValue,
  scenarioSchema,
  tokenizeShell,
  uuidV4,
  type RenderContext,
} from "../packages/core/src/index.js";
import { ROOT } from "./helpers.js";

const ctx = (vars: Record<string, unknown> = {}, seed = 1): RenderContext => ({
  rng: createRng(seed),
  vars: new Map(Object.entries(vars)),
  iteration: 7,
});

describe("templates", () => {
  it("interpola variáveis, propriedades, índices e funções", () => {
    const c = ctx({ id: 42, user: { email: "a@b.c" }, items: [{ id: 9 }] });
    expect(renderTemplate(compileTemplate("/p/${id}"), c)).toBe("/p/42");
    expect(renderTemplate(compileTemplate("${user.email}|${items[0].id}"), c)).toBe("a@b.c|9");
    expect(renderTemplate(compileTemplate("${__iteration}-${iteration()}"), c)).toBe("7-7");
    expect(renderTemplate(compileTemplate("${upper('x')}${base64('a:b')}"), c)).toBe("XYTpi");
    expect(renderTemplate(compileTemplate("custo $${literal}"), c)).toBe("custo ${literal}");
  });

  it("expressão única preserva o tipo; texto misto vira string", () => {
    const c = ctx({ n: 5, o: { a: 1 } });
    expect(renderValue(compileTemplate("${n}"), c)).toBe(5);
    expect(renderValue(compileTemplate("${o}"), c)).toEqual({ a: 1 });
    expect(renderValue(compileTemplate("n=${n}"), c)).toBe("n=5");
    expect(typeof renderValue(compileTemplate("${randInt(1, 3)}"), c)).toBe("number");
  });

  it("resolve env no carregamento (também dentro de funções) e registra o segredo", () => {
    const secrets: string[] = [];
    const t = compileTemplate("Basic ${base64(env.CRED)}", {
      env: (n) => (n === "CRED" ? "u:p" : undefined),
      onSecret: (s) => secrets.push(s),
    });
    expect(renderTemplate(t, ctx())).toBe("Basic dTpw");
    expect(secrets).toEqual(["u:p"]);
    expect(() => compileTemplate("${env.NAO}", { env: () => undefined })).toThrow(
      /NAO não definida/,
    );
  });

  it("erros de sintaxe e de uso são claros", () => {
    expect(() => compileTemplate("${foo(1)}")).toThrow(/função desconhecida "foo"/);
    expect(() => compileTemplate("${randInt(1)}")).toThrow(/uso: randInt\(min, max\)/);
    expect(() => compileTemplate("${a")).toThrow(/sem "}"/);
    expect(() => renderTemplate(compileTemplate("${x}"), ctx())).toThrow(TemplateError);
  });
});

describe("aleatoriedade com semente", () => {
  it("mesma semente e iteração → mesmos valores; outra semente → outros", () => {
    const a = createRng(123, 5);
    const b = createRng(123, 5);
    const c = createRng(124, 5);
    const sa = Array.from({ length: 5 }, a);
    expect(Array.from({ length: 5 }, b)).toEqual(sa);
    expect(Array.from({ length: 5 }, c)).not.toEqual(sa);
  });

  it("randInt é inclusivo e uniforme; uuid tem formato v4", () => {
    const rng = createRng(9);
    const counts = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 60_000; i++) counts[randInt(rng, 0, 5)]!++;
    for (const n of counts) expect(Math.abs(n - 10_000)).toBeLessThan(400); // ~4σ
    expect(uuidV4(rng)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("prévia é reprodutível entre execuções com a mesma semente", () => {
    const yaml = (seed: number) => `
name: r
seed: ${seed}
target: { baseUrl: "http://127.0.0.1:1" }
load: { stages: [ { duration: 1s, rps: 1 } ] }
variables: { id: "\${uuid()}", n: "\${randInt(1, 1000000)}" }
flow: [ { request: { path: "/x/\${id}?n=\${n}" } } ]
`;
    const urls = (seed: number) =>
      previewIterations(parseScenario(yaml(seed)), 5).map((p) => p.url);
    expect(urls(77)).toEqual(urls(77));
    expect(urls(77)).not.toEqual(urls(78));
  });

  it("pesos entre fluxos seguem a proporção configurada", () => {
    const sc = parseScenario(`
name: w
seed: 3
target: { baseUrl: "http://127.0.0.1:1" }
load: { stages: [ { duration: 1s, rps: 1 } ] }
flows:
  - { name: a, weight: 3, steps: [ { request: { path: /a } } ] }
  - { name: b, weight: 1, steps: [ { request: { path: /b } } ] }
`);
    let a = 0;
    for (let i = 0; i < 20_000; i++) if (createIteration(sc, i).flow.name === "a") a++;
    expect(Math.abs(a / 20_000 - 0.75)).toBeLessThan(0.015);
  });
});

describe("CSV", () => {
  it("aspas, vírgulas, aspas escapadas, CRLF e BOM", () => {
    const rows = parseCsv('﻿a,b\r\n"x,1","y""z"\r\n"multi\nlinha",2\n');
    expect(rows).toEqual([
      ["a", "b"],
      ["x,1", 'y"z'],
      ["multi\nlinha", "2"],
    ]);
    expect(parseCsv("a;b\n1;2", ";")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
  it("valida cabeçalho e número de colunas", () => {
    expect(() => csvToTable("a,b\n1\n")).toThrow(/linha 2/);
    expect(() => csvToTable("a b,c\n1,2")).toThrow(/coluna "a b"/);
    expect(() => csvToTable("a,b\n")).toThrow(/sem linhas/);
  });
  it("sequencial faz rodízio; aleatório usa a semente", () => {
    const sc = loadScenarioFile(path.join(ROOT, "tests/fixtures/falhas.yaml"));
    const emails = [0, 1, 2, 3].map((i) => createIteration(sc, i).ctx.vars.get("email"));
    expect(emails).toEqual(["ana@ex.test", "bruno@ex.test", "carla@ex.test", "ana@ex.test"]);
  });
});

describe("JSONPath e matchers", () => {
  const data = { items: [{ id: 1, tags: ["a"] }, { id: 2 }], "com-hifen": true, n: 0 };
  const jp = (p: string) => evalJsonPath(parseJsonPath(p), data);
  it("navega propriedades, índices, wildcard e length", () => {
    expect(jp("$.items[0].id").value).toBe(1);
    expect(jp("$.items[-1].id").value).toBe(2);
    expect(jp("$.items[*].id").value).toEqual([1, 2]);
    expect(jp("$.items.length").value).toBe(2);
    expect(jp("$['com-hifen']").value).toBe(true);
    expect(jp("$.n")).toEqual({ found: true, value: 0 });
    expect(jp("$.nada").found).toBe(false);
    expect(() => parseJsonPath("items")).toThrow(/começar com "\$"/);
    expect(() => parseJsonPath("$.a[?(@.x)]")).toThrow(/não suportado/);
  });
  it("matchers", () => {
    const t = (spec: unknown, v: unknown, found = true) => parseMatcher(spec).test(found, v);
    expect(t(">0", 2)).toBe(true);
    expect(t(">0", 0)).toBe(false);
    expect(t(">= 5", "5")).toBe(true);
    expect(t("== ok", "ok")).toBe(true);
    expect(t("!= erro", "ok")).toBe(true);
    expect(t("~^ab", "abc")).toBe(true);
    expect(t("exists", undefined, false)).toBe(false);
    expect(t("!exists", undefined, false)).toBe(true);
    expect(t(200, 200)).toBe(true);
    expect(t(true, "true")).toBe(false);
    expect(t("texto", "texto")).toBe(true);
    expect(() => parseMatcher(">abc")).toThrow(/exige um número/);
  });
});

describe("validação semântica", () => {
  const base = (flow: string) => `
name: v
target: { baseUrl: "http://127.0.0.1:1" }
load: { stages: [ { duration: 1s, rps: 1 } ] }
flow:
${flow}`;
  it("variável extraída só numa etapa posterior é apontada", () => {
    try {
      parseScenario(
        base(`  - request: { path: "/a/\${token}" }
  - request: { path: /login }
    extract: { token: "$.token" }`),
      );
      expect.unreachable();
    } catch (e) {
      const i = (e as ScenarioError).issues[0]!;
      expect(i.path).toBe("flow[0].request.path");
      expect(i.message).toMatch(/só é extraída na etapa 2/);
      expect(i.line).toBe(6);
    }
  });
  it("encadeamento válido: etapa seguinte usa o valor extraído", () => {
    const sc = parseScenario(
      base(`  - request: { path: /login }
    extract: { token: "$.token", loc: { header: location }, n: { regex: "id=(\\\\d+)" } }
  - request: { path: "/a/\${token}/\${n}", headers: { X-Loc: "\${loc}" } }`),
    );
    expect(sc.flows[0]!.steps[0]!.needsBody).toBe(true);
    expect(sc.flows[0]!.steps[0]!.extract.map(([k]) => k)).toEqual(["token", "loc", "n"]);
  });
});

describe("importadores", () => {
  it("tokeniza linhas de shell (bash, cmd ^ e PowerShell `)", () => {
    expect(tokenizeShell(`curl -H 'a: b' "x \\"y\\"" \\\n -d z`)).toEqual([
      "curl",
      "-H",
      "a: b",
      'x "y"',
      "-d",
      "z",
    ]);
    expect(tokenizeShell("curl ^\r\n  -X POST")).toEqual(["curl", "-X", "POST"]);
  });

  it("cURL: método, query, JSON e segredos substituídos por ${env.*}", () => {
    const r = importCurl(
      tokenizeShell(
        `curl 'https://api.exemplo.test/v1/x?a=1' -H 'Authorization: Bearer SEGREDO' -H 'X-Api-Key: K123' --json '{"q":1}'`,
      ),
    );
    const text = JSON.stringify(r.scenario);
    expect(text).not.toContain("SEGREDO");
    expect(text).not.toContain("K123");
    expect(r.env.sort()).toEqual(["LT_AUTHORIZATION", "LT_X_API_KEY"]);
    const step = (r.scenario.flow as { request: Record<string, unknown> }[])[0]!.request;
    expect(step).toMatchObject({
      method: "POST",
      path: "/v1/x",
      query: { a: "1" },
      json: { q: 1 },
    });
    expect((r.scenario.target as { baseUrl: string }).baseUrl).toBe("https://api.exemplo.test");
  });

  it("OpenAPI: refs, servidor com variáveis, segurança e só métodos seguros por padrão", () => {
    const text = fs.readFileSync(path.join(ROOT, "tests/fixtures/demo-openapi.yaml"), "utf8");
    const r = importOpenApi(text);
    const flows = r.scenario.flows as { name: string }[];
    expect(flows.map((f) => f.name)).toEqual(["fast", "listarProdutos", "detalheProduto"]);
    expect((r.scenario.target as { baseUrl: string }).baseUrl).toBe("http://127.0.0.1:4100");
    expect(r.env).toEqual(["LT_API_TOKEN"]);
    expect(r.notes.join(" ")).toMatch(/POST \/echo, DELETE \/echo/);
    const all = importOpenApi(text, { allMethods: true });
    const echo = (
      all.scenario.flows as {
        name: string;
        steps: { request: { json: Record<string, unknown> } }[];
      }[]
    ).find((f) => f.name === "criarEcho")!;
    expect(echo.steps[0]!.request.json).toMatchObject({
      id: "${uuid()}",
      quantidade: "${randInt(1, 5)}",
      tags: ["novo"],
    });
  });
});

describe("schema e exemplos", () => {
  it("schema/scenario.schema.json está sincronizado com o código (rode: npx lt schema -o ... --force)", () => {
    const file = JSON.parse(
      fs.readFileSync(path.join(ROOT, "schema/scenario.schema.json"), "utf8"),
    );
    expect(file).toEqual(JSON.parse(JSON.stringify(scenarioSchema)));
  });

  it("todos os cenários em examples/ são válidos", () => {
    process.env.LT_API_TOKEN ??= "teste";
    const dir = path.join(ROOT, "examples");
    const files = ["", "perfis"].flatMap((sub) =>
      fs
        .readdirSync(path.join(dir, sub))
        .filter((f) => /\.ya?ml$/.test(f) && !f.startsWith("ci"))
        .map((f) => path.join(dir, sub, f)),
    );
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) expect(() => loadScenarioFile(f), f).not.toThrow();
  });
});
