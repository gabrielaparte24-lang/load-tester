import { getConfig } from "@lt/core";
import { buildApp } from "./app.js";

const cfg = getConfig();
const port = Number(process.env.LT_SERVICE_PORT || cfg.port);

let closing = false;
const app = await buildApp({
  config: cfg,
  instanceId: process.env.LT_INSTANCE_ID,
  controlToken: process.env.LT_CONTROL_TOKEN,
  logger: { level: cfg.logLevel },
  onShutdownRequest: () => void shutdown("pedido de controle"),
});

async function shutdown(reason: string): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info(`encerrando (${reason})`);
  // app.close() interrompe execuções em andamento e espera os relatórios parciais (ver preClose)
  const force = setTimeout(() => process.exit(0), 20_000);
  force.unref();
  await app.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: cfg.host, port });
} catch (err) {
  app.log.error(
    `não foi possível escutar em ${cfg.host}:${port}: ${(err as NodeJS.ErrnoException).code ?? err}`,
  );
  process.exit(1);
}
