import { randomUUID, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { VERSION, getConfig, type LtConfig } from "@lt/core";

export interface AppOptions {
  config?: LtConfig;
  instanceId?: string;
  controlToken?: string;
  logger?: boolean | { level: string };
  /** Chamado quando o script `stop` pede encerramento gracioso. */
  onShutdownRequest?: () => void;
}

const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const cfg = opts.config ?? getConfig();
  const instanceId = opts.instanceId ?? randomUUID();
  const startedAt = Date.now();
  const app = Fastify({
    // o logger padrão do Fastify registra método e URL, nunca headers (que podem conter segredos)
    logger: opts.logger ?? false,
  });

  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || LOOPBACK_ORIGIN.test(origin)),
  });

  // Defesa contra DNS rebinding: só aceita Host de loopback.
  app.addHook("onRequest", async (req, reply) => {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) {
      return reply.code(421).send({ error: "host não permitido" });
    }
  });

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
    pid: process.pid,
    uptimeMs: Date.now() - startedAt,
    memory: process.memoryUsage().rss,
    limits: {
      maxRps: cfg.maxRps,
      maxConnections: cfg.maxConnections,
      maxDurationMs: cfg.maxDurationMs,
    },
    allowedTargets: ["localhost", "127.0.0.1", "::1", ...cfg.allowedTargets],
    activeRuns: 0,
  }));

  app.post("/api/_control/shutdown", async (req, reply) => {
    const got = req.headers["x-lt-control-token"];
    if (!opts.controlToken || typeof got !== "string" || !safeEqual(got, opts.controlToken)) {
      return reply.code(403).send({ error: "token de controle inválido" });
    }
    setImmediate(() => opts.onShutdownRequest?.());
    return reply.code(202).send({ status: "shutting-down" });
  });

  app.get("/", async (_req, reply) =>
    reply
      .type("text/html; charset=utf-8")
      .send(
        `<!doctype html><meta charset="utf-8"><title>lt</title><body style="font-family:system-ui;padding:2rem">` +
          `<h1>lt — load tester</h1><p>API no ar (v${VERSION}). O dashboard chega na Fase 5.</p>` +
          `<p><a href="/api/health">/api/health</a> · <a href="/api/status">/api/status</a></p></body>`,
      ),
  );

  return app;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
