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
  // Fase 5: interromper execuções em andamento e salvar resultados parciais aqui.
  const force = setTimeout(() => process.exit(0), 5000);
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
