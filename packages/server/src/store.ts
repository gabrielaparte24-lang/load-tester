import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parse as parseYaml } from "yaml";
import { slugify, type RunReport } from "@lt/core";

/**
 * Persistência local em SQLite (node:sqlite, sem compilação nativa): cenários e histórico de
 * execuções. Os relatórios completos ficam em reports/<id>/ (o banco guarda o índice e o resumo).
 * Baselines usam o mesmo armazenamento do CLI (data/baselines), para valerem nos dois.
 */
/** Exemplos adicionados depois da primeira versão do banco (importados também em bancos antigos). */
const LATER_EXAMPLES = new Set([
  "examples/websocket.yaml",
  "examples/grpc.yaml",
  "examples/grpc-streaming.yaml",
]);

export interface ScenarioRow {
  id: string;
  name: string;
  yaml: string;
  baseDir: string;
  createdAt: string;
  updatedAt: string;
}

export type RunSource = "api" | "cli";

export interface RunRow {
  id: string;
  scenarioId: string | null;
  scenario: string;
  source: RunSource;
  status: "running" | "completed" | "interrupted" | "failed";
  model: string | null;
  baseUrl: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  requests: number | null;
  errorRate: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  rps: number | null;
  invalid: boolean;
  thresholdsPassed: number | null;
  thresholdsTotal: number | null;
  reportDir: string | null;
  error: string | null;
}

const SCHEMA_VERSION = 1;

export class Store {
  readonly db: DatabaseSync;

  constructor(readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scenarios (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, yaml TEXT NOT NULL, base_dir TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, scenario_id TEXT, scenario TEXT NOT NULL, source TEXT NOT NULL,
        status TEXT NOT NULL, model TEXT, base_url TEXT, started_at TEXT NOT NULL, ended_at TEXT,
        duration_ms REAL, requests INTEGER, error_rate REAL, p50 REAL, p95 REAL, p99 REAL, rps REAL,
        invalid INTEGER NOT NULL DEFAULT 0, thresholds_passed INTEGER, thresholds_total INTEGER,
        report_dir TEXT, error TEXT
      );
      CREATE INDEX IF NOT EXISTS runs_started ON runs (started_at DESC);
      CREATE INDEX IF NOT EXISTS runs_scenario ON runs (scenario);
    `);
    this.db
      .prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)")
      .run(String(SCHEMA_VERSION));
  }

  meta(key: string): string | undefined {
    const r = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      { value: string } | undefined;
    return r?.value;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  close(): void {
    this.db.close();
  }

  // ------------------------------------------------------------ cenários

  private toScenario = (r: Record<string, unknown>): ScenarioRow => ({
    id: r.id as string,
    name: r.name as string,
    yaml: r.yaml as string,
    baseDir: r.base_dir as string,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  });

  listScenarios(): Omit<ScenarioRow, "yaml">[] {
    return (
      this.db.prepare("SELECT * FROM scenarios ORDER BY name COLLATE NOCASE").all() as Record<
        string,
        unknown
      >[]
    )
      .map(this.toScenario)
      .map(({ yaml: _y, ...rest }) => rest);
  }

  getScenario(id: string): ScenarioRow | null {
    const r = this.db.prepare("SELECT * FROM scenarios WHERE id = ?").get(id) as
      Record<string, unknown> | undefined;
    return r ? this.toScenario(r) : null;
  }

  /** Nome do cenário a partir do YAML (rascunhos inválidos também podem ser salvos). */
  static nameOf(yaml: string): string {
    try {
      const doc = parseYaml(yaml) as { name?: unknown } | null;
      if (doc && typeof doc.name === "string" && doc.name.trim()) return doc.name.trim();
    } catch {
      /* rascunho com YAML inválido */
    }
    return "sem nome";
  }

  createScenario(yaml: string, baseDir: string, preferredId?: string): ScenarioRow {
    const name = Store.nameOf(yaml);
    const base = slugify(preferredId ?? name);
    let id = base;
    for (let i = 2; this.getScenario(id); i++) id = `${base}-${i}`;
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO scenarios (id, name, yaml, base_dir, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, name, yaml, baseDir, now, now);
    return this.getScenario(id)!;
  }

  updateScenario(id: string, yaml: string): ScenarioRow | null {
    const r = this.db
      .prepare("UPDATE scenarios SET yaml = ?, name = ?, updated_at = ? WHERE id = ?")
      .run(yaml, Store.nameOf(yaml), new Date().toISOString(), id);
    return r.changes ? this.getScenario(id) : null;
  }

  deleteScenario(id: string): boolean {
    return this.db.prepare("DELETE FROM scenarios WHERE id = ?").run(id).changes > 0;
  }

  /**
   * Importa os exemplos do projeto como cenários. Cada arquivo é importado uma única vez (mesmo que
   * o usuário apague o cenário depois); exemplos novos de versões futuras entram na próxima subida.
   */
  seedExamples(root: string): number {
    const done = new Set<string>(JSON.parse(this.meta("seededExamples") ?? "[]") as string[]);
    // bancos anteriores só marcavam "seeded": considera importados os exemplos que já existiam então
    const legacy = !!this.meta("seeded") && !this.meta("seededExamples");
    let n = 0;
    for (const sub of ["examples", "examples/perfis"]) {
      const dir = path.join(root, sub);
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir).filter((x) => /.ya?ml$/.test(x) && !x.startsWith("ci"))) {
        const key = `${sub}/${f}`;
        if (done.has(key)) continue;
        done.add(key);
        if (legacy && !LATER_EXAMPLES.has(key)) continue;
        const yaml = fs.readFileSync(path.join(dir, f), "utf8");
        this.createScenario(
          yaml,
          dir,
          `${sub.endsWith("perfis") ? "perfil-" : ""}${f.replace(/.ya?ml$/, "")}`,
        );
        n++;
      }
    }
    this.setMeta("seededExamples", JSON.stringify([...done].sort()));
    if (!this.meta("seeded")) this.setMeta("seeded", new Date().toISOString());
    return n;
  }

  // ------------------------------------------------------------ execuções

  private toRun = (r: Record<string, unknown>): RunRow => ({
    id: r.id as string,
    scenarioId: (r.scenario_id as string) ?? null,
    scenario: r.scenario as string,
    source: r.source as RunSource,
    status: r.status as RunRow["status"],
    model: (r.model as string) ?? null,
    baseUrl: (r.base_url as string) ?? null,
    startedAt: r.started_at as string,
    endedAt: (r.ended_at as string) ?? null,
    durationMs: (r.duration_ms as number) ?? null,
    requests: (r.requests as number) ?? null,
    errorRate: (r.error_rate as number) ?? null,
    p50: (r.p50 as number) ?? null,
    p95: (r.p95 as number) ?? null,
    p99: (r.p99 as number) ?? null,
    rps: (r.rps as number) ?? null,
    invalid: !!r.invalid,
    thresholdsPassed: (r.thresholds_passed as number) ?? null,
    thresholdsTotal: (r.thresholds_total as number) ?? null,
    reportDir: (r.report_dir as string) ?? null,
    error: (r.error as string) ?? null,
  });

  insertRunning(r: {
    id: string;
    scenarioId: string | null;
    scenario: string;
    model: string;
    baseUrl: string;
    startedAt: string;
  }): void {
    this.db
      .prepare(
        "INSERT INTO runs (id, scenario_id, scenario, source, status, model, base_url, started_at) VALUES (?, ?, ?, 'api', 'running', ?, ?, ?)",
      )
      .run(r.id, r.scenarioId, r.scenario, r.model, r.baseUrl, r.startedAt);
  }

  /** Grava (ou atualiza) o resumo de uma execução terminada a partir do relatório. */
  saveReport(
    report: RunReport,
    reportDir: string,
    source: RunSource,
    scenarioId: string | null,
  ): void {
    const s = report.summary;
    const passed = report.thresholds.filter((t) => t.passed).length;
    this.db
      .prepare(
        `INSERT INTO runs (id, scenario_id, scenario, source, status, model, base_url, started_at, ended_at, duration_ms,
           requests, error_rate, p50, p95, p99, rps, invalid, thresholds_passed, thresholds_total, report_dir)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, ended_at = excluded.ended_at,
           duration_ms = excluded.duration_ms, requests = excluded.requests, error_rate = excluded.error_rate,
           p50 = excluded.p50, p95 = excluded.p95, p99 = excluded.p99, rps = excluded.rps, invalid = excluded.invalid,
           thresholds_passed = excluded.thresholds_passed, thresholds_total = excluded.thresholds_total,
           report_dir = excluded.report_dir, error = NULL`,
      )
      .run(
        report.run.id,
        scenarioId,
        report.run.scenario,
        source,
        report.run.status,
        report.run.model,
        report.config.target.baseUrl,
        report.run.startedAt,
        report.run.endedAt,
        report.run.durationMs,
        s.requests.total,
        s.errorRate,
        s.latencyMs.p50,
        s.latencyMs.p95,
        s.latencyMs.p99,
        s.rps.achieved,
        report.run.invalid ? 1 : 0,
        passed,
        report.thresholds.length,
        reportDir,
      );
  }

  failRun(id: string, error: string): void {
    this.db
      .prepare("UPDATE runs SET status = 'failed', ended_at = ?, error = ? WHERE id = ?")
      .run(new Date().toISOString(), error, id);
  }

  getRun(id: string): RunRow | null {
    const r = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as
      Record<string, unknown> | undefined;
    return r ? this.toRun(r) : null;
  }

  listRuns(f: {
    scenario?: string;
    status?: string;
    q?: string;
    limit?: number;
    offset?: number;
  }): { total: number; items: RunRow[] } {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (f.scenario) {
      where.push("scenario = ?");
      args.push(f.scenario);
    }
    if (f.status) {
      where.push("status = ?");
      args.push(f.status);
    }
    if (f.q) {
      where.push("(scenario LIKE ? OR id LIKE ? OR base_url LIKE ?)");
      args.push(`%${f.q}%`, `%${f.q}%`, `%${f.q}%`);
    }
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM runs ${w}`).get(...args) as { n: number }
    ).n;
    const items = (
      this.db
        .prepare(`SELECT * FROM runs ${w} ORDER BY started_at DESC LIMIT ? OFFSET ?`)
        .all(...args, Math.min(f.limit ?? 50, 500), f.offset ?? 0) as Record<string, unknown>[]
    ).map(this.toRun);
    return { total, items };
  }

  scenarioNames(): string[] {
    return (
      this.db
        .prepare("SELECT DISTINCT scenario FROM runs ORDER BY scenario COLLATE NOCASE")
        .all() as { scenario: string }[]
    ).map((r) => r.scenario);
  }

  countRunsByStatus(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.db
      .prepare("SELECT status, COUNT(*) AS n FROM runs GROUP BY status")
      .all() as { status: string; n: number }[]) {
      out[r.status] = r.n;
    }
    return out;
  }

  /** Execuções que ficaram "running" (servidor encerrado à força) viram "failed". */
  recoverStale(): number {
    return Number(
      this.db
        .prepare(
          "UPDATE runs SET status = 'failed', error = 'servidor encerrado durante a execução' WHERE status = 'running'",
        )
        .run().changes,
    );
  }

  /** Importa execuções feitas pelo CLI (reports/<id>/report.json) que o banco ainda não conhece. */
  syncReports(reportsDir: string): number {
    if (!fs.existsSync(reportsDir)) return 0;
    const known = new Set(
      (
        this.db.prepare("SELECT report_dir FROM runs WHERE report_dir IS NOT NULL").all() as {
          report_dir: string;
        }[]
      ).map((r) => path.resolve(r.report_dir)),
    );
    let n = 0;
    for (const d of fs.readdirSync(reportsDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const dir = path.resolve(reportsDir, d.name);
      const file = path.join(dir, "report.json");
      if (known.has(dir) || !fs.existsSync(file)) continue;
      try {
        const report = JSON.parse(fs.readFileSync(file, "utf8")) as RunReport;
        if (report.schemaVersion !== 1 || !report.run?.id) continue;
        if (this.getRun(report.run.id)) continue;
        this.saveReport(report, dir, "cli", null);
        n++;
      } catch {
        /* relatório corrompido ou de outra ferramenta: ignora */
      }
    }
    return n;
  }
}
