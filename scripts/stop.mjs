#!/usr/bin/env node
// npm run stop [-- --clean-logs] [-- --timeout=10]
// Encerra apenas processos do lt: testes em andamento no CLI (salvando o parcial), servidor e demo-target.
import fs from "node:fs";
import path from "node:path";
import {
  IS_WIN,
  ROOT,
  c,
  commandLineOf,
  dirs,
  fetchJson,
  inspect,
  isAlive,
  killTree,
  log,
  parseArgs,
  portInUse,
  readJson,
  removeRunFiles,
  services,
  waitFor,
} from "./lib.mjs";

// via npx o caminho passa por node_modules/@lt/cli; direto, por packages/cli
const CLI_ENTRY = /(@lt|packages)\/cli\/(bin\/lt\.js|dist\/index\.js)/;
const flags = parseArgs(process.argv.slice(2), ["clean-logs", "timeout"]);
const timeoutMs = Math.max(1, Number(flags.timeout ?? 10)) * 1000;
let failures = 0;

async function terminate(pid, label, graceful) {
  const t0 = Date.now();
  if (graceful) await graceful();
  if (await waitFor(() => !isAlive(pid), timeoutMs)) {
    log.ok(
      `${label} encerrado graciosamente (PID ${pid}, ${((Date.now() - t0) / 1000).toFixed(1)}s)`,
    );
    return true;
  }
  log.warn(`${label} não encerrou em ${timeoutMs / 1000}s; forçando (árvore de processos)`);
  if (!IS_WIN) {
    killTree(pid);
    if (await waitFor(() => !isAlive(pid), 3000)) return true;
  }
  killTree(pid, { force: true });
  const dead = await waitFor(() => !isAlive(pid), 5000);
  if (dead) log.ok(`${label} encerrado à força (PID ${pid})`);
  else log.err(`não foi possível encerrar ${label} (PID ${pid})`);
  return dead;
}

// 1) Testes em andamento iniciados pelo CLI: pede parada pelo arquivo .stop (o CLI salva o relatório parcial).
const cliRuns = fs.existsSync(dirs.run)
  ? fs.readdirSync(dirs.run).filter((f) => /^cli-\d+\.json$/.test(f))
  : [];
for (const f of cliRuns) {
  const meta = readJson(path.join(dirs.run, f));
  const pid = meta?.pid;
  const stopFile = path.join(dirs.run, f.replace(/\.json$/, ".stop"));
  const ours =
    pid && isAlive(pid) && CLI_ENTRY.test(commandLineOf(pid).replace(/\\+/g, "/").toLowerCase());
  if (!ours) {
    log.info(`registro de teste obsoleto removido (${f})`);
    fs.rmSync(path.join(dirs.run, f), { force: true });
    fs.rmSync(stopFile, { force: true });
    continue;
  }
  log.step(
    `interrompendo teste "${meta.scenario}" (PID ${pid}); o resultado parcial será salvo como "interrompido"`,
  );
  if (
    !(await terminate(pid, `teste "${meta.scenario}"`, async () =>
      fs.writeFileSync(stopFile, "stop"),
    ))
  )
    failures++;
  fs.rmSync(path.join(dirs.run, f), { force: true });
  fs.rmSync(stopFile, { force: true });
}

// 2) Servidor e demo-target.
const svc = services();
for (const s of [svc.server, svc.demo]) {
  const st = await inspect(s);
  if (st.state === "stopped") {
    log.info(`${s.name} não está rodando`);
    removeRunFiles(s);
    continue;
  }
  if (st.state === "stale") {
    log.warn(`${s.name}: PID ${st.pid} obsoleto (${st.reason}); nada a encerrar, arquivo removido`);
    removeRunFiles(s);
    continue;
  }
  const token = st.meta?.controlToken;
  const graceful = async () => {
    if (token) {
      const r = await fetchJson(s.url + s.shutdownPath, {
        method: "POST",
        headers: { "x-lt-control-token": token },
      });
      if (r?.status === 202) {
        // Modo --dev: o servidor (filho do `tsx watch`) encerra sozinho, mas o watcher continua
        // esperando mudanças; depois que o servidor sai, o watcher pode ser encerrado sem perda.
        if (st.meta?.dev) {
          const inner = st.health?.pid;
          if (inner && inner !== st.pid) await waitFor(() => !isAlive(inner), timeoutMs);
          killTree(st.pid, { force: IS_WIN });
        }
        return;
      }
    }
    if (!IS_WIN) killTree(st.pid); // SIGTERM para o grupo
  };
  if (!(await terminate(st.pid, s.name, graceful))) {
    failures++;
    continue;
  }
  removeRunFiles(s);
  const freed = await waitFor(async () => !(await portInUse(s.port, s.host)), 5000);
  if (freed) log.ok(`porta ${s.port} liberada`);
  else {
    log.err(`porta ${s.port} continua ocupada`);
    failures++;
  }
}

// 3) Logs
if (flags["clean-logs"] && fs.existsSync(dirs.logs)) {
  let n = 0;
  for (const f of fs.readdirSync(dirs.logs)) {
    if (/\.log(\.\d+)?$/.test(f)) {
      fs.rmSync(path.join(dirs.logs, f), { force: true });
      n++;
    }
  }
  log.ok(`${n} arquivo(s) de log removido(s) de ${path.relative(ROOT, dirs.logs)}/`);
}

if (failures) {
  log.err(c.bold(`${failures} problema(s) ao parar; veja acima.`));
  process.exit(1);
}
console.log(c.dim("Tudo parado."));
