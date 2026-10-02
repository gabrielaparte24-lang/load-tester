#!/usr/bin/env node
// npm run status — estado do setup, dos serviços e de testes em andamento.
import fs from "node:fs";
import path from "node:path";
import {
  c,
  dirs,
  inspect,
  isAlive,
  log,
  readJson,
  requireNode,
  services,
  setupState,
} from "./lib.mjs";

requireNode();
const setup = setupState();
if (setup.ok) log.ok("setup completo");
else log.warn(`setup incompleto: falta ${setup.missing.join(", ")} (rode npm run setup)`);

for (const s of Object.values(services())) {
  const st = await inspect(s);
  if (st.state === "running") {
    const up = st.health?.uptimeMs ? ` há ${formatUptime(st.health.uptimeMs)}` : "";
    const mode = st.meta?.dev ? " [dev]" : st.meta?.foreground ? " [primeiro plano]" : "";
    log.ok(
      `${s.name.padEnd(12)} rodando  PID ${st.pid}${mode}  ${c.cyan(s.url)}${up}${st.health ? "" : c.yellow("  (sem resposta do health)")}`,
    );
  } else if (st.state === "stale") {
    log.warn(`${s.name.padEnd(12)} parado   (PID obsoleto ${st.pid}: ${st.reason})`);
  } else {
    log.info(`${s.name.padEnd(12)} parado   porta ${s.port}`);
  }
}

const runs = fs.existsSync(dirs.run)
  ? fs.readdirSync(dirs.run).filter((f) => /^cli-\d+\.json$/.test(f))
  : [];
for (const f of runs) {
  const m = readJson(path.join(dirs.run, f));
  if (m?.pid && isAlive(m.pid))
    log.step(`teste em andamento: "${m.scenario}" (PID ${m.pid}, desde ${m.startedAt})`);
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  return s < 60
    ? `${s}s`
    : s < 3600
      ? `${Math.floor(s / 60)}m${s % 60}s`
      : `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

process.exit(0);
