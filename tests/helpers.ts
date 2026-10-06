import net from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

export const ROOT = path.resolve(import.meta.dirname, "..");

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/** Sobe o demo-target compilado em processo separado (para não disputar o event loop do gerador). */
export async function startDemo(): Promise<{
  url: string;
  h2Url: string;
  /** gRPC (Greeter) sem TLS: http://127.0.0.1:<porta> */
  grpcUrl: string;
  stop: () => Promise<void>;
}> {
  const port = await freePort();
  const h2Port = await freePort();
  const grpcPort = await freePort();
  const child: ChildProcess = spawn(
    process.execPath,
    [path.join(ROOT, "packages/demo-target/dist/main.js")],
    {
      env: {
        ...process.env,
        LT_SERVICE_PORT: String(port),
        LT_DEMO_H2_PORT: String(h2Port),
        LT_DEMO_GRPC_PORT: String(grpcPort),
      },
      stdio: "ignore",
    },
  );
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok && (await canConnect(grpcPort))) break;
    } catch {
      /* ainda subindo */
    }
    if (Date.now() > deadline) throw new Error("demo-target não subiu");
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    url,
    h2Url: `http://127.0.0.1:${h2Port}`,
    grpcUrl: `http://127.0.0.1:${grpcPort}`,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        const guard = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 5000);
        child.once("exit", () => {
          clearTimeout(guard);
          resolve();
        });
        child.kill();
      }),
  };
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1");
    sock.once("connect", () => (sock.destroy(), resolve(true)));
    sock.once("error", () => resolve(false));
  });
}
