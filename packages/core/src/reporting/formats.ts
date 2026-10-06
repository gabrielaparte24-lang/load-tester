import type { BenchReport } from "../bench.js";
import type { ComparisonResult, MetricComparison } from "../compare.js";
import { formatDuration } from "../duration.js";
import type { RunReport } from "../report.js";
import { fmtNum } from "./charts.js";

const pct = (v: number) => `${(v * 100).toFixed(2)}%`;

// ------------------------------------------------------------------ CSV

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? "" : String(v);
  // aspas quando necessário; "=+-@" no início neutralizado contra injeção de fórmula em planilhas
  const safe = /^[=+\-@]/.test(s) && Number.isNaN(Number(s)) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const csv = (rows: unknown[][]) => rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

/** Linha do tempo por segundo (uma linha por segundo). */
export function timelineCsv(r: RunReport): string {
  return csv([
    [
      "t_s",
      "warmup",
      "target_rps",
      "sent",
      "requests",
      "errors",
      "concurrency",
      "p50_ms",
      "p95_ms",
      "p99_ms",
      "max_ms",
      "cpu_pct",
      "mem_pct",
    ],
    ...r.timeline.map((p) => [
      p.t,
      p.warmup ? 1 : 0,
      p.targetRps,
      p.sentRps,
      p.rps,
      p.errors,
      p.concurrency,
      p.latencyMs.p50,
      p.latencyMs.p95,
      p.latencyMs.p99,
      p.latencyMs.max,
      p.cpu ?? "",
      p.memPct ?? "",
    ]),
  ]);
}

/** Métricas por etapa (endpoint). */
export function stepsCsv(r: RunReport): string {
  return csv([
    [
      "flow",
      "step",
      "method",
      "path",
      "requests",
      "errors",
      "error_rate",
      "p50_ms",
      "p90_ms",
      "p95_ms",
      "p99_ms",
      "p999_ms",
      "max_ms",
      "mean_ms",
      "bytes_received",
      "bytes_sent",
    ],
    ...r.steps.map((s) => [
      s.flow,
      s.name,
      s.method,
      s.path,
      s.requests,
      s.errors,
      s.errorRate,
      s.latencyMs.p50,
      s.latencyMs.p90,
      s.latencyMs.p95,
      s.latencyMs.p99,
      s.latencyMs.p999,
      s.latencyMs.max,
      s.latencyMs.mean,
      s.bytes.received,
      s.bytes.sent,
    ]),
  ]);
}

export function benchCsv(b: BenchReport): string {
  return csv([
    [
      "group",
      "scenario",
      "run",
      "status",
      "invalid",
      "p50_ms",
      "p90_ms",
      "p95_ms",
      "p99_ms",
      "mean_ms",
      "rps",
      "error_rate",
      "requests",
    ],
    ...b.groups.flatMap((g) =>
      g.runs.map((r) => [
        g.label,
        g.scenario,
        r.id,
        r.status,
        r.invalid ? 1 : 0,
        r.p50,
        r.p90,
        r.p95,
        r.p99,
        r.mean,
        r.rps,
        r.errorRate,
        r.requests,
      ]),
    ),
  ]);
}

// ------------------------------------------------------------------ Markdown

const mdEsc = (s: string) => s.replace(/([\\`*_{}[\]<>|])/g, "\\$1");
/** Code span: escapes não valem lá dentro; só evita fechar a crase e quebrar a tabela. */
const mdCode = (s: string) => "`" + s.replace(/`/g, "'").replace(/\|/g, "\\|") + "`";

function mdComparison(c: ComparisonResult): string {
  const f = (x: number, m: MetricComparison) =>
    !Number.isFinite(x) ? "—" : m.unit === "%" ? pct(x) : fmtNum(x);
  const icon = (m: MetricComparison) =>
    m.verdict === "pior"
      ? "❌ pior"
      : m.verdict === "melhor"
        ? "✅ melhor"
        : m.verdict === "pequena"
          ? "⚠️ pequena"
          : m.verdict;
  return [
    `| métrica | ${mdEsc(c.a.label)} | ${mdEsc(c.b.label)} | Δ% | IC 95% (B−A) | p (Holm) | veredito |`,
    "|---|--:|--:|--:|--:|--:|---|",
    ...c.metrics.map(
      (m) =>
        `| ${m.label}${m.unit === "ms" ? " (ms)" : ""} | ${f(m.a, m)} | ${f(m.b, m)} | ${
          m.deltaPct === null ? "—" : `${m.deltaPct > 0 ? "+" : ""}${m.deltaPct.toFixed(1)}%`
        } | ${Number.isFinite(m.ci.lo) ? `[${f(m.ci.lo, m)}, ${f(m.ci.hi, m)}]` : "—"} | ${
          Number.isFinite(m.pAdj) ? m.pAdj.toFixed(3) : "—"
        } | ${icon(m)} |`,
    ),
    "",
    `**${mdEsc(c.conclusion)}**`,
    ...c.warnings.map((w) => `> ⚠️ ${mdEsc(w)}`),
  ].join("\n");
}

/** Resumo para colar em PR (ou em $GITHUB_STEP_SUMMARY). */
export function runMarkdown(
  r: RunReport,
  extras: { comparison?: ComparisonResult; reportPath?: string } = {},
): string {
  const s = r.summary;
  const l = s.latencyMs;
  const thresholdsOk = r.thresholds.every((t) => t.passed);
  const regression = extras.comparison?.regression ?? false;
  const ok = r.run.status === "completed" && !r.run.invalid && thresholdsOk && !regression;
  const out: string[] = [];
  out.push(
    `### ${ok ? "✅" : "❌"} lt · ${mdEsc(r.run.scenario)} — ${ok ? "aprovado" : "reprovado"}`,
  );
  out.push("");
  out.push(
    `${mdCode(r.config.target.baseUrl)} · modelo ${r.run.model === "open" ? "aberto" : "fechado"} · ${formatDuration(r.run.durationMs)} · ${r.generator.workers} worker(s) · seed ${r.run.seed}`,
  );
  out.push("");
  for (const m of r.run.invalidReasons) out.push(`> ❌ ${mdEsc(m)}`);
  if (r.run.status !== "completed")
    out.push(`> ⚠️ execução ${r.run.status === "interrupted" ? "interrompida" : r.run.status}`);
  if (r.run.stopReason) out.push(`> ⚠️ ${mdEsc(r.run.stopReason)}`);
  if (r.run.invalidReasons.length || r.run.status !== "completed" || r.run.stopReason) out.push("");
  out.push("| métrica | valor |", "|---|--:|");
  out.push(
    `| requisições | ${s.requests.total.toLocaleString("pt-BR")} (${s.requests.failed.toLocaleString("pt-BR")} com falha) |`,
  );
  out.push(`| taxa de erro | ${pct(s.errorRate)} |`);
  out.push(`| vazão | ${fmtNum(s.rps.achieved)} req/s concluídas |`);
  out.push(
    s.rps.requested !== null
      ? `| iterações/s | ${fmtNum(s.rps.sent)} enviadas (pedidas ${fmtNum(s.rps.requested)}) |`
      : `| iterações/s | ${fmtNum(s.rps.sent)} · VUs (pico) ${s.maxConcurrency} |`,
  );
  out.push(
    `| latência p50 / p95 / p99 | ${fmtNum(l.p50)} / ${fmtNum(l.p95)} / ${fmtNum(l.p99)} ms |`,
  );
  out.push(`| latência p99.9 / máx | ${fmtNum(l.p999)} / ${fmtNum(l.max)} ms |`);
  if (s.grpcStreams) {
    out.push(
      `| gRPC streams | ${s.grpcStreams.streams.toLocaleString("pt-BR")} streams · ${s.grpcStreams.messagesReceived.toLocaleString("pt-BR")} mensagens recebidas · 1ª mensagem p99 ${fmtNum(s.grpcStreams.firstMessageMs.p99)} ms |`,
    );
  }
  if (s.ws) {
    out.push(
      `| WebSocket | ${s.ws.sessions.toLocaleString("pt-BR")} sessões · handshake p99 ${fmtNum(s.ws.connectMs.p99)} ms · RTT p50 / p99 ${fmtNum(s.ws.rttMs.p50)} / ${fmtNum(s.ws.rttMs.p99)} ms |`,
    );
  }
  out.push("");
  if (r.thresholds.length) {
    out.push("**Thresholds**", "", "| | threshold | medido |", "|---|---|--:|");
    for (const t of r.thresholds) {
      const v =
        t.actual === null
          ? "sem dados"
          : t.metric === "errorRate"
            ? pct(t.actual)
            : fmtNum(t.actual);
      out.push(`| ${t.passed ? "✅" : "❌"} | ${mdCode(t.expression)} | ${v} |`);
    }
    out.push("");
  }
  if (extras.comparison) {
    out.push("**Comparação com a baseline**", "", mdComparison(extras.comparison), "");
  }
  if (r.steps.length > 1) {
    out.push(
      "<details><summary>Etapas</summary>",
      "",
      "| etapa | req | erros | p50 | p95 | p99 (ms) |",
      "|---|--:|--:|--:|--:|--:|",
    );
    for (const st of r.steps) {
      out.push(
        `| ${mdEsc((st.flow ? `${st.flow} › ` : "") + st.name)} | ${st.requests} | ${pct(st.errorRate)} | ${fmtNum(st.latencyMs.p50)} | ${fmtNum(st.latencyMs.p95)} | ${fmtNum(st.latencyMs.p99)} |`,
      );
    }
    out.push("", "</details>", "");
  }
  for (const w of r.run.warnings) out.push(`> ⚠️ ${mdEsc(w)}`);
  if (r.run.warnings.length) out.push("");
  out.push(
    `<sub>execução ${mdCode(r.run.id)} · lt ${mdEsc(r.tool.version)}${extras.reportPath ? ` · relatório ${mdCode(extras.reportPath)}` : ""}</sub>`,
  );
  return out.join("\n") + "\n";
}

export function benchMarkdown(b: BenchReport): string {
  const out: string[] = [];
  const regression = b.comparison?.regression ?? false;
  out.push(
    `### ${regression ? "❌" : "📊"} lt bench · ${mdEsc(b.groups.map((g) => g.scenario).join(" × "))}`,
  );
  out.push(
    "",
    `${b.bench.runsPerGroup} rodada(s) por grupo · ordem ${mdCode(b.bench.order.join(" "))} · seed ${b.bench.seed}${b.bench.status !== "completed" ? " · ⚠️ interrompido" : ""}`,
    "",
  );
  for (const g of b.groups) {
    const s = g.summary;
    out.push(
      `**${b.groups.length > 1 ? `${g.label}: ` : ""}${mdEsc(g.scenario)}** (${s.p50.n} rodadas válidas)`,
      "",
    );
    out.push("| métrica | mediana | IC 95% | CV |", "|---|--:|--:|--:|");
    for (const [label, k] of [
      ["p50 (ms)", "p50"],
      ["p95 (ms)", "p95"],
      ["p99 (ms)", "p99"],
      ["vazão (req/s)", "rps"],
    ] as const) {
      const m = s[k];
      if (m.n)
        out.push(
          `| ${label} | ${fmtNum(m.median)} | [${fmtNum(m.ci95.lo)}, ${fmtNum(m.ci95.hi)}] | ${m.cvPct.toFixed(1)}% |`,
        );
    }
    if (s.errorRate.n) out.push(`| taxa de erro | ${pct(s.errorRate.median)} | | |`);
    out.push("");
  }
  if (b.comparison) out.push("**Comparação A × B**", "", mdComparison(b.comparison), "");
  for (const w of b.warnings) out.push(`> ⚠️ ${mdEsc(w)}`);
  out.push("", `<sub>${mdEsc(b.bench.id)} · lt ${mdEsc(b.tool.version)}</sub>`);
  return out.join("\n") + "\n";
}

// ------------------------------------------------------------------ JUnit XML

const xml = (s: unknown) =>
  String(s).replace(
    /[<>&"']/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!,
  );

interface Case {
  classname: string;
  name: string;
  failure?: { message: string; type: string; text?: string };
  skipped?: string;
}

/**
 * JUnit XML: um caso por threshold, um para a validade da execução (gerador não saturado), um
 * para a conclusão (não interrompida) e um por métrica comparada com a baseline. Checagens
 * individuais vão em system-out (a decisão de falhar o CI é dos thresholds).
 */
export function runJUnit(r: RunReport, extras: { comparison?: ComparisonResult } = {}): string {
  const cls = `lt.${r.run.scenario.replace(/[^A-Za-z0-9_-]+/g, "_")}`;
  const cases: Case[] = [];
  cases.push({
    classname: `${cls}.execucao`,
    name: "execução válida (gerador sustentou a carga)",
    ...(r.run.invalid
      ? { failure: { message: r.run.invalidReasons.join("; "), type: "invalid" } }
      : {}),
  });
  cases.push({
    classname: `${cls}.execucao`,
    name: "execução concluída",
    ...(r.run.status !== "completed"
      ? { failure: { message: `status: ${r.run.status}`, type: "interrupted" } }
      : {}),
  });
  for (const t of r.thresholds) {
    const v =
      t.actual === null
        ? "sem dados"
        : t.metric === "errorRate"
          ? pct(t.actual)
          : `${fmtNum(t.actual)}${t.metric === "rps" ? " req/s" : " ms"}`;
    cases.push({
      classname: `${cls}.thresholds`,
      name: t.expression,
      ...(t.passed ? {} : { failure: { message: `medido: ${v}`, type: "threshold" } }),
    });
  }
  if (extras.comparison) {
    for (const m of extras.comparison.metrics) {
      cases.push({
        classname: `${cls}.baseline`,
        name: `sem regressão: ${m.label}`,
        ...(m.verdict === "pior"
          ? {
              failure: {
                message: `${m.label}: ${m.deltaPct === null ? "" : `${m.deltaPct > 0 ? "+" : ""}${m.deltaPct.toFixed(1)}% `}(p ajustado ${Number.isFinite(m.pAdj) ? m.pAdj.toFixed(3) : "—"})`,
                type: "regression",
              },
            }
          : {}),
      });
    }
  }
  const failures = cases.filter((c) => c.failure).length;
  const secs = (r.run.durationMs / 1000).toFixed(3);
  const checks = r.steps
    .flatMap((st) =>
      st.checks.map((c) => `${st.name}: ${c.name} — ${c.passed} ok, ${c.failed} reprovadas`),
    )
    .join("\n");
  const props = [
    ["runId", r.run.id],
    ["baseUrl", r.config.target.baseUrl],
    ["model", r.run.model],
    ["seed", r.run.seed],
    ["requests", r.summary.requests.total],
    ["errorRate", r.summary.errorRate],
    ["p95Ms", r.summary.latencyMs.p95],
    ["p99Ms", r.summary.latencyMs.p99],
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="lt" tests="${cases.length}" failures="${failures}" time="${secs}">
  <testsuite name="lt: ${xml(r.run.scenario)}" tests="${cases.length}" failures="${failures}" errors="0" skipped="0" time="${secs}" timestamp="${xml(r.run.startedAt.replace(/Z$/, ""))}">
    <properties>
${props.map(([k, v]) => `      <property name="${xml(k)}" value="${xml(v)}"/>`).join("\n")}
    </properties>
${cases
  .map(
    (c) =>
      `    <testcase classname="${xml(c.classname)}" name="${xml(c.name)}" time="0">${
        c.failure
          ? `\n      <failure message="${xml(c.failure.message)}" type="${xml(c.failure.type)}"/>\n    `
          : ""
      }</testcase>`,
  )
  .join("\n")}
    <system-out>${xml(checks)}</system-out>
  </testsuite>
</testsuites>
`;
}

// ------------------------------------------------------------------ Prometheus

const label = (v: unknown) =>
  String(v).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');

/** Formato de exposição de texto do Prometheus (para o textfile collector do node_exporter). */
export function runPrometheus(r: RunReport): string {
  const base = `scenario="${label(r.run.scenario)}",run="${label(r.run.id)}"`;
  const s = r.summary;
  const l = s.latencyMs;
  const lines: string[] = [];
  const metric = (name: string, type: string, help: string, rows: [string, number][]) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [labels, v] of rows)
      lines.push(`${name}{${base}${labels ? `,${labels}` : ""}} ${Number.isFinite(v) ? v : "NaN"}`);
  };
  metric("lt_requests_total", "counter", "Requisicoes concluidas na janela medida", [
    ["", s.requests.total],
  ]);
  metric(
    "lt_errors_total",
    "counter",
    "Requisicoes com falha por tipo",
    Object.entries(s.errorsByType).map(([k, v]) => [`type="${label(k)}"`, v ?? 0]),
  );
  lines.push(
    "# HELP lt_latency_ms Latencia desde o instante previsto (ms)",
    "# TYPE lt_latency_ms summary",
    ...(
      [
        ["0.5", l.p50],
        ["0.9", l.p90],
        ["0.95", l.p95],
        ["0.99", l.p99],
        ["0.999", l.p999],
      ] as const
    ).map(([q, v]) => `lt_latency_ms{${base},quantile="${q}"} ${v}`),
    `lt_latency_ms_sum{${base}} ${+(l.mean * l.count).toFixed(3)}`,
    `lt_latency_ms_count{${base}} ${l.count}`,
  );
  metric("lt_latency_max_ms", "gauge", "Maior latencia observada (ms)", [["", l.max]]);
  metric("lt_rps_achieved", "gauge", "Requisicoes concluidas por segundo", [["", s.rps.achieved]]);
  if (s.rps.requested !== null)
    metric("lt_rps_requested", "gauge", "Taxa de chegada pedida (iteracoes/s)", [
      ["", s.rps.requested],
    ]);
  metric("lt_error_ratio", "gauge", "Fracao de requisicoes com falha", [["", s.errorRate]]);
  metric("lt_run_duration_seconds", "gauge", "Duracao da execucao", [
    ["", r.run.durationMs / 1000],
  ]);
  metric("lt_run_invalid", "gauge", "1 se o gerador nao sustentou a carga", [
    ["", r.run.invalid ? 1 : 0],
  ]);
  metric(
    "lt_threshold_passed",
    "gauge",
    "1 se o threshold passou",
    r.thresholds.map((t) => [`threshold="${label(t.expression)}"`, t.passed ? 1 : 0]),
  );
  return lines.join("\n") + "\n";
}
