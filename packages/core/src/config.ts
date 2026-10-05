import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDuration } from "./duration.js";
import { ConfigError } from "./errors.js";

export interface LtConfig {
  root: string;
  /** O dashboard escuta apenas em loopback. */
  host: "127.0.0.1";
  port: number;
  demoPort: number;
  dataDir: string;
  reportsDir: string;
  logsDir: string;
  runDir: string;
  maxRps: number;
  maxConnections: number;
  maxDurationMs: number;
  maxVus: number;
  allowedTargets: string[];
  logLevel: string;
}

/** Sobe a partir deste arquivo até o package.json com "workspaces" (raiz do monorepo). */
export function findProjectRoot(start?: string): string {
  if (process.env.LT_ROOT) return path.resolve(process.env.LT_ROOT);
  let dir = start ?? path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { workspaces?: unknown };
        if (Array.isArray(pkg.workspaces)) return dir;
      } catch {
        // package.json inválido: continua subindo
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir)
      throw new ConfigError("raiz do projeto não encontrada (package.json com workspaces)");
    dir = parent;
  }
}

/** Lê KEY=VALUE de um arquivo .env sem sobrescrever variáveis já definidas no ambiente. */
export function loadEnvFile(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/** Resolve um caminho relativo à raiz e recusa qualquer coisa fora do projeto. */
export function resolveInside(root: string, p: string, label = "caminho"): string {
  const resolved = path.resolve(root, p);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new ConfigError(`${label} "${p}" fica fora da pasta do projeto (${root}); recusado`);
  }
  return resolved;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0)
    throw new ConfigError(`${name}="${raw}" deve ser um inteiro positivo`);
  return n;
}

let cached: LtConfig | undefined;

export function getConfig(opts: { reload?: boolean } = {}): LtConfig {
  if (cached && !opts.reload) return cached;
  const root = findProjectRoot();
  loadEnvFile(path.join(root, ".env"));
  const env = process.env;
  cached = {
    root,
    host: "127.0.0.1",
    port: intEnv("LT_PORT", 4000),
    demoPort: intEnv("LT_DEMO_PORT", 4100),
    dataDir: resolveInside(root, env.LT_DATA_DIR || "./data", "LT_DATA_DIR"),
    reportsDir: resolveInside(root, env.LT_REPORTS_DIR || "./reports", "LT_REPORTS_DIR"),
    logsDir: resolveInside(root, "./logs"),
    runDir: resolveInside(root, "./run"),
    maxRps: intEnv("LT_MAX_RPS", 2000),
    maxConnections: intEnv("LT_MAX_CONNECTIONS", 512),
    maxDurationMs: parseDuration(env.LT_MAX_DURATION || "2h", "LT_MAX_DURATION"),
    maxVus: intEnv("LT_MAX_VUS", 1000),
    allowedTargets: (env.ALLOWED_TARGETS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    logLevel: env.LT_LOG_LEVEL || "info",
  };
  return cached;
}
