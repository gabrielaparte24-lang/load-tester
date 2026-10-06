// Utilitários compartilhados pelos scripts de operação (setup/start/stop/status/restart).
// Somente módulos nativos do Node: precisa rodar antes do `npm install`.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MIN_NODE = [22, 19, 0];
export const IS_WIN = process.platform === "win32";

// ---------- saída ----------
// Saída fechada (ex.: `npm run stop | head`) não pode interromper o encerramento no meio.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (e) => {
    if (e.code !== "EPIPE") throw e;
  });
}
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const c = {
  red: paint(31),
  green: paint(32),
  yellow: paint(33),
  cyan: paint(36),
  dim: paint(2),
  bold: paint(1),
};
const fancy = !IS_WIN || process.env.WT_SESSION || process.env.TERM_PROGRAM;
const sym = fancy
  ? { ok: "✔", warn: "⚠", err: "✖", step: "→", info: "•" }
  : { ok: "[ok]", warn: "[!]", err: "[x]", step: "->", info: "-" };
export const log = {
  ok: (m) => console.log(`${c.green(sym.ok)} ${m}`),
  warn: (m) => console.log(`${c.yellow(sym.warn)} ${m}`),
  err: (m) => console.error(`${c.red(sym.err)} ${m}`),
  step: (m) => console.log(`${c.cyan(sym.step)} ${m}`),
  info: (m) => console.log(`${c.dim(sym.info)} ${m}`),
};

// ---------- argumentos ----------
export function parseArgs(argv, known) {
  const flags = {};
  for (const a of argv) {
    const m = /^--([a-z0-9-]+)(?:=(.*))?$/.exec(a);
    if (!m || !known.includes(m[1])) {
      log.err(`opção desconhecida: ${a}`);
      log.info(`opções válidas: ${known.map((k) => `--${k}`).join(" ")}`);
      process.exit(2);
    }
    flags[m[1]] = m[2] ?? true;
  }
  return flags;
}

// ---------- ambiente ----------
export function nodeVersionOk() {
  const v = process.versions.node.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (v[i] !== MIN_NODE[i]) return v[i] > MIN_NODE[i];
  }
  return true;
}

export function requireNode() {
  if (nodeVersionOk()) return;
  log.err(`Node ${process.versions.node} detectado; é necessário Node >= ${MIN_NODE.join(".")}.`);
  log.info("Instale a versão LTS em https://nodejs.org ou via gerenciador:");
  log.info(
    IS_WIN
      ? "  winget install OpenJS.NodeJS.LTS   (ou nvm-windows: nvm install lts)"
      : "  nvm install --lts && nvm use --lts   (ou fnm/volta/asdf)",
  );
  process.exit(1);
}

export function readEnv() {
  const env = {};
  const file = fs.existsSync(path.join(ROOT, ".env")) ? ".env" : ".env.example";
  const p = path.join(ROOT, file);
  if (fs.existsSync(p)) {
    for (const raw of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      let v = line.slice(eq + 1).trim();
      if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
      env[line.slice(0, eq).trim()] = v;
    }
  }
  return { ...env, ...pick(process.env, Object.keys(env)) };
}

function pick(obj, keys) {
  return Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));
}

export const dirs = {
  run: path.join(ROOT, "run"),
  logs: path.join(ROOT, "logs"),
};

export function services() {
  const env = readEnv();
  const def = (name, port, entry, devEntry, health, shutdown, signature) => ({
    name,
    port: Number(port),
    host: "127.0.0.1",
    entry: path.join(ROOT, entry),
    devEntry: path.join(ROOT, devEntry),
    healthPath: health,
    shutdownPath: shutdown,
    signature,
    pidFile: path.join(dirs.run, `${name}.pid`),
    metaFile: path.join(dirs.run, `${name}.json`),
    logFile: path.join(dirs.logs, `${name}.log`),
    get url() {
      return `http://${this.host}:${this.port}`;
    },
  });
  return {
    server: def(
      "server",
      env.LT_PORT || 4000,
      "packages/server/dist/main.js",
      "packages/server/src/main.ts",
      "/api/health",
      "/api/_control/shutdown",
      "lt-server",
    ),
    demo: def(
      "demo-target",
      env.LT_DEMO_PORT || 4100,
      "packages/demo-target/dist/main.js",
      "packages/demo-target/src/main.ts",
      "/health",
      "/__lt/shutdown",
      "lt-demo-target",
    ),
  };
}

// ---------- setup ----------
export function setupState() {
  const missing = [];
  if (!fs.existsSync(path.join(ROOT, "node_modules"))) missing.push("dependências (node_modules)");
  const svc = services();
  if (
    !fs.existsSync(svc.server.entry) ||
    !fs.existsSync(path.join(ROOT, "packages/cli/dist/index.js"))
  )
    missing.push("build dos pacotes (dist)");
  if (!fs.existsSync(path.join(ROOT, "packages/web/dist/index.html")))
    missing.push("build do dashboard");
  if (!fs.existsSync(path.join(ROOT, ".env"))) missing.push("arquivo .env");
  return { ok: missing.length === 0, missing };
}

export function runNpm(args, opts = {}) {
  // Quando chamado via `npm run`, reutiliza o mesmo npm; senão usa o do PATH (no Windows, npm.cmd exige shell).
  const execPath = process.env.npm_execpath;
  const r =
    execPath && execPath.endsWith(".js")
      ? spawnSync(process.execPath, [execPath, ...args], { cwd: ROOT, stdio: "inherit", ...opts })
      : spawnSync("npm", args, { cwd: ROOT, stdio: "inherit", shell: IS_WIN, ...opts });
  return r.status ?? 1;
}

// ---------- processos ----------
export function isAlive(pid) {
  if (!pid || !Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

export function commandLineOf(pid) {
  try {
    if (IS_WIN) {
      const r = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`,
        ],
        { encoding: "utf8", windowsHide: true, timeout: 15000 },
      );
      return (r.stdout || "").trim();
    }
    if (fs.existsSync(`/proc/${pid}/cmdline`)) {
      return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim();
    }
    const r = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
    return (r.stdout || "").trim();
  } catch {
    return "";
  }
}

const norm = (s) => s.replace(/\\/g, "/").toLowerCase();

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function readPid(file) {
  try {
    const n = Number(fs.readFileSync(file, "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function removeRunFiles(svc) {
  for (const f of [svc.pidFile, svc.metaFile]) fs.rmSync(f, { force: true });
}

export async function fetchJson(url, { method = "GET", headers = {}, timeoutMs = 1500 } = {}) {
  try {
    const res = await fetch(url, { method, headers, signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, body };
  } catch {
    return null;
  }
}

/**
 * Estado de um serviço gerenciado:
 *  running  — PID vivo e confirmado como nosso (health com o mesmo instanceId, ou linha de comando com nosso entry)
 *  stale    — arquivo de PID aponta para processo morto ou reaproveitado por outro programa
 *  stopped  — sem PID e porta sem um serviço nosso
 */
export async function inspect(svc) {
  const pid = readPid(svc.pidFile);
  const meta = readJson(svc.metaFile);
  const health = await fetchJson(svc.url + svc.healthPath);
  const healthOurs = health?.ok && health.body?.service === svc.signature;

  if (pid) {
    if (!isAlive(pid)) return { state: "stale", pid, meta, reason: "processo não existe mais" };
    if (healthOurs && meta?.instanceId && health.body.instanceId === meta.instanceId) {
      return { state: "running", pid, meta, health: health.body };
    }
    const cmd = norm(commandLineOf(pid));
    const entries = [svc.entry, svc.devEntry].map(norm);
    if (entries.some((e) => cmd.includes(e)) || (meta?.dev && cmd.includes("tsx"))) {
      return { state: "running", pid, meta, health: healthOurs ? health.body : null };
    }
    return { state: "stale", pid, meta, reason: "PID reaproveitado por outro processo" };
  }
  if (healthOurs) {
    // Nosso serviço respondendo sem arquivo de PID (ex.: arquivo apagado à mão): recupera pelo health.
    return {
      state: "running",
      pid: health.body.pid,
      meta: null,
      health: health.body,
      recovered: true,
    };
  }
  return { state: "stopped" };
}

export function killTree(pid, { force = false } = {}) {
  try {
    if (IS_WIN) {
      spawnSync("taskkill", ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      // Iniciado com detached: o PID é líder do grupo; o sinal negativo atinge a árvore inteira.
      try {
        process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
      } catch {
        process.kill(pid, force ? "SIGKILL" : "SIGTERM");
      }
    }
  } catch {
    /* já encerrado */
  }
}

export async function waitFor(fn, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return !!(await fn());
}

// ---------- portas ----------
export function portInUse(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    sock.setTimeout(800);
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("timeout", () => {
      sock.destroy();
      resolve(false);
    });
    sock.once("error", () => {
      // ninguém aceitando conexões; confirma tentando escutar
      const srv = net.createServer();
      srv.once("error", () => resolve(true));
      srv.listen(port, host, () => srv.close(() => resolve(false)));
    });
  });
}

export function portOwner(port) {
  try {
    if (IS_WIN) {
      const r = spawnSync("netstat", ["-ano", "-p", "tcp"], {
        encoding: "utf8",
        windowsHide: true,
      });
      for (const line of (r.stdout || "").split(/\r?\n/)) {
        const cols = line.trim().split(/\s+/);
        if (cols.length >= 5 && /LISTEN/i.test(cols[3]) && cols[1].endsWith(`:${port}`)) {
          const pid = Number(cols[4]);
          const t = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
            encoding: "utf8",
            windowsHide: true,
          });
          const name = (t.stdout || "").split(",")[0]?.replace(/"/g, "").trim();
          return { pid, name: name || "?" };
        }
      }
      return null;
    }
    const r = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"], {
      encoding: "utf8",
    });
    const pid = Number(/^p(\d+)/m.exec(r.stdout || "")?.[1]);
    const name = /^c(.+)$/m.exec(r.stdout || "")?.[1];
    if (pid) return { pid, name: name || "?" };
    const s = spawnSync("ss", ["-ltnpH", `sport = :${port}`], { encoding: "utf8" });
    const m = /users:\(\("([^"]+)",pid=(\d+)/.exec(s.stdout || "");
    return m ? { pid: Number(m[2]), name: m[1] } : null;
  } catch {
    return null;
  }
}

// ---------- logs ----------
export function rotateLog(file, maxBytes = 5 * 1024 * 1024, keep = 3) {
  try {
    if (!fs.existsSync(file) || fs.statSync(file).size < maxBytes) return;
    for (let i = keep - 1; i >= 1; i--) {
      if (fs.existsSync(`${file}.${i}`)) fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    }
    fs.renameSync(file, `${file}.1`);
  } catch {
    /* rotação é melhor esforço */
  }
}

export function tail(file, lines = 15) {
  try {
    return fs.readFileSync(file, "utf8").trimEnd().split(/\r?\n/).slice(-lines).join("\n");
  } catch {
    return "";
  }
}

// ---------- interação ----------
export function confirm(question, defaultYes = true) {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} ${defaultYes ? "[S/n]" : "[s/N]"} `, (a) => {
      rl.close();
      const t = a.trim().toLowerCase();
      resolve(t ? t.startsWith("s") || t.startsWith("y") : defaultYes);
    });
  });
}

export function openBrowser(url) {
  const [cmd, args] = IS_WIN
    ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin"
      ? ["open", [url]]
      : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true }).unref();
  } catch {
    /* sem navegador disponível */
  }
}
