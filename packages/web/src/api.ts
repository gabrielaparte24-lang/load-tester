import type {
  ComparisonResult,
  ProgressSnapshot,
  RunReport,
  ScenarioIssue,
  PreviewRequest,
} from "@lt/core";

export type { ComparisonResult, ProgressSnapshot, RunReport, ScenarioIssue, PreviewRequest };

export interface ScenarioMeta {
  id: string;
  name: string;
  baseDir: string;
  createdAt: string;
  updatedAt: string;
}
export interface ScenarioRow extends ScenarioMeta {
  yaml: string;
}

export interface ValidateResult {
  valid: boolean;
  issues: ScenarioIssue[];
  summary?: {
    name: string;
    baseUrl: string;
    model: "open" | "closed";
    durationMs: number;
    peakRps: number | null;
    peakVus: number;
    flows: { name: string; weight: number; steps: number }[];
    thresholds: string[];
  };
  preview?: PreviewRequest[];
}

export interface RunRow {
  id: string;
  scenarioId: string | null;
  scenario: string;
  source: "api" | "cli";
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
  error: string | null;
  isBaseline?: boolean;
}

export interface LogLine {
  ts: string;
  level: "info" | "warn" | "error";
  msg: string;
}

export interface ActiveRun {
  id: string;
  scenario: string;
  scenarioId: string | null;
  baseUrl: string;
  model: "open" | "closed";
  startedAt: string;
  totalMs: number;
  peakRps: number;
  peakVus: number;
  workers: number;
  stages: { durationMs: number }[];
  warmupMs: number;
  thresholds: string[];
  last: ProgressSnapshot | null;
}

export interface StatusInfo {
  version: string;
  node: string;
  platform: string;
  pid: number;
  uptimeMs: number;
  memoryMb: number;
  limits: { maxRps: number; maxConnections: number; maxDurationMs: number; maxVus: number };
  allowedTargets: string[];
  activeRuns: ActiveRun[];
  sseClients: number;
  storage: {
    database: string;
    reportsDir: string;
    runs: Record<string, number>;
    scenarios: number;
    baselines: number;
  };
  notice: string;
}

export interface TargetConfirmation {
  code: "target_confirmation_required";
  error: string;
  needs: "flag" | "confirm" | "mismatch";
  target: { host: string; addresses: string[] };
  load: {
    model: string;
    peakRps: number;
    peakVus: number;
    durationMs: number;
    expectedRequests: number | null;
  };
  notice: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(typeof body.error === "string" ? body.error : `erro HTTP ${status}`);
  }
}

export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
      headers: init.body !== undefined ? { "content-type": "application/json" } : undefined,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: init.signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(0, {
      error: "sem conexão com o servidor do lt (ele está rodando? npm start)",
    });
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    /* corpo não JSON */
  }
  if (!res.ok)
    throw new ApiError(
      res.status,
      (body && typeof body === "object" ? body : { error: String(body) }) as Record<
        string,
        unknown
      >,
    );
  return body as T;
}

// ---------- formatação

export const fmt = (v: number | null | undefined, d = 2): string =>
  v === null || v === undefined || !Number.isFinite(v)
    ? "—"
    : Math.abs(v) >= 1000
      ? Math.round(v).toLocaleString("pt-BR")
      : Math.abs(v) >= 100
        ? v.toFixed(0)
        : v.toFixed(d);

export const pct = (v: number | null | undefined): string =>
  v === null || v === undefined ? "—" : `${(v * 100).toFixed(2)}%`;

export function dur(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? `${s % 60}s` : ""}`;
  return `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ""}`;
}

export const when = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "medium" }) : "—";
