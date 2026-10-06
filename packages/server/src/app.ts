import fs from "node:fs";
import path from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import {
  LtError,
  RESPONSIBLE_USE_NOTICE,
  ScenarioError,
  TargetConfirmationRequired,
  VERSION,
  ArrivalSchedule,
  clearBaseline,
  compareRuns,
  getConfig,
  listBaselines,
  parseScenario,
  previewIterations,
  setBaseline,
  type LtConfig,
  type RunReport,
} from "@lt/core";
import { EventHub } from "./events.js";
import { BusyError, RunManager, assertInside } from "./run-manager.js";
import { Store } from "./store.js";

export interface AppOptions {
  config?: LtConfig;
  instanceId?: string;
  controlToken?: string;
  logger?: boolean | { level: string };
  /** Chamado quando o script `stop` pede encerramento gracioso. */
  onShutdownRequest?: () => void;
  /** Arquivo do banco (padrão: <LT_DATA_DIR>/lt.db). */
  dbFile?: string;
  /** Pasta do build do dashboard (padrão: packages/web/dist). */
  webDist?: string;
  /** Importa os exemplos como cenários na primeira inicialização (padrão: true). */
  seed?: boolean;
}

export interface App {
  app: FastifyInstance;
  store: Store;
  runs: RunManager;
  hub: EventHub;
}

const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

declare module "fastify" {
  interface FastifyInstance {
    lt: App;
  }
}

export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const cfg = opts.config ?? getConfig();
  const instanceId = opts.instanceId ?? randomUUID();
  const startedAt = Date.now();
  const store = new Store(opts.dbFile ?? path.join(cfg.dataDir, "lt.db"));
  store.recoverStale();
  if (opts.seed !== false) store.seedExamples(cfg.root);
  store.syncReports(cfg.reportsDir);
  const hub = new EventHub();
  const runs = new RunManager(cfg, store, hub);

  // o logger padrão do Fastify registra método e URL, nunca headers (que podem conter segredos)
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: 2 * 1024 * 1024,
    // campos desconhecidos são rejeitados (400), não descartados em silêncio
    ajv: { customOptions: { removeAdditional: false } },
  });
  app.decorate("lt", { app, store, runs, hub });

  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || LOOPBACK_ORIGIN.test(origin)),
  });

  app.addHook("onRequest", async (req, reply) => {
    // Defesa contra DNS rebinding: só aceita Host de loopback.
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (!LOOPBACK_HOSTS.includes(host))
      return reply.code(421).send({ error: "host não permitido" });
    // Defesa contra CSRF: requisições que alteram estado só de páginas do próprio localhost.
    const origin = req.headers.origin;
    if (req.method !== "GET" && req.method !== "HEAD" && origin && !LOOPBACK_ORIGIN.test(origin)) {
      return reply.code(403).send({ error: "origem não permitida" });
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof TargetConfirmationRequired) {
      return reply.code(403).send({
        error: err.message,
        code: "target_confirmation_required",
        needs: err.needs,
        target: { host: err.target.host, addresses: err.target.addresses },
        load: err.load,
        notice: RESPONSIBLE_USE_NOTICE,
      });
    }
    if (err instanceof BusyError) return reply.code(409).send({ error: err.message, code: "busy" });
    if (err instanceof ScenarioError) {
      return reply
        .code(422)
        .send({ error: "cenário inválido", code: "invalid_scenario", issues: err.issues });
    }
    if (err instanceof LtError) return reply.code(400).send({ error: err.message, code: "config" });
    const e = err as { validation?: unknown; statusCode?: number; message: string };
    if (e.validation) return reply.code(400).send({ error: e.message, code: "bad_request" });
    if (e.statusCode && e.statusCode < 500)
      return reply.code(e.statusCode).send({ error: e.message });
    app.log.error(err);
    return reply.code(500).send({ error: "erro interno", detail: e.message });
  });

  const notFound = (reply: FastifyReply, what: string) =>
    reply.code(404).send({ error: `${what} não encontrado(a)` });
  const parseFor = (yaml: string, baseDir: string) => parseScenario(yaml, undefined, { baseDir });

  // ---------------------------------------------------------------- estado

  app.get("/api/health", async () => ({
    status: "ok",
    service: "lt-server",
    version: VERSION,
    instanceId,
    pid: process.pid,
    uptimeMs: Date.now() - startedAt,
  }));

  app.get("/api/status", async () => ({
    version: VERSION,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    pid: process.pid,
    uptimeMs: Date.now() - startedAt,
    memoryMb: Math.round(process.memoryUsage.rss() / 1024 / 1024),
    limits: {
      maxRps: cfg.maxRps,
      maxConnections: cfg.maxConnections,
      maxDurationMs: cfg.maxDurationMs,
      maxVus: cfg.maxVus,
    },
    allowedTargets: ["localhost", "127.0.0.1", "::1", ...cfg.allowedTargets],
    activeRuns: runs.list().map((a) => runs.summary(a)),
    sseClients: hub.size,
    storage: {
      database: path.relative(cfg.root, store.file),
      reportsDir: path.relative(cfg.root, cfg.reportsDir),
      runs: store.countRunsByStatus(),
      scenarios: store.listScenarios().length,
      baselines: listBaselines(cfg.dataDir).length,
    },
    notice: RESPONSIBLE_USE_NOTICE,
  }));

  app.get("/api/events", (req, reply) => {
    reply.hijack();
    hub.add(reply.raw, { active: runs.list().map((a) => runs.summary(a)) });
  });

  app.get("/metrics", async (_req, reply) => {
    const counts = store.countRunsByStatus();
    const lines = [
      "# HELP lt_server_runs_total Execucoes registradas por status",
      "# TYPE lt_server_runs_total gauge",
      ...Object.entries(counts).map(([k, v]) => `lt_server_runs_total{status="${k}"} ${v}`),
      "# HELP lt_server_active_runs Execucoes em andamento",
      "# TYPE lt_server_active_runs gauge",
      `lt_server_active_runs ${runs.list().length}`,
    ];
    reply.type("text/plain; version=0.0.4; charset=utf-8");
    return `${lines.join("\n")}\n${runs.metrics()}`;
  });

  // ---------------------------------------------------------------- cenários

  const yamlBody = {
    type: "object",
    required: ["yaml"],
    additionalProperties: false,
    properties: {
      yaml: { type: "string", minLength: 1, maxLength: 1_000_000 },
      id: { type: "string", maxLength: 80 },
    },
  } as const;

  app.get("/api/scenarios", async () => store.listScenarios());

  app.get<{ Params: { id: string } }>("/api/scenarios/:id", async (req, reply) => {
    const s = store.getScenario(req.params.id);
    return s ?? notFound(reply, "cenário");
  });

  app.post<{ Body: { yaml: string; id?: string } }>(
    "/api/scenarios",
    { schema: { body: yamlBody } },
    async (req, reply) => {
      const s = store.createScenario(req.body.yaml, cfg.root, req.body.id);
      hub.emit({ type: "scenarios-changed" });
      return reply.code(201).send(s);
    },
  );

  app.put<{ Params: { id: string }; Body: { yaml: string } }>(
    "/api/scenarios/:id",
    { schema: { body: yamlBody } },
    async (req, reply) => {
      const s = store.updateScenario(req.params.id, req.body.yaml);
      if (!s) return notFound(reply, "cenário");
      hub.emit({ type: "scenarios-changed" });
      return s;
    },
  );

  app.delete<{ Params: { id: string } }>("/api/scenarios/:id", async (req, reply) => {
    if (!store.deleteScenario(req.params.id)) return notFound(reply, "cenário");
    hub.emit({ type: "scenarios-changed" });
    return reply.code(204).send();
  });

  /** Validação para o editor: problemas com linha/coluna, resumo da carga e prévia das requisições. */
  app.post<{ Body: { yaml: string; scenarioId?: string; preview?: number } }>(
    "/api/scenarios/validate",
    {
      schema: {
        body: {
          type: "object",
          required: ["yaml"],
          additionalProperties: false,
          properties: {
            yaml: { type: "string", maxLength: 1_000_000 },
            scenarioId: { type: "string" },
            preview: { type: "integer", minimum: 0, maximum: 10 },
          },
        },
      },
    },
    async (req) => {
      const baseDir =
        (req.body.scenarioId && store.getScenario(req.body.scenarioId)?.baseDir) || cfg.root;
      try {
        const sc = parseFor(req.body.yaml, baseDir);
        const sched = new ArrivalSchedule(sc.load.stages);
        return {
          valid: true,
          issues: [],
          summary: {
            name: sc.name,
            baseUrl: sc.target.baseUrl,
            model: sc.load.model,
            durationMs: sched.totalMs,
            peakRps: sc.load.model === "open" ? sched.peakRps : null,
            peakVus: Math.max(0, ...sc.load.vuStages.map((s) => Math.max(s.vusFrom, s.vusTo))),
            flows: sc.flows.map((f) => ({ name: f.name, weight: f.weight, steps: f.steps.length })),
            thresholds: sc.thresholds,
          },
          preview: req.body.preview ? previewIterations(sc, req.body.preview) : [],
        };
      } catch (e) {
        if (e instanceof ScenarioError) return { valid: false, issues: e.issues };
        if (e instanceof LtError)
          return { valid: false, issues: [{ path: "", message: e.message }] };
        throw e;
      }
    },
  );

  // ---------------------------------------------------------------- execuções

  app.post<{
    Body: {
      scenarioId?: string;
      yaml?: string;
      workers?: number | "auto";
      iOwnThisTarget?: boolean;
      confirmTarget?: string;
    };
  }>(
    "/api/runs",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            scenarioId: { type: "string" },
            yaml: { type: "string", maxLength: 1_000_000 },
            workers: { anyOf: [{ type: "integer", minimum: 1, maximum: 64 }, { const: "auto" }] },
            iOwnThisTarget: { type: "boolean" },
            confirmTarget: { type: "string", maxLength: 255 },
          },
        },
      },
    },
    async (req, reply) => {
      const { scenarioId, yaml } = req.body;
      if (!scenarioId === !yaml)
        return reply.code(400).send({ error: "informe scenarioId ou yaml (um dos dois)" });
      let text = yaml!;
      let baseDir = cfg.root;
      if (scenarioId) {
        const s = store.getScenario(scenarioId);
        if (!s) return notFound(reply, "cenário");
        text = s.yaml;
        baseDir = s.baseDir;
      }
      const sc = parseFor(text, baseDir);
      const run = await runs.start(sc, {
        scenarioId: scenarioId ?? null,
        workers: req.body.workers,
        iOwnThisTarget: req.body.iOwnThisTarget,
        confirmTarget: req.body.confirmTarget,
      });
      return reply.code(202).send(run);
    },
  );

  let lastSync = 0;
  app.get<{
    Querystring: {
      scenario?: string;
      status?: string;
      q?: string;
      limit?: number;
      offset?: number;
    };
  }>(
    "/api/runs",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            scenario: { type: "string" },
            status: { type: "string", enum: ["running", "completed", "interrupted", "failed"] },
            q: { type: "string", maxLength: 200 },
            limit: { type: "integer", minimum: 1, maximum: 500 },
            offset: { type: "integer", minimum: 0 },
          },
        },
      },
    },
    async (req) => {
      if (Date.now() - lastSync > 2000) {
        store.syncReports(cfg.reportsDir);
        lastSync = Date.now();
      }
      const baselines = new Map(listBaselines(cfg.dataDir).map((b) => [b.scenario, b.source]));
      const page = store.listRuns(req.query);
      return {
        ...page,
        scenarios: store.scenarioNames(),
        items: page.items.map((r) => ({
          ...r,
          isBaseline:
            !!r.reportDir &&
            baselines.get(r.scenario) ===
              path.relative(cfg.root, path.join(r.reportDir, "report.json")),
        })),
      };
    },
  );

  const reportOf = (id: string): { report: RunReport; dir: string } | null => {
    const r = store.getRun(id);
    if (!r?.reportDir) return null;
    const dir = assertInside(cfg.reportsDir, r.reportDir);
    const file = path.join(dir, "report.json");
    if (!fs.existsSync(file)) return null;
    return { report: JSON.parse(fs.readFileSync(file, "utf8")) as RunReport, dir };
  };

  app.get<{ Params: { id: string } }>("/api/runs/:id", async (req, reply) => {
    const active = runs.get(req.params.id);
    const row = store.getRun(req.params.id);
    if (!row && !active) return notFound(reply, "execução");
    if (active)
      return {
        run: row,
        live: { ...runs.summary(active), history: active.history, logs: active.logs },
      };
    return { run: row, report: reportOf(req.params.id)?.report ?? null };
  });

  app.post<{ Params: { id: string } }>("/api/runs/:id/stop", async (req, reply) => {
    if (!runs.stop(req.params.id)) {
      return store.getRun(req.params.id)
        ? reply.code(409).send({ error: "a execução não está em andamento" })
        : notFound(reply, "execução");
    }
    return reply.code(202).send({ status: "stopping" });
  });

  app.get<{ Params: { id: string }; Querystring: { format?: string } }>(
    "/api/runs/:id/report",
    {
      schema: {
        querystring: {
          type: "object",
          properties: { format: { type: "string", enum: ["html", "json", "md", "csv", "junit"] } },
        },
      },
    },
    async (req, reply) => {
      const r = reportOf(req.params.id);
      if (!r) return notFound(reply, "relatório");
      const fmt = req.query.format ?? "html";
      const files: Record<string, [string, string]> = {
        html: ["report.html", "text/html; charset=utf-8"],
        json: ["report.json", "application/json; charset=utf-8"],
        md: ["summary.md", "text/markdown; charset=utf-8"],
        csv: ["timeline.csv", "text/csv; charset=utf-8"],
        junit: ["junit.xml", "application/xml; charset=utf-8"],
      };
      const [name, type] = files[fmt]!;
      const file = path.join(r.dir, name);
      if (!fs.existsSync(file)) return notFound(reply, `arquivo ${name}`);
      reply.type(type);
      if (fmt !== "html")
        reply.header("content-disposition", `inline; filename="${req.params.id}-${name}"`);
      return fs.readFileSync(file, "utf8");
    },
  );

  // ---------------------------------------------------------------- baselines e comparação

  app.get("/api/baselines", async () => listBaselines(cfg.dataDir));

  app.post<{ Params: { id: string } }>("/api/runs/:id/baseline", async (req, reply) => {
    const r = reportOf(req.params.id);
    if (!r) return notFound(reply, "relatório");
    const e = setBaseline(
      cfg.dataDir,
      r.report,
      path.relative(cfg.root, path.join(r.dir, "report.json")),
    );
    const { report: _r, ...meta } = e;
    return meta;
  });

  app.delete<{ Params: { scenario: string } }>("/api/baselines/:scenario", async (req, reply) => {
    if (!clearBaseline(cfg.dataDir, req.params.scenario)) return notFound(reply, "baseline");
    return reply.code(204).send();
  });

  app.post<{
    Body: { a: string; b: string; alpha?: number; minEffectPct?: number; blockSeconds?: number };
  }>(
    "/api/compare",
    {
      schema: {
        body: {
          type: "object",
          required: ["a", "b"],
          additionalProperties: false,
          properties: {
            a: { type: "string" },
            b: { type: "string" },
            alpha: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 },
            minEffectPct: { type: "number", minimum: 0, maximum: 1000 },
            blockSeconds: { type: "integer", minimum: 1, maximum: 120 },
          },
        },
      },
    },
    async (req, reply) => {
      const a = reportOf(req.body.a);
      const b = reportOf(req.body.b);
      if (!a || !b) return notFound(reply, "relatório");
      return compareRuns(a.report, b.report, {
        alpha: req.body.alpha,
        minEffectPct: req.body.minEffectPct,
        blockSeconds: req.body.blockSeconds,
      });
    },
  );

  // ---------------------------------------------------------------- controle (scripts)

  app.post("/api/_control/shutdown", async (req, reply) => {
    const got = req.headers["x-lt-control-token"];
    if (!opts.controlToken || typeof got !== "string" || !safeEqual(got, opts.controlToken)) {
      return reply.code(403).send({ error: "token de controle inválido" });
    }
    setImmediate(() => opts.onShutdownRequest?.());
    return reply.code(202).send({ status: "shutting-down" });
  });

  // ---------------------------------------------------------------- dashboard (SPA)

  const dist = opts.webDist ?? path.join(cfg.root, "packages", "web", "dist");
  const hasWeb = fs.existsSync(path.join(dist, "index.html"));
  if (hasWeb)
    await app.register(fastifyStatic, { root: dist, wildcard: false, index: ["index.html"] });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === "GET" && !req.url.startsWith("/api/") && hasWeb) {
      return reply.type("text/html; charset=utf-8").sendFile("index.html");
    }
    if (req.method === "GET" && req.url === "/" && !hasWeb) {
      return reply
        .type("text/html; charset=utf-8")
        .send(
          `<!doctype html><meta charset="utf-8"><title>lt</title><body style="font-family:system-ui;padding:2rem">` +
            `<h1>lt</h1><p>API no ar (v${VERSION}), mas o dashboard não foi compilado. Rode <code>npm run setup</code>.</p></body>`,
        );
    }
    return reply.code(404).send({ error: "rota não encontrada" });
  });

  // preClose: antes de parar de aceitar conexões, interrompe execuções (salvando o parcial) e
  // encerra os fluxos SSE, que de outro modo segurariam o close do servidor.
  app.addHook("preClose", async () => {
    await runs.stopAll();
    hub.close();
  });
  app.addHook("onClose", async () => store.close());

  return app;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
