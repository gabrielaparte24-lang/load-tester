import type http from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { WebSocketServer, type WebSocket } from "ws";

const MAX_SLEEP_MS = 60_000;

/** Arquivo .proto do serviço gRPC de demonstração. */
export const DEMO_PROTO = fileURLToPath(new URL("../proto/demo.proto", import.meta.url));

/**
 * WebSocket de demonstração no mesmo servidor HTTP:
 *   /ws/echo?delay=0&welcome=0
 * Cada mensagem é devolvida. Se for JSON, a resposta é {"echo": <mensagem>, "n": <nº da mensagem>}.
 * Com welcome=1, envia {"type":"welcome","session":"<uuid>"} ao conectar.
 */
export function attachDemoWebSocket(server: http.Server): { closeAll: () => void } {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
    handleProtocols: (protocols) => protocols.values().next().value ?? false,
  });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws/echo") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const delay = Math.min(MAX_SLEEP_MS, Math.max(0, Number(url.searchParams.get("delay")) || 0));
    const welcome = url.searchParams.get("welcome") === "1";
    wss.handleUpgrade(req, socket, head, (ws) => onSession(ws, delay, welcome));
  });

  function onSession(ws: WebSocket, delay: number, welcome: boolean): void {
    let n = 0;
    ws.on("error", () => ws.terminate());
    if (welcome) ws.send(JSON.stringify({ type: "welcome", session: randomUUID() }));
    ws.on("message", (data, isBinary) => {
      n++;
      let reply: string | Buffer = data as Buffer;
      if (!isBinary) {
        const text = data.toString();
        try {
          reply = JSON.stringify({ echo: JSON.parse(text), n });
        } catch {
          reply = text; // texto puro: eco literal
        }
      }
      const send = () => ws.readyState === ws.OPEN && ws.send(reply, { binary: isBinary });
      if (delay) setTimeout(send, delay);
      else send();
    });
  }

  return {
    closeAll: () => {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}

interface HelloReply {
  message: string;
  length: number;
  tags: string[];
  served_at: string;
  metadata: Record<string, string>;
}

/** Servidor gRPC de demonstração (Greeter em proto/demo.proto). */
export function createDemoGrpcServer(): grpc.Server {
  const def = protoLoader.loadSync(DEMO_PROTO, { keepCase: true, longs: String, defaults: true });
  const pkg = grpc.loadPackageDefinition(def) as unknown as {
    demo: { Greeter: grpc.ServiceClientConstructor };
  };
  const server = new grpc.Server();
  let flakyCalls = 0;

  const reply = (name: string, md: grpc.Metadata, times = 1): HelloReply => {
    const message = Array.from(
      { length: Math.max(1, Math.min(times || 1, 100)) },
      () => `Olá, ${name || "mundo"}!`,
    ).join(" ");
    const metadata: Record<string, string> = {};
    for (const [k, v] of Object.entries(md.getMap())) if (typeof v === "string") metadata[k] = v;
    return {
      message,
      length: message.length,
      tags: ["demo", "grpc"],
      served_at: String(Date.now()),
      metadata,
    };
  };

  type Unary<Req> = grpc.handleUnaryCall<Req, HelloReply>;
  const SayHello: Unary<{ name: string; times: number }> = (call, cb) =>
    cb(null, reply(call.request.name, call.metadata, call.request.times));
  const Slow: Unary<{ ms: number; name: string }> = (call, cb) => {
    const ms = Math.min(MAX_SLEEP_MS, Math.max(0, call.request.ms || 0));
    const t = setTimeout(() => cb(null, reply(call.request.name, call.metadata)), ms);
    call.on("cancelled", () => clearTimeout(t));
  };
  const Flaky: Unary<{ every: number; rate: number; code: number }> = (call, cb) => {
    const { every, rate, code } = call.request;
    flakyCalls++;
    const fail = every > 0 ? flakyCalls % every === 0 : Math.random() < (rate || 0);
    if (fail) cb({ code: code || grpc.status.UNAVAILABLE, details: "falha simulada" }, null);
    else cb(null, reply("flaky", call.metadata));
  };
  const Chat: grpc.handleBidiStreamingCall<{ name: string }, HelloReply> = (call) => {
    call.on("data", (m: { name: string }) => call.write(reply(m.name, call.metadata)));
    call.on("end", () => call.end());
  };
  server.addService(pkg.demo.Greeter.service, { SayHello, Slow, Flaky, Chat });
  return server;
}

/** Sobe o gRPC em host:port (sem TLS). Resolve com a porta efetiva. */
export function listenGrpc(server: grpc.Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) =>
    server.bindAsync(`${host}:${port}`, grpc.ServerCredentials.createInsecure(), (err, p) =>
      err ? reject(err) : resolve(p),
    ),
  );
}
