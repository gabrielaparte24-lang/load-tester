#!/usr/bin/env node
// npm run setup [-- --skip-build] [-- --force]
// Verifica pré-requisitos, instala dependências, compila e prepara diretórios. Idempotente.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { IS_WIN, MIN_NODE, ROOT, c, log, parseArgs, requireNode, runNpm } from "./lib.mjs";

const flags = parseArgs(process.argv.slice(2), ["skip-build", "force"]);
const summary = [];
const t0 = Date.now();

console.log(c.bold("\nlt — setup\n"));

// 1) Node e npm
requireNode();
log.ok(`Node ${process.versions.node} (mínimo ${MIN_NODE.join(".")})`);
const npmV = process.env.npm_execpath
  ? spawnSync(process.execPath, [process.env.npm_execpath, "-v"], { encoding: "utf8" })
  : spawnSync("npm", ["-v"], { encoding: "utf8", shell: IS_WIN });
if (npmV.status !== 0) {
  log.err(
    "npm não encontrado. Ele acompanha o Node.js: reinstale o Node LTS (https://nodejs.org).",
  );
  process.exit(1);
}
log.ok(`npm ${npmV.stdout.trim()}`);

// 2) Dependências
const lock = path.join(ROOT, "package-lock.json");
const installedMarker = path.join(ROOT, "node_modules", ".package-lock.json");
const upToDate =
  fs.existsSync(installedMarker) &&
  fs.existsSync(lock) &&
  fs.statSync(installedMarker).mtimeMs >= fs.statSync(lock).mtimeMs;
if (upToDate && !flags.force) {
  log.ok("dependências já instaladas (use --force para reinstalar)");
  summary.push("dependências: já atualizadas");
} else {
  const cmd = fs.existsSync(lock) ? "ci" : "install";
  log.step(`npm ${cmd}…`);
  if (runNpm([cmd, "--no-audit", "--no-fund"]) !== 0) {
    log.err(
      `npm ${cmd} falhou. Verifique a conexão/proxy e rode novamente (npm run setup -- --force).`,
    );
    process.exit(1);
  }
  summary.push(`dependências: npm ${cmd}`);
}

// 3) Build
if (flags["skip-build"]) {
  log.warn("build pulado (--skip-build)");
  summary.push("build: pulado");
} else {
  log.step("compilando pacotes (tsc -b)…");
  if (runNpm(["run", "build", "--silent"]) !== 0) {
    log.err("build falhou; veja os erros acima.");
    process.exit(1);
  }
  log.ok("pacotes compilados");
  summary.push("build: ok");
}

// 4) .env
const env = path.join(ROOT, ".env");
if (fs.existsSync(env)) {
  log.ok(".env já existe (mantido)");
} else {
  fs.copyFileSync(path.join(ROOT, ".env.example"), env);
  log.ok(".env criado a partir de .env.example");
  summary.push(".env: criado");
}

// 5) Diretórios
for (const d of ["data", "reports", "logs", "run"])
  fs.mkdirSync(path.join(ROOT, d), { recursive: true });
log.ok("diretórios data/ reports/ logs/ run/ prontos");

console.log(c.bold(`\nSetup concluído em ${((Date.now() - t0) / 1000).toFixed(1)}s.`));
for (const s of summary) log.info(s);
console.log(
  `\nPróximo passo: ${c.cyan("npm start")}  ${c.dim("(ou npm start -- --with-demo para subir também o alvo de demonstração)")}\n`,
);
