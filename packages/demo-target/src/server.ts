import http from "node:http";
import http2 from "node:http2";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { PreciseScheduler } from "@lt/core";

/**
 * Servidor-alvo de demonstração, com latência e erros controláveis:
 *   GET  /fast                      200 imediato
 *   GET  /slow?ms=100&jitter=0      200 após ms (± jitter uniforme), com timer preciso
 *   GET  /flaky?rate=0.05&status=500  falha com probabilidade `rate`
 *   GET  /flaky?every=20            falha exatamente a cada 20ª chamada (determinístico, para testes)
 *   ANY  /echo                      devolve método, query, headers e corpo
 *   GET  /status/:code              responde com o status pedido
 *   GET  /bytes?n=1024              corpo com n bytes
 *   GET  /products?page=1           lista paginada (para cenários encadeados)
 *   GET  /products/:id              detalhe
 *   GET  /health                    identificação do serviço
 */
export interface DemoOptions {
  host?: string;
  port?: number;
  instanceId?: string;
  controlToken?: string;
  onShutdown?: () => void;
}

const MAX_SLEEP_MS = 60_000;
const MAX_BYTES = 10 * 1024 * 1024;

export type DemoHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

export function createDemoServer(opts: DemoOptions = {}): http.Server {
  const server = http.createServer(createDemoHandler(opts));
  server.keepAliveTimeout = 30_000;
  return server;
}

/**
 * Mesmas rotas em HTTP/2 sem TLS (h2c, "conhecimento prévio"), para testar HTTP/2 sem certificados.
 * A API de compatibilidade do http2 aceita o mesmo handler.
 */
export function createDemoH2Server(opts: DemoOptions = {}): http2.Http2Server {
  return http2.createServer(
    createDemoHandler(opts) as unknown as Parameters<typeof http2.createServer>[0],
  );
}

export function createDemoHandler(opts: DemoOptions = {}): DemoHandler {
  const timer = new PreciseScheduler();
  const instanceId = opts.instanceId ?? randomUUID();
  const startedAt = Date.now();
  let served = 0;
  let flakyCalls = 0;

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    });
    res.end(payload);
  };

  return (req, res) => {
    served++;
    const url = new URL(req.url ?? "/", "http://demo");
    const q = url.searchParams;
    const num = (name: string, def: number) => {
      const v = Number(q.get(name) ?? def);
      return Number.isFinite(v) ? v : def;
    };
    const parts = url.pathname.split("/").filter(Boolean);

    switch (parts[0] ?? "") {
      case "fast":
        return json(res, 200, { ok: true });

      case "slow": {
        const ms = Math.min(MAX_SLEEP_MS, Math.max(0, num("ms", 100)));
        const jitter = Math.max(0, num("jitter", 0));
        const delay = Math.max(0, ms + (jitter ? (Math.random() * 2 - 1) * jitter : 0));
        void timer
          .sleep(delay)
          .then(() => json(res, 200, { ok: true, delayMs: Math.round(delay * 1000) / 1000 }));
        return;
      }

      case "flaky": {
        const status = num("status", 500);
        const every = Math.floor(num("every", 0));
        const fail =
          every > 0
            ? ++flakyCalls % every === 0
            : Math.random() < Math.min(1, Math.max(0, num("rate", 0.1)));
        return fail
          ? json(res, status, { ok: false, error: "falha simulada" })
          : json(res, 200, { ok: true });
      }

      case "echo": {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (c: Buffer) => {
          size += c.length;
          if (size <= MAX_BYTES) chunks.push(c);
        });
        req.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let body: unknown = raw;
          if ((req.headers["content-type"] ?? "").includes("json")) {
            try {
              body = JSON.parse(raw);
            } catch {
              /* mantém texto */
            }
          }
          json(res, 200, {
            method: req.method,
            path: url.pathname,
            query: Object.fromEntries(q),
            headers: req.headers,
            body,
          });
        });
        return;
      }

      case "status": {
        const code = Number(parts[1]);
        return json(res, code >= 200 && code <= 599 ? code : 400, { status: code });
      }

      case "bytes": {
        const n = Math.min(MAX_BYTES, Math.max(0, Math.floor(num("n", 1024))));
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": n });
        return res.end(Buffer.alloc(n, 97));
      }

      case "products": {
        if (parts[1]) {
          const id = Number(parts[1]);
          if (!Number.isInteger(id) || id < 1)
            return json(res, 404, { error: "produto não encontrado" });
          return json(res, 200, { id, name: `Produto ${id}`, price: (id * 7.3) % 500 });
        }
        const page = Math.max(1, Math.floor(num("page", 1)));
        const items = Array.from({ length: 10 }, (_, i) => {
          const id = (page - 1) * 10 + i + 1;
          return { id, name: `Produto ${id}` };
        });
        return json(res, 200, { page, items });
      }

      case "health":
        return json(res, 200, {
          status: "ok",
          service: "lt-demo-target",
          instanceId,
          pid: process.pid,
          uptimeMs: Date.now() - startedAt,
          served,
        });

      case "__lt":
        if (
          parts[1] === "shutdown" &&
          req.method === "POST" &&
          authorized(req, opts.controlToken)
        ) {
          res.setHeader("connection", "close");
          json(res, 202, { status: "shutting-down" });
          opts.onShutdown?.();
          return;
        }
        return json(res, 404, { error: "não encontrado" });

      default:
        return json(res, 404, {
          error: "não encontrado",
          routes: [
            "/fast",
            "/slow?ms=",
            "/flaky?rate=",
            "/echo",
            "/status/:code",
            "/bytes?n=",
            "/products",
            "/health",
          ],
        });
    }
  };
}

function authorized(req: http.IncomingMessage, token?: string): boolean {
  const got = req.headers["x-lt-control-token"];
  if (!token || typeof got !== "string") return false;
  const a = Buffer.from(got);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
