import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../packages/server/src/app.js";

let app: FastifyInstance;
let shutdownRequested = 0;

beforeAll(async () => {
  app = await buildApp({
    controlToken: "segredo-de-teste",
    onShutdownRequest: () => shutdownRequested++,
  });
});
afterAll(async () => {
  await app.close();
});

describe("API", () => {
  it("GET /api/health identifica o serviço", async () => {
    const res = await app.inject({ url: "/api/health", headers: { host: "127.0.0.1:4000" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", service: "lt-server" });
  });

  it("recusa Host que não é loopback (DNS rebinding)", async () => {
    const res = await app.inject({ url: "/api/health", headers: { host: "evil.example.com" } });
    expect(res.statusCode).toBe(421);
  });

  it("CORS só libera origens localhost", async () => {
    const ok = await app.inject({
      url: "/api/health",
      headers: { host: "127.0.0.1", origin: "http://localhost:5173" },
    });
    expect(ok.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    const bad = await app.inject({
      url: "/api/health",
      headers: { host: "127.0.0.1", origin: "https://evil.example.com" },
    });
    expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("shutdown de controle exige o token", async () => {
    const denied = await app.inject({
      method: "POST",
      url: "/api/_control/shutdown",
      headers: { host: "127.0.0.1", "x-lt-control-token": "errado" },
    });
    expect(denied.statusCode).toBe(403);
    const ok = await app.inject({
      method: "POST",
      url: "/api/_control/shutdown",
      headers: { host: "127.0.0.1", "x-lt-control-token": "segredo-de-teste" },
    });
    expect(ok.statusCode).toBe(202);
    await new Promise((r) => setImmediate(r));
    expect(shutdownRequested).toBe(1);
  });
});
