#!/usr/bin/env node
// npm start [-- --with-demo] [-- --foreground] [-- --dev] [-- --open]
import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  ROOT,
  c,
  confirm,
  dirs,
  fetchJson,
  inspect,
  isAlive,
  killTree,
  log,
  openBrowser,
  parseArgs,
  portInUse,
  portOwner,
  removeRunFiles,
  requireNode,
  rotateLog,
  services,
  setupState,
  tail,
  waitFor,
} from "./lib.mjs";

const flags = parseArgs(process.argv.slice(2), ["dev", "foreground", "open", "with-demo"]);
requireNode();

// 1) Setup feito?
const setup = setupState();
if (!setup.ok) {
  log.warn(`setup incompleto: falta ${setup.missing.join(", ")}`);
  if (await confirm("Rodar `npm run setup` agora?")) {
    const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "setup.mjs")], {
      stdio: "inherit",
      cwd: ROOT,
    });
    if (r.status !== 0) process.exit(r.status ?? 1);
  } else {
    log.info(`Rode ${c.cyan("npm run setup")} e depois ${c.cyan("npm start")}.`);
    process.exit(1);
  }
}
fs.mkdirSync(dirs.run, { recursive: true });
fs.mkdirSync(dirs.logs, { recursive: true });

const svc = services();
const wanted = flags["with-demo"] ? [svc.demo, svc.server] : [svc.server];
const foreground = flags.foreground || flags.dev;

/** Verifica estado e porta; devolve true se o serviço precisa ser iniciado. */
async function prepare(s) {
  const st = await inspect(s);
  if (st.state === "running") {
    log.ok(
      `${s.name} já está rodando (PID ${st.pid}) em ${s.url}${st.recovered ? c.dim(" — PID recuperado pelo health") : ""}`,
    );
    if (st.recovered)
      writeRunFiles(s, st.pid, { instanceId: st.health?.instanceId, recovered: true });
    return false;
  }
  if (st.state === "stale") {
    log.warn(`${s.name}: arquivo de PID obsoleto (PID ${st.pid}, ${st.reason}); removendo`);
    removeRunFiles(s);
  }
  if (await portInUse(s.port, s.host)) {
    const owner = portOwner(s.port);
    log.err(
      `porta ${s.port} (${s.name}) já está em uso` +
        (owner ? ` pelo PID ${owner.pid} (${owner.name})` : "") +
        ". Não encerro processos que não são do lt.",
    );
    log.info(
      `Libere a porta ou altere ${s.name === "server" ? "LT_PORT" : "LT_DEMO_PORT"} no .env.`,
    );
    process.exit(1);
  }
  return true;
}

function writeRunFiles(s, pid, extra) {
  fs.writeFileSync(s.pidFile, String(pid));
  fs.writeFileSync(
    s.metaFile,
    JSON.stringify(
      {
        pid,
        name: s.name,
        port: s.port,
        entry: s.entry,
        startedAt: new Date().toISOString(),
        ...extra,
      },
      null,
      2,
    ),
  );
}

async function startDetached(s) {
  rotateLog(s.logFile);
  const fd = fs.openSync(s.logFile, "a");
  const instanceId = randomUUID();
  const controlToken = randomBytes(24).toString("hex");
  const child = spawn(process.execPath, [s.entry], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", fd, fd],
    windowsHide: true,
    env: {
      ...process.env,
      LT_INSTANCE_ID: instanceId,
      LT_CONTROL_TOKEN: controlToken,
      LT_SERVICE_PORT: String(s.port),
    },
  });
  fs.closeSync(fd);
  let exited = null;
  child.once("exit", (code) => (exited = code ?? -1));
  writeRunFiles(s, child.pid, { instanceId, controlToken });
  child.unref();

  const healthy = await waitFor(async () => {
    if (exited !== null) return true;
    const h = await fetchJson(s.url + s.healthPath);
    return h?.ok && h.body?.instanceId === instanceId;
  }, 20_000);
  if (!healthy || exited !== null) {
    log.err(
      `${s.name} não respondeu em ${s.healthPath}${exited !== null ? ` (saiu com código ${exited})` : " em 20s"}.`,
    );
    const t = tail(s.logFile);
    if (t) console.error(c.dim(t.replace(/^/gm, "    ")));
    if (exited === null && isAlive(child.pid)) killTree(child.pid, { force: true });
    removeRunFiles(s);
    process.exit(1);
  }
  log.ok(
    `${s.name} iniciado (PID ${child.pid}) em ${c.cyan(s.url)}  ${c.dim(`log: ${path.relative(ROOT, s.logFile)}`)}`,
  );
}

async function runForeground(s) {
  const instanceId = randomUUID();
  const controlToken = randomBytes(24).toString("hex");
  const args = flags.dev
    ? [
        path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"),
        "watch",
        "--clear-screen=false",
        s.devEntry,
      ]
    : [s.entry];
  log.step(
    `${s.name} em primeiro plano${flags.dev ? " com hot reload (tsx watch)" : ""} — Ctrl+C para parar`,
  );
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      LT_INSTANCE_ID: instanceId,
      LT_CONTROL_TOKEN: controlToken,
      LT_SERVICE_PORT: String(s.port),
    },
  });
  writeRunFiles(s, child.pid, { instanceId, controlToken, dev: !!flags.dev, foreground: true });
  const cleanup = () => removeRunFiles(s);
  process.on("SIGINT", () => {}); // o filho recebe o Ctrl+C do console e encerra sozinho
  if (flags.open) {
    waitFor(async () => (await fetchJson(s.url + s.healthPath))?.ok, 30_000).then(
      (ok) => ok && openBrowser(s.url),
    );
  }
  child.on("exit", (code) => {
    cleanup();
    process.exit(code ?? 0);
  });
}

const toStart = [];
for (const s of wanted) if (await prepare(s)) toStart.push(s);

for (const s of toStart) {
  if (foreground && s === svc.server) continue;
  await startDetached(s);
}

if (foreground && toStart.includes(svc.server)) {
  await runForeground(svc.server);
} else {
  console.log(`\nDashboard/API: ${c.cyan(svc.server.url)}   health: ${svc.server.url}/api/health`);
  if (flags["with-demo"])
    console.log(
      `Alvo de demonstração: ${c.cyan(svc.demo.url)}  (rotas: /fast /slow?ms= /flaky?rate= /echo)`,
    );
  console.log(c.dim("Parar: npm run stop   Status: npm run status\n"));
  if (flags.open) openBrowser(svc.server.url);
}
