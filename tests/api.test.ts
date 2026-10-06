import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { getConfig } from "../packages/core/src/index.js";
import { buildApp } from "../packages/server/src/app.js";

let app: FastifyInstance;
let shutdownRequested = 0;
let tmp: string;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lt-api-"));
  app = await buildApp({
    config: {
      ...getConfig(),
      dataDir: path.join(tmp, "data"),
      reportsDir: path.join(tmp, "reports"),
    },
    controlToken: "segredo-de-teste",
    onShutdownRequest: () => shutdownRequested++,
    seed: false,
  });
});
afterAll(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const H = { host: "127.0.0.1:4000" };

describe("API: segurança e controle", () => {
  it("GET /api/health identifica o serviço", async () => {
    const res = await app.inject({ url: "/api/health", headers: H });
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
      headers: { ...H, origin: "http://localhost:5173" },
    });
    expect(ok.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    const bad = await app.inject({
      url: "/api/health",
      headers: { ...H, origin: "https://evil.example.com" },
    });
    expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("CSRF: POST de origem externa é recusado", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/scenarios",
      headers: { ...H, origin: "https://evil.example.com" },
      payload: { yaml: "name: x" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("shutdown de controle exige o token", async () => {
    const denied = await app.inject({
      method: "POST",
      url: "/api/_control/shutdown",
      headers: { ...H, "x-lt-control-token": "errado" },
    });
    expect(denied.statusCode).toBe(403);
    const ok = await app.inject({
      method: "POST",
      url: "/api/_control/shutdown",
      headers: { ...H, "x-lt-control-token": "segredo-de-teste" },
    });
    expect(ok.statusCode).toBe(202);
    await new Promise((r) => setImmediate(r));
    expect(shutdownRequested).toBe(1);
  });
});
