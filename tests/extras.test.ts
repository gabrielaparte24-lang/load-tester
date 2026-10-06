import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  parseScenario,
  previewIterations,
  runScenario,
  type RunOptions,
  type RunReport,
} from "../packages/core/src/index.js";
import { ROOT, freePort, startDemo } from "./helpers.js";

let demo: Awaited<ReturnType<typeof startDemo>>;
beforeAll(async () => {
  demo = await startDemo();
});
afterAll(async () => {
  await demo?.stop();
});

const PROTO = "packages/demo-target/proto/demo.proto";
const parse = (yaml: string) => parseScenario(yaml, undefined, { baseDir: ROOT });
const run = (yaml: string, opts: Partial<RunOptions> = {}): Promise<RunReport> =>
  runScenario(parse(yaml), {
    toolVersion: "test",
    connections: 16,
    systemMetrics: false,
    ...opts,
  });

const scenario = (
  baseUrl: string,
  flow: string,
  load = "{ stages: [ { duration: 2s, rps: 20 } ] }",
) => `
name: extra
target: { baseUrl: "${baseUrl}", timeoutMs: 2000 }
seed: 3
load: ${load}
flow:
${flow}
`;

describe("validação de etapas ws/grpc", () => {
  const err = (flow: string) => () => parse(scenario("http://127.0.0.1:1", flow));

  it("exige exatamente um tipo por etapa", () => {
    expect(err(`  - { request: { path: / }, ws: { path: /ws, script: [ { send: a } ] } }`)).toThrow(
      /exatamente um entre request \(HTTP\), ws \(WebSocket\) e grpc/,
    );
  });

  it("ws: roteiro obrigatório, checagens por mensagem e sem headers", () => {
    expect(err(`  - { ws: { path: /ws/echo } }`)).toThrow(/script com ao menos uma ação/);
    expect(
      err(`  - { ws: { path: /ws/echo, script: [ { send: a } ] }, expect: { bodyContains: a } }`),
    ).toThrow(/script\[\]\.expect/);
    expect(
      err(
        `  - { ws: { path: /ws/echo, script: [ { expect: {}, extract: { h: { header: x } } } ] } }`,
      ),
    ).toThrow(/não têm headers/);
    expect(err(`  - { ws: { path: /ws/echo, script: [ { send: a, sleep: 1s } ] } }`)).toThrow(
      /exatamente um entre send, sendJson, sendBinary, expect e sleep/,
    );
    // variável extraída no roteiro só existe depois da extração
    expect(
      err(
        `  - { ws: { path: /ws/echo, script: [ { send: "\${sessao}" }, { expect: {}, extract: { sessao: $.s } } ] } }`,
      ),
    ).toThrow(/sessao/);
  });

  it("grpc: serviço, método, streaming e status", () => {
    const g = (extra: string) => err(`  - grpc: { proto: ${PROTO}, ${extra} }`);
    expect(g("service: demo.Nada, method: SayHello")).toThrow(/disponíveis: demo\.Greeter/);
    expect(g("service: demo.Greeter, method: Nada")).toThrow(
      /disponíveis: SayHello, Slow, Flaky, Chat, Countdown, Sum/,
    );
    // regras por tipo de streaming
    const m = (method: string, extra: string) =>
      g(`service: demo.Greeter, method: ${method}, ${extra}`);
    expect(m("SayHello", "script: [ { send: {} } ]")).toThrow(/é unário: script só vale/);
    expect(m("Chat", "message: { name: x }, script: [ { send: {} } ]")).toThrow(
      /as mensagens vão no script \(send\)/,
    );
    expect(m("Chat", "script: [ { sleep: 1ms } ]")).toThrow(/informe ao menos um send/);
    expect(m("Sum", "script: [ { send: {} }, { expect: {} } ]")).toThrow(
      /expect não vale em client streaming/,
    );
    expect(m("Countdown", "script: [ { send: {} } ]")).toThrow(/send não vale em server streaming/);
    expect(m("Chat", "script: [ { send: {}, end: true } ]")).toThrow(
      /exatamente um entre send, expect, sleep e end/,
    );
    expect(
      err(
        `  - { grpc: { proto: ${PROTO}, service: demo.Greeter, method: SayHello }, expect: { messages: 1 } }`,
      ),
    ).toThrow(/messages só vale em métodos com streaming/);
    expect(err(`  - { request: { path: / }, expect: { messages: 1 } }`)).toThrow(
      /messages só vale em etapas grpc/,
    );
    expect(err(`  - grpc: { proto: nao-existe.proto, service: a.B, method: C }`)).toThrow(
      /não foi possível carregar "nao-existe\.proto"/,
    );
    expect(
      err(
        `  - { grpc: { proto: ${PROTO}, service: demo.Greeter, method: SayHello }, expect: { status: 200 } }`,
      ),
    ).toThrow(/use grpcStatus/);
    expect(
      err(
        `  - { grpc: { proto: ${PROTO}, service: demo.Greeter, method: SayHello }, expect: { grpcStatus: BOGUS } }`,
      ),
    ).toThrow(/grpcStatus/);
    expect(err(`  - { request: { path: / }, expect: { grpcStatus: OK } }`)).toThrow(
      /só vale em etapas grpc/,
    );
  });

  it("checagens não aceitam templates (seriam comparadas literalmente)", () => {
    expect(err(`  - { request: { path: / }, expect: { jsonPath: { "$.a": "\${x}" } } }`)).toThrow(
      /valores fixos/,
    );
  });

  it("preview mostra o roteiro WS e a mensagem gRPC renderizados", () => {
    const sc = parse(
      scenario(
        "http://127.0.0.1:4100",
        `  - ws: { path: "/ws/echo?i=\${iteration()}", script: [ { sendJson: { n: "\${iteration()}" } }, { expect: {} } ] }
  - grpc: { proto: ${PROTO}, service: demo.Greeter, method: SayHello, message: { name: "u\${iteration()}" } }`,
      ),
    );
    const [ws, grpc] = previewIterations(sc, 1);
    expect(ws).toMatchObject({ method: "WS", url: "ws://127.0.0.1:4100/ws/echo?i=0" });
    expect(ws!.body).toContain('send {"n":0}');
    expect(grpc).toMatchObject({
      method: "GRPC",
      url: "grpc://127.0.0.1:4100/demo.Greeter/SayHello",
      body: '{"name":"u0"}',
    });
  });
});

describe("WebSocket como alvo", () => {
  it("sessão com boas-vindas, extração, eco JSON e checagens por mensagem", async () => {
    const r = await run(
      scenario(
        demo.url,
        `  - name: eco
    ws:
      path: /ws/echo?welcome=1
      headers: { X-Teste: "1" }
      script:
        - expect: { jsonPath: { "$.type": welcome } }
          extract: { sessao: $.session }
        - sendJson: { sessao: "\${sessao}", i: "\${iteration()}" }
        - expect: { jsonPath: { "$.echo.sessao": "~^[0-9a-f-]{36}$", "$.n": 1, "$.echo.i": ">= 0" } }
        - send: "texto \${sessao}"
        - expect: { bodyMatches: "^texto [0-9a-f-]{36}$" }
    expect: { maxDuration: 1s }`,
      ),
    );
    const s = r.summary;
    expect(s.requests.total).toBe(40);
    expect(s.requests.failed).toBe(0);
    expect(s.statusCodes).toEqual({ "ws:101": 40 });
    expect(s.ws).toMatchObject({ sessions: 40, messagesSent: 80, messagesReceived: 120 });
    expect(s.ws!.connectMs.count).toBe(40);
    expect(s.ws!.rttMs.count).toBe(80);
    expect(s.checks).toEqual({ passed: 40 * 7, failed: 0 }); // 5 checagens + extração + tempo máximo
    expect(r.steps[0]).toMatchObject({ method: "WS", path: "/ws/echo?welcome=1" });
    expect(r.steps[0]!.checks.map((c) => c.name)).toContain("msg 2: $.n == 1");
  });

  it("classifica falhas: checagem, timeout de mensagem, rota inexistente e porta fechada", async () => {
    const one = "{ stages: [ { duration: 1s, rps: 5 } ] }";
    const check = await run(
      scenario(
        demo.url,
        `  - ws: { path: /ws/echo, script: [ { send: abc }, { expect: { bodyContains: xyz } } ] }`,
        one,
      ),
    );
    expect(check.summary.errorsByType).toEqual({ check_failed: 5 });
    expect(check.steps[0]!.failures[0]!.message).toMatch(/^msg 1: corpo não contém "xyz"/);

    const slow = await run(
      scenario(
        demo.url,
        `  - ws: { path: "/ws/echo?delay=500", script: [ { send: a }, { expect: { timeout: 100ms } } ] }`,
        one,
      ),
    );
    expect(slow.summary.errorsByType).toEqual({ timeout: 5 });

    const missing = await run(
      scenario(demo.url, `  - ws: { path: /nao-existe, script: [ { send: a } ] }`, one),
    );
    expect(missing.summary.errorsByType).toEqual({ ws_error: 5 });
    expect(missing.summary.statusCodes).toEqual({ "ws:falha": 5 });
    expect(missing.steps[0]!.failures[0]!.message).toContain("HTTP 404 (esperado 101)");

    const closed = await run(
      scenario(
        `http://127.0.0.1:${await freePort()}`,
        `  - ws: { path: /ws, script: [ { send: a } ] }`,
        one,
      ),
    );
    expect(closed.summary.errorsByType).toEqual({ connection_refused: 5 });
  });

  it("mensagens binárias: sendBinary (hex/base64/arquivo), tipo, tamanho, hex e extração", async () => {
    const r = await run(
      scenario(
        demo.url,
        `  - name: binario
    ws:
      path: /ws/echo?welcome=binary
      script:
        - expect: { type: binary, size: 16, hex: "~^4c543031" }
          extract: { token: { bytes: hex } }
        - sendBinary: { hex: "\${token}" }
        - expect: { type: binary, size: 16, hex: "~^4c543031" }
        - sendBinary: { base64: "AAEC/w==" }
        - expect: { type: binary, hex: "000102ff", size: 4 }
        - sendBinary: { hex: "ca fe ba be" }
        - expect: { hex: cafebabe }
        - sendBinary: { file: tests/fixtures/binario.bin }
        - expect: { type: binary, size: 256, hex: "~^000102" }
        - send: texto
        - expect: { type: text, bodyContains: texto }`,
      ),
    );
    const s = r.summary;
    expect(s.requests).toEqual({ total: 40, ok: 40, failed: 0 });
    expect(s.ws).toMatchObject({ sessions: 40, messagesSent: 200, messagesReceived: 240 });
    // 16 + 4 + 4 + 256 + 5 bytes enviados por sessão
    expect(s.bytes.sent).toBe(40 * (16 + 4 + 4 + 256 + 5));
    expect(r.steps[0]!.checks.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        "msg 1: tipo = binary",
        "msg 1: tamanho == 16",
        "msg 1: extrair token",
        'msg 3: hex == "000102ff"',
      ]),
    );
  });

  it("mensagens binárias: validação e falhas", async () => {
    const bad = (script: string) => () =>
      parse(scenario("http://127.0.0.1:1", `  - ws: { path: /ws/echo, script: ${script} }`));
    expect(bad("[ { sendBinary: { hex: 'xyz' } } ]")).toThrow(/hex inválido: use só 0-9 e a-f/);
    expect(bad("[ { sendBinary: { hex: 'abc' } } ]")).toThrow(/número ímpar de dígitos/);
    expect(bad("[ { sendBinary: { base64: '***' } } ]")).toThrow(/base64 inválido/);
    expect(bad("[ { sendBinary: { hex: 'ab', base64: 'AA==' } } ]")).toThrow(
      /exatamente um entre hex, base64 e file/,
    );
    expect(bad("[ { sendBinary: { file: nao-existe.bin } } ]")).toThrow(
      /não foi possível ler "nao-existe\.bin"/,
    );
    expect(() =>
      parse(
        scenario(
          "http://127.0.0.1:1",
          `  - grpc: { proto: ${PROTO}, service: demo.Greeter, method: Chat, script: [ { sendBinary: { hex: ab } } ] }`,
        ),
      ),
    ).toThrow(/sendBinary/);

    const one = "{ stages: [ { duration: 1s, rps: 5 } ] }";
    const wrongType = await run(
      scenario(
        demo.url,
        `  - ws: { path: /ws/echo, script: [ { send: abc }, { expect: { type: binary } } ] }`,
        one,
      ),
    );
    expect(wrongType.summary.errorsByType).toEqual({ check_failed: 5 });
    expect(wrongType.steps[0]!.failures[0]!.message).toBe(
      "msg 1: mensagem de texto (esperado binary)",
    );

    const badRuntime = await run(
      scenario(
        demo.url,
        `  - ws: { path: /ws/echo, script: [ { sendBinary: { hex: "\${pick('zz', 'yy')}" } } ] }`,
        one,
      ),
    );
    expect(badRuntime.summary.errorsByType).toEqual({ template_error: 5 });
    expect(badRuntime.steps[0]!.failures[0]!.message).toMatch(/sendBinary: hex inválido/);
  });

  it("preview mostra o tamanho e o início dos bytes", () => {
    const sc = parse(
      scenario(
        "http://127.0.0.1:4100",
        `  - ws: { path: /ws/echo, script: [ { sendBinary: { hex: "ca fe ba be" } }, { sendBinary: { file: tests/fixtures/binario.bin } } ] }`,
      ),
    );
    const body = previewIterations(sc, 1)[0]!.body!;
    expect(body).toContain("sendBinary 4 bytes: cafebabe");
    expect(body).toContain(
      "sendBinary 256 bytes: 000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f…",
    );
  });

  it("parar no meio de uma pausa do roteiro encerra em segundos", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 600);
    const t0 = Date.now();
    const r = await run(
      scenario(
        demo.url,
        `  - ws: { path: /ws/echo, script: [ { sleep: 30s }, { send: a }, { expect: {} } ] }`,
        "{ stages: [ { duration: 30s, rps: 5 } ] }",
      ),
      { stopSignal: ac.signal, drainTimeoutMs: 2000 },
    );
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.run.status).toBe("interrupted");
  });
});

describe("gRPC como alvo", () => {
  it("chamada unária com metadados, checagens e extração usada na etapa seguinte", async () => {
    const r = await run(`
name: grpc
target: { baseUrl: "${demo.grpcUrl}", timeoutMs: 2000, headers: { x-cliente: lt } }
seed: 5
load: { stages: [ { duration: 2s, rps: 25 } ] }
variables: { nome: "\${pick('Ana', 'Bia')}" }
flow:
  - name: hello
    grpc:
      proto: ${PROTO}
      service: demo.Greeter
      method: SayHello
      message: { name: "\${nome}", times: 2 }
      metadata: { x-pedido: "p\${iteration()}" }
    expect:
      grpcStatus: OK
      jsonPath:
        "$.message": "~^Olá, (Ana|Bia)! Olá, (Ana|Bia)!$"
        "$.metadata.x-cliente": lt
        "$.metadata.x-pedido": "~^p\\\\d+$"
        "$.tags.length": 2
    extract: { tamanho: $.length }
  - name: slow
    grpc:
      proto: ${PROTO}
      service: demo.Greeter
      method: Slow
      message: { ms: 1, name: "\${tamanho}" }
    expect: { jsonPath: { "$.message": "~^Olá, \\\\d+!$" } }
`);
    const s = r.summary;
    expect(s.requests).toEqual({ total: 100, ok: 100, failed: 0 });
    expect(s.statusCodes).toEqual({ "grpc:OK": 100 });
    expect(s.checks.failed).toBe(0);
    expect(r.steps.map((st) => [st.method, st.path])).toEqual([
      ["GRPC", "demo.Greeter/SayHello"],
      ["GRPC", "demo.Greeter/Slow"],
    ]);
    expect(s.bytes.received).toBeGreaterThan(0);
    expect(s.bytes.sent).toBeGreaterThan(0);
  });

  it("status inesperado, deadline e porta fechada são classificados", async () => {
    const one = "{ stages: [ { duration: 2s, rps: 10 } ] }";
    const grpcStep = (method: string, message: string, expectYaml = "") =>
      `  - { grpc: { proto: ${PROTO}, service: demo.Greeter, method: ${method}, message: ${message} }${expectYaml} }`;

    const flaky = await run(scenario(demo.grpcUrl, grpcStep("Flaky", "{ every: 5 }"), one));
    expect(flaky.summary.errorsByType).toEqual({ grpc_status: 4 });
    expect(flaky.summary.statusCodes).toEqual({ "grpc:OK": 16, "grpc:UNAVAILABLE": 4 });
    expect(flaky.steps[0]!.failures[0]!.message).toMatch(/^status UNAVAILABLE: falha simulada/);

    const accepted = await run(
      scenario(
        demo.grpcUrl,
        grpcStep("Flaky", "{ every: 2, code: 5 }", ", expect: { grpcStatus: [OK, NOT_FOUND] }"),
        one,
      ),
    );
    expect(accepted.summary.requests.failed).toBe(0);
    expect(accepted.summary.statusCodes).toEqual({ "grpc:OK": 10, "grpc:NOT_FOUND": 10 });

    const slow = await run(
      scenario(
        demo.grpcUrl,
        grpcStep("Slow", "{ ms: 400 }"),
        "{ stages: [ { duration: 1s, rps: 5 } ] }",
      ).replace("timeoutMs: 2000", "timeoutMs: 100"),
    );
    expect(slow.summary.errorsByType).toEqual({ timeout: 5 });
    expect(slow.summary.statusCodes).toEqual({ "grpc:DEADLINE_EXCEEDED": 5 });

    const closed = await run(
      scenario(
        `http://127.0.0.1:${await freePort()}`,
        grpcStep("SayHello", "{}"),
        "{ stages: [ { duration: 1s, rps: 5 } ] }",
      ),
    );
    expect(closed.summary.errorsByType).toEqual({ connection_refused: 5 });
  });

  it("gRPC fora da allowlist continua exigindo confirmação", async () => {
    const { checkTarget } = await import("../packages/core/src/index.js");
    const sc = parse(
      scenario(
        "http://192.0.2.10:50051",
        `  - grpc: { proto: ${PROTO}, service: demo.Greeter, method: SayHello }`,
      ),
    );
    expect((await checkTarget(sc.target.baseUrl, [])).allowed).toBe(false);
  });
});

describe("gRPC com streaming", () => {
  const step = (method: string, body: string, expectYaml = "") =>
    `  - name: ${method}
    grpc:
      proto: ${PROTO}
      service: demo.Greeter
      method: ${method}
${body
  .split("\n")
  .map((l) => `      ${l}`)
  .join("\n")}${expectYaml ? `\n    expect: ${expectYaml}` : ""}`;
  const short = "{ stages: [ { duration: 1s, rps: 5 } ] }";

  it("server streaming: lê mensagens no roteiro, conta o total e checa a última", async () => {
    const r = await run(
      scenario(
        demo.grpcUrl,
        step(
          "Countdown",
          `message: { from: 5, interval_ms: 10 }
script:
  - expect: { jsonPath: { "$.n": 5, "$.remaining": 4 } }
  - expect: { jsonPath: { "$.n": 4 } }`,
          `{ messages: 5, jsonPath: { "$.message": "fim!" } }`,
        ),
      ),
    );
    const s = r.summary;
    expect(s.requests).toEqual({ total: 40, ok: 40, failed: 0 });
    expect(s.statusCodes).toEqual({ "grpc:OK": 40 });
    expect(s.grpcStreams).toMatchObject({ streams: 40, messagesSent: 40, messagesReceived: 200 });
    expect(s.grpcStreams!.firstMessageMs.count).toBe(40);
    expect(s.checks).toEqual({ passed: 40 * 5, failed: 0 });
    // 5 mensagens a cada 10 ms + fim: a etapa dura o stream inteiro
    expect(r.steps[0]!.latencyMs.p50).toBeGreaterThanOrEqual(45);
  });

  it("client streaming: envia pelo roteiro e a resposta única alimenta a etapa seguinte", async () => {
    const r = await run(
      scenario(
        demo.grpcUrl,
        `${step(
          "Sum",
          `script:
  - send: { value: 1 }
  - send: { value: "\${randInt(2, 2)}" }
  - sleep: 5ms
  - send: { value: 0.5 }`,
          `{ messages: 1, jsonPath: { "$.count": 3, "$.total": 3.5 } }`,
        )}
    extract: { total: "$.total" }
${step("SayHello", `message: { name: "\${total}" }`, `{ jsonPath: { "$.message": "Olá, 3.5!" } }`)}`,
      ),
    );
    expect(r.summary.requests.failed).toBe(0);
    expect(r.summary.requests.total).toBe(80);
    expect(r.summary.grpcStreams).toMatchObject({
      streams: 40,
      messagesSent: 120,
      messagesReceived: 40,
    });
  });

  it("bidi: envio e leitura intercalados, extração entre mensagens e RTT", async () => {
    const r = await run(
      scenario(
        demo.grpcUrl,
        step(
          "Chat",
          `metadata: { x-sessao: "s\${iteration()}" }
script:
  - send: { name: Ana }
  - expect: { jsonPath: { "$.message": "Olá, Ana!" } }
    extract: { sessao: "$.metadata.x-sessao" }
  - send: { name: "\${sessao}" }
  - expect: { bodyMatches: "Olá, s\\\\d+!" }
  - end: true`,
          "{ messages: 2 }",
        ),
      ),
    );
    const s = r.summary;
    expect(s.requests.failed).toBe(0);
    expect(s.grpcStreams).toMatchObject({ streams: 40, messagesSent: 80, messagesReceived: 80 });
    expect(s.grpcStreams!.rttMs.count).toBe(80);
    expect(r.steps[0]!.checks.map((c) => c.name)).toContain("msg 1: extrair sessao");
  });

  it("classifica falhas: status no meio do stream, timeout, fim antecipado e deadline", async () => {
    const failAt = await run(
      scenario(
        demo.grpcUrl,
        step("Countdown", "message: { from: 5, fail_at: 2 }", "{ messages: 2 }"),
        short,
      ),
    );
    expect(failAt.summary.errorsByType).toEqual({ grpc_status: 5 });
    expect(failAt.summary.statusCodes).toEqual({ "grpc:ABORTED": 5 });
    expect(failAt.summary.grpcStreams!.messagesReceived).toBe(10);
    expect(failAt.steps[0]!.failures[0]!.message).toMatch(/^status ABORTED: falha simulada após 2/);

    const accepted = await run(
      scenario(
        demo.grpcUrl,
        step(
          "Countdown",
          "message: { from: 5, fail_at: 2 }",
          "{ grpcStatus: [OK, ABORTED], messages: 2 }",
        ),
        short,
      ),
    );
    expect(accepted.summary.requests.failed).toBe(0);

    const slow = await run(
      scenario(
        demo.grpcUrl,
        step(
          "Countdown",
          `message: { from: 3, interval_ms: 300 }
script:
  - expect: {}
  - expect: { timeout: 100ms }`,
        ),
        short,
      ),
    );
    expect(slow.summary.errorsByType).toEqual({ timeout: 5 });
    expect(slow.steps[0]!.failures[0]!.message).toBe("msg 2: nenhuma mensagem em 100ms");

    const early = await run(
      scenario(
        demo.grpcUrl,
        step(
          "Countdown",
          `message: { from: 1 }
script:
  - expect: {}
  - expect: {}`,
        ),
        short,
      ),
    );
    expect(early.summary.errorsByType).toEqual({ check_failed: 5 });
    expect(early.steps[0]!.failures[0]!.message).toBe("msg 2: o stream terminou antes");

    const idle = await run(
      scenario(
        demo.grpcUrl,
        step("Chat", "script: [ { send: { name: x, delay_ms: 500 } } ]"),
        short,
      ).replace("timeoutMs: 2000", "timeoutMs: 100"),
    );
    expect(idle.summary.errorsByType).toEqual({ timeout: 5 });
    expect(idle.steps[0]!.failures[0]!.message).toMatch(/o stream não terminou/);

    const deadline = await run(
      scenario(
        demo.grpcUrl,
        step("Countdown", "message: { from: 10, interval_ms: 50 }\ndeadline: 120ms"),
        short,
      ),
    );
    expect(deadline.summary.errorsByType).toEqual({ timeout: 5 });
    expect(deadline.summary.statusCodes).toEqual({ "grpc:DEADLINE_EXCEEDED": 5 });
  });

  it("parar durante streams longos encerra em segundos", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 600);
    const t0 = Date.now();
    const r = await run(
      scenario(
        demo.grpcUrl,
        step("Countdown", "message: { from: 1000, interval_ms: 100 }"),
        "{ stages: [ { duration: 30s, rps: 5 } ] }",
      ),
      { stopSignal: ac.signal, drainTimeoutMs: 1000 },
    );
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.run.status).toBe("interrupted");
  });
});
