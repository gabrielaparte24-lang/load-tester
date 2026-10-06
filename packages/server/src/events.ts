import type { ServerResponse } from "node:http";

/**
 * Server-Sent Events: um fluxo único (/api/events) com eventos tipados. SSE em vez de WebSocket
 * porque o tráfego é só servidor → navegador, reconecta sozinho e passa por qualquer proxy HTTP.
 */
export type ServerEvent =
  | { type: "run-started"; run: unknown }
  | { type: "progress"; runId: string; p: unknown }
  | { type: "log"; runId: string; line: LogLine }
  | { type: "run-finished"; run: unknown }
  | { type: "scenarios-changed" };

export interface LogLine {
  ts: string;
  level: "info" | "warn" | "error";
  msg: string;
}

export class EventHub {
  private clients = new Set<ServerResponse>();
  private heartbeat: NodeJS.Timeout;

  constructor() {
    this.heartbeat = setInterval(() => {
      for (const c of this.clients) c.write(": ping\n\n");
    }, 15_000);
    this.heartbeat.unref();
  }

  get size(): number {
    return this.clients.size;
  }

  add(res: ServerResponse, hello: unknown): void {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(`retry: 2000\nevent: hello\ndata: ${JSON.stringify(hello)}\n\n`);
    this.clients.add(res);
    res.on("close", () => this.clients.delete(res));
  }

  emit(e: ServerEvent): void {
    const msg = `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
    for (const c of this.clients) c.write(msg);
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const c of this.clients) c.end();
    this.clients.clear();
  }
}
