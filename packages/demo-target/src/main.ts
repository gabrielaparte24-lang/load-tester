import { getConfig } from "@lt/core";
import { createDemoH2Server, createDemoServer } from "./server.js";

const cfg = getConfig();
const port = Number(process.env.LT_SERVICE_PORT || cfg.demoPort);

const demoOpts = {
  instanceId: process.env.LT_INSTANCE_ID,
  controlToken: process.env.LT_CONTROL_TOKEN,
  onShutdown: () => shutdown("pedido de controle"),
};
const server = createDemoServer(demoOpts);
// HTTP/2 sem TLS (h2c) na porta seguinte; opcional: se a porta estiver ocupada, só avisa
const h2Port = Number(process.env.LT_DEMO_H2_PORT || port + 1);
const h2 = createDemoH2Server(demoOpts);

let closing = false;
function shutdown(reason: string): void {
  if (closing) return;
  closing = true;
  console.log(`[demo-target] encerrando (${reason})`);
  h2.close();
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

h2.on("error", (err: NodeJS.ErrnoException) => {
  console.warn(
    `[demo-target] HTTP/2 (h2c) indisponível em ${cfg.host}:${h2Port}: ${err.code ?? err.message}`,
  );
});
h2.listen(h2Port, cfg.host, () => {
  console.log(`[demo-target] HTTP/2 (h2c) em http://${cfg.host}:${h2Port}`);
});
