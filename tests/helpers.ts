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
export async function startDemo(): Promise<{ url: string; stop: () => Promise<void> }> {
  const port = await freePort();
  const child: ChildProcess = spawn(
    process.execPath,
    [path.join(ROOT, "packages/demo-target/dist/main.js")],
    {
      env: { ...process.env, LT_SERVICE_PORT: String(port) },
      stdio: "ignore",
    },
  );
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) break;
    } catch {
      /* ainda subindo */
    }
    if (Date.now() > deadline) throw new Error("demo-target não subiu");
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    url,
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
