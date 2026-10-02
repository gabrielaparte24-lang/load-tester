import { getConfig } from "@lt/core";
import { createDemoServer } from "./server.js";

const cfg = getConfig();
const port = Number(process.env.LT_SERVICE_PORT || cfg.demoPort);

const server = createDemoServer({
  instanceId: process.env.LT_INSTANCE_ID,
  controlToken: process.env.LT_CONTROL_TOKEN,
  onShutdown: () => shutdown("pedido de controle"),
});

let closing = false;
function shutdown(reason: string): void {
  if (closing) return;
  closing = true;
  console.log(`[demo-target] encerrando (${reason})`);
  server.close(() => process.exit(0));
  // conexões keep-alive ficam ociosas assim que a resposta em andamento termina
  setInterval(() => server.closeIdleConnections(), 50).unref();
  setTimeout(() => {
    server.closeAllConnections();
    process.exit(0);
  }, 3000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

server.on("error", (err: NodeJS.ErrnoException) => {
  console.error(`[demo-target] erro ao escutar em ${cfg.host}:${port}: ${err.code ?? err.message}`);
  process.exit(1);
});

server.listen(port, cfg.host, () => {
  console.log(`[demo-target] pid ${process.pid} ouvindo em http://${cfg.host}:${port}`);
});
