import type { BenchReport } from "../bench.js";
import type { ComparisonResult, MetricComparison } from "../compare.js";
import { formatDuration } from "../duration.js";
import type { LatencyStats } from "../metrics.js";
import type { RunReport } from "../report.js";
import {
  CHART_SCRIPT,
  columnChart,
  downsample,
  esc,
  fmtNum,
  lineChart,
  type Series,
} from "./charts.js";
import { logBuckets, percentileCurve } from "./distribution.js";
import { REPORT_CSS } from "./style.js";

export interface ReportExtras {
  /** Comparação com a baseline (lt run --baseline). */
  comparison?: ComparisonResult;
  baselineSource?: string;
}

const MAX_POINTS = 900;
const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
const ms = (v: number) => `${fmtNum(v)} ms`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="lt">
<title>${esc(title)}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<main>
${body}
</main>
<script>${CHART_SCRIPT}</script>
</body>
</html>
`;
}

function statusIcon(ok: boolean | "warn", text: string): string {
  const cls = ok === "warn" ? "warn" : ok ? "ok" : "fail";
  const icon = ok === "warn" ? "!" : ok ? "✓" : "✗";
  return `<span class="status ${cls}"><span aria-hidden="true">${icon}</span>${esc(text)}</span>`;
}

function tile(label: string, value: string, note = ""): string {
  return `<div class="tile"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div>${note ? `<div class="note">${esc(note)}</div>` : ""}</div>`;
}

function latRow(name: string, l: LatencyStats): string {
  return `<tr><td>${esc(name)}</td>${[l.p50, l.p90, l.p95, l.p99, l.p999, l.max, l.mean]
    .map((v) => `<td class="num">${fmtNum(v)}</td>`)
    .join("")}<td class="num">${l.count}</td></tr>`;
}

export function comparisonTable(c: ComparisonResult): string {
  const v = (m: MetricComparison) =>
    m.verdict === "pior"
      ? statusIcon(false, "pior")
      : m.verdict === "melhor"
        ? statusIcon(true, "melhor")
        : m.verdict === "pequena"
          ? statusIcon("warn", "diferença pequena")
          : `<span class="muted">${esc(m.verdict)}</span>`;
  const f = (x: number, m: MetricComparison) =>
    !Number.isFinite(x) ? "—" : m.unit === "%" ? pct(x) : fmtNum(x);
  const rows = c.metrics
    .map(
      (
        m,
      ) => `<tr><td>${esc(m.label)}${m.unit === "ms" ? " (ms)" : m.unit === "req/s" ? " (req/s)" : ""}</td>
<td class="num">${f(m.a, m)}</td><td class="num">${f(m.b, m)}</td>
<td class="num">${m.deltaPct === null ? "—" : `${m.deltaPct > 0 ? "+" : ""}${m.deltaPct.toFixed(1)}%`}</td>
<td class="num">${Number.isFinite(m.ci.lo) ? `[${f(m.ci.lo, m)}, ${f(m.ci.hi, m)}]` : "—"}</td>
<td class="num">${Number.isFinite(m.pAdj) ? (m.pAdj < 0.001 ? "&lt;0.001" : m.pAdj.toFixed(3)) : "—"}</td>
<td>${v(m)}</td></tr>`,
    )
    .join("");
  return `<div class="scroll"><table><thead><tr><th>métrica</th><th class="num">${esc(c.a.label)}</th><th class="num">${esc(c.b.label)}</th><th class="num">Δ%</th><th class="num">IC 95% (B−A)</th><th class="num">p (Holm)</th><th>veredito</th></tr></thead><tbody>${rows}</tbody></table></div>
<p><strong>${esc(c.conclusion)}</strong></p>
<p class="muted">${esc(c.method)}</p>
${c.warnings.map((w) => `<div class="alert warning"><span class="icon" aria-hidden="true">!</span><span>${esc(w)}</span></div>`).join("")}`;
}

export function renderRunHtml(r: RunReport, extras: ReportExtras = {}): string {
  const s = r.summary;
  const l = s.latencyMs;
  const passed = r.thresholds.every((t) => t.passed);
  const regression = extras.comparison?.regression ?? false;
  const ok = r.run.status === "completed" && !r.run.invalid && passed && !regression;

  // ---- cabeçalho e alertas
  const badges = [
    `<span class="badge">${statusIcon(ok, ok ? "aprovado" : "reprovado")}</span>`,
    `<span class="badge">${r.run.status === "completed" ? "concluído" : r.run.status === "interrupted" ? "interrompido" : esc(r.run.status)}</span>`,
    `<span class="badge">modelo ${r.run.model === "open" ? "aberto" : "fechado"}</span>`,
    `<span class="badge">${r.generator.workers} worker(s)</span>`,
    `<span class="badge">seed ${r.run.seed}</span>`,
  ].join("");
  const alerts = [
    ...r.run.invalidReasons.map((m) => ({ cls: "critical", icon: "✗", m })),
    ...(r.run.stopReason ? [{ cls: "warning", icon: "!", m: r.run.stopReason }] : []),
    ...r.run.warnings.map((m) => ({ cls: "warning", icon: "!", m })),
  ]
    .map(
      (a) =>
        `<div class="alert ${a.cls}"><span class="icon" aria-hidden="true">${a.icon}</span><span>${esc(a.m)}</span></div>`,
    )
    .join("");

  // ---- indicadores
  const tiles = [
    tile(
      "Requisições",
      s.requests.total.toLocaleString("pt-BR"),
      `${s.requests.failed.toLocaleString("pt-BR")} com falha`,
    ),
    tile("Taxa de erro", pct(s.errorRate)),
    tile(
      "Vazão",
      `${fmtNum(s.rps.achieved)} req/s`,
      s.rps.requested !== null
        ? `pedida ${fmtNum(s.rps.requested)} it/s · enviada ${fmtNum(s.rps.sent)}`
        : `${fmtNum(s.rps.sent)} iterações/s`,
    ),
    tile("Latência p50", ms(l.p50)),
    tile("Latência p95", ms(l.p95)),
    tile("Latência p99", ms(l.p99), `máx ${ms(l.max)}`),
    tile(r.run.model === "open" ? "Pico simultâneo" : "VUs (pico)", String(s.maxConcurrency)),
    tile(
      "Duração",
      formatDuration(r.run.durationMs),
      r.config.load.warmupMs ? `aquecimento ${formatDuration(r.config.load.warmupMs)}` : "",
    ),
  ].join("");

  // ---- thresholds e baseline
  const thr = r.thresholds.length
    ? `<table><thead><tr><th>resultado</th><th>threshold</th><th class="num">medido</th></tr></thead><tbody>${r.thresholds
        .map(
          (t) =>
            `<tr><td>${statusIcon(t.passed, t.passed ? "passou" : "falhou")}</td><td><code>${esc(t.expression)}</code></td><td class="num">${
              t.actual === null
                ? "sem dados"
                : t.metric === "errorRate"
                  ? pct(t.actual)
                  : fmtNum(t.actual)
            }</td></tr>`,
        )
        .join("")}</tbody></table>`
    : `<p class="muted">Nenhum threshold definido no cenário.</p>`;
  const baseline = extras.comparison
    ? `<div class="card"><h2>Comparação com a baseline</h2><p class="sub">${esc(extras.baselineSource ?? extras.comparison.a.id)}</p>${comparisonTable(extras.comparison)}</div>`
    : "";

  // ---- gráficos no tempo
  const tl = r.timeline;
  const x = tl.map((p) => p.t);
  const warm = r.config.load.warmupMs / 1000;
  const lat = downsample(
    x,
    [
      { name: "p50", color: "var(--s1)", values: tl.map((p) => (p.rps ? p.latencyMs.p50 : null)) },
      { name: "p95", color: "var(--s2)", values: tl.map((p) => (p.rps ? p.latencyMs.p95 : null)) },
      { name: "p99", color: "var(--s3)", values: tl.map((p) => (p.rps ? p.latencyMs.p99 : null)) },
    ],
    MAX_POINTS,
    ["max", "max", "max"],
  );
  // aberto: pedida × enviada na MESMA unidade (iterações/s); fechado: requisições concluídas/s
  const thrSeries: Series[] =
    r.run.model === "open"
      ? [
          { name: "pedida", color: "var(--s1)", values: tl.map((p) => p.targetRps) },
          { name: "enviada", color: "var(--s2)", values: tl.map((p) => p.sentRps) },
        ]
      : [{ name: "concluídas", color: "var(--s1)", values: tl.map((p) => p.rps) }];
  // segundos depois do fim do cronograma são só drenagem: fora do gráfico de vazão
  const schedEnd = Math.ceil(r.config.load.stages.reduce((a, st) => a + st.durationMs, 0) / 1000);
  const keep = tl.map((p) => r.run.model !== "open" || p.t < schedEnd);
  const thru = downsample(
    x.filter((_, i) => keep[i]),
    thrSeries.map((s) => ({ ...s, values: s.values.filter((_, i) => keep[i]) })),
    MAX_POINTS,
    thrSeries.map(() => "mean"),
  );
  const conc = downsample(
    x,
    [
      {
        name: r.run.model === "open" ? "em andamento" : "VUs",
        color: "var(--s1)",
        values: tl.map((p) => p.concurrency),
      },
    ],
    MAX_POINTS,
    ["max"],
  );
  const hasCpu = tl.some((p) => p.cpu !== undefined);
  const cpu = downsample(
    x,
    [{ name: "CPU da máquina", color: "var(--s1)", values: tl.map((p) => p.cpu ?? null) }],
    MAX_POINTS,
    ["mean"],
  );
  const anyErrors = tl.some((p) => p.errors > 0);
  const errorsChart = !anyErrors
    ? `<p>${statusIcon(true, "nenhum erro em nenhum segundo")}</p>`
    : tl.length <= 120
      ? columnChart({
          id: "errors",
          size: "half",
          label: "Erros por segundo",
          unit: "erros/s",
          labels: tl.map((p) => `t = ${p.t}s`),
          values: tl.map((p) => p.errors),
          color: "var(--s8)",
          tipExtra: tl.map((p) => (p.rps ? `${pct(p.errors / p.rps)} das requisições` : "")),
        })
      : lineChart({
          id: "errors",
          size: "half",
          label: "Erros por segundo",
          unit: "erros/s",
          ...downsample(
            x,
            [{ name: "erros", color: "var(--s8)", values: tl.map((p) => p.errors) }],
            MAX_POINTS,
            ["max"],
          ),
          area: true,
        });

  // ---- distribuição
  const curve = percentileCurve(r.histograms.latencyUs);
  const buckets = logBuckets(r.histograms.latencyUs, 30);
  const total = buckets.reduce((a, b) => a + b.count, 0) || 1;

  // ---- etapas
  const steps = r.steps
    .map(
      (
        st,
      ) => `<tr><td>${st.flow ? `${esc(st.flow)} › ` : ""}${esc(st.name)}<div class="muted"><code>${esc(st.method)} ${esc(st.path)}</code></div></td>
<td class="num">${st.requests.toLocaleString("pt-BR")}</td><td class="num">${pct(st.errorRate)}</td>
${[st.latencyMs.p50, st.latencyMs.p95, st.latencyMs.p99, st.latencyMs.max].map((v) => `<td class="num">${fmtNum(v)}</td>`).join("")}
<td class="num">${
        Object.entries(st.statusCodes)
          .map(([k, v]) => `${esc(k)}: ${v}`)
          .join("<br>") || "—"
      }</td></tr>`,
    )
    .join("");
  const failedChecks = r.steps.flatMap((st) =>
    st.checks.filter((c) => c.failed).map((c) => ({ step: st.name, ...c })),
  );
  const failures = r.steps
    .flatMap((st) => st.failures.map((f) => ({ step: st.name, ...f })))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const cn = s.connections;
  const errorsByType = Object.entries(s.errorsByType);

  const body = `
<header class="top">
  <div>
    <h1>${esc(r.run.scenario)}</h1>
    <p class="sub">${esc(r.config.target.baseUrl)} · ${esc(new Date(r.run.startedAt).toLocaleString("pt-BR"))} · execução <code>${esc(r.run.id)}</code></p>
    <div class="badges">${badges}</div>
  </div>
  <button id="theme" type="button" aria-label="Alternar tema claro/escuro">Tema</button>
</header>
${alerts}
<section class="tiles" style="margin-top:16px">${tiles}</section>

<div class="grid2" style="margin-top:16px">
  <div class="card"><h2>Thresholds</h2>${thr}</div>
  <div class="card"><h2>Erros</h2>${
    errorsByType.length
      ? `<table><thead><tr><th>tipo</th><th class="num">quantidade</th></tr></thead><tbody>${errorsByType
          .map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${v}</td></tr>`)
          .join("")}</tbody></table>`
      : `<p>${statusIcon(true, "nenhuma falha")}</p>`
  }
  ${s.checks.passed + s.checks.failed ? `<p class="muted">Checagens: ${s.checks.passed.toLocaleString("pt-BR")} aprovadas, ${s.checks.failed.toLocaleString("pt-BR")} reprovadas.</p>` : ""}
  </div>
</div>
${baseline}

<div class="card">
  <h2>Latência ao longo do tempo</h2>
  <p class="sub">Medida a partir do instante previsto de envio (corrige omissão coordenada); por segundo de conclusão.</p>
  ${lineChart({ id: "latency", label: "Latência p50, p95 e p99 por segundo", unit: "ms", x: lat.x, series: lat.series, warmupUntil: warm })}
</div>
<div class="grid2" style="margin-top:16px">
  <div class="card"><h2>Vazão</h2><p class="sub">${r.run.model === "open" ? "Iterações por segundo: taxa pedida pelo cronograma × efetivamente enviadas" : "Requisições concluídas por segundo"}</p>
    ${lineChart({ id: "throughput", size: "half", label: "Vazão por segundo", unit: r.run.model === "open" ? "it/s" : "req/s", x: thru.x, series: thru.series, warmupUntil: warm, area: thru.series.length === 1 })}</div>
  <div class="card"><h2>Erros por segundo</h2><p class="sub">Requisições com falha (transporte, status ou checagem)</p>${errorsChart}</div>
  <div class="card"><h2>${r.run.model === "open" ? "Iterações em andamento" : "Usuários virtuais ativos"}</h2><p class="sub">Máximo por segundo</p>
    ${lineChart({ id: "concurrency", size: "half", label: "Concorrência por segundo", unit: r.run.model === "open" ? "iterações" : "VUs", x: conc.x, series: conc.series, warmupUntil: warm, area: true })}</div>
  ${
    hasCpu
      ? `<div class="card"><h2>CPU da máquina</h2><p class="sub">Uso total de CPU da máquina geradora (gerador e, se local, o alvo)</p>
    ${lineChart({ id: "cpu", size: "half", label: "CPU da máquina por segundo", unit: "%", x: cpu.x, series: cpu.series, yMax: 100, area: true })}</div>`
      : ""
  }
</div>

<div class="grid2" style="margin-top:16px">
  <div class="card"><h2>Distribuição: latência por percentil</h2><p class="sub">Escala de "noves": cada marca é 10× mais rara que a anterior</p>
    ${curve.x.length ? lineChart({ id: "percentiles", size: "half", label: "Latência por percentil", unit: "ms", x: curve.x, series: [{ name: "latência", color: "var(--s1)", values: curve.ms }], xKind: "nines", area: true }) : `<p class="muted">Sem dados.</p>`}</div>
  <div class="card"><h2>Distribuição: histograma</h2><p class="sub">Quantidade de requisições por faixa de latência (faixas logarítmicas)</p>
    ${
      buckets.length
        ? columnChart({
            id: "histogram",
            size: "half",
            label: "Histograma de latência",
            unit: "req",
            labels: buckets.map((b) => `${fmtNum(b.from)}–${fmtNum(b.to)} ms`),
            values: buckets.map((b) => b.count),
            color: "var(--s1)",
            labelEvery: 6,
            tipExtra: buckets.map(
              (b) => `${((b.count / total) * 100).toFixed(1)}% das requisições`,
            ),
          })
        : `<p class="muted">Sem dados.</p>`
    }</div>
</div>

<div class="card">
  <h2>Etapas</h2>
  <div class="scroll"><table><thead><tr><th>etapa</th><th class="num">req</th><th class="num">erros</th><th class="num">p50 ms</th><th class="num">p95 ms</th><th class="num">p99 ms</th><th class="num">máx ms</th><th class="num">status</th></tr></thead><tbody>${steps}</tbody></table></div>
  ${
    failedChecks.length
      ? `<h3>Checagens reprovadas</h3><table><thead><tr><th>etapa</th><th>checagem</th><th class="num">reprovadas</th></tr></thead><tbody>${failedChecks
          .map(
            (c) =>
              `<tr><td>${esc(c.step)}</td><td><code>${esc(c.name)}</code></td><td class="num">${c.failed}/${c.passed + c.failed}</td></tr>`,
          )
          .join("")}</tbody></table>`
      : ""
  }
  ${
    failures.length
      ? `<h3>Falhas mais comuns</h3><table><thead><tr><th class="num">vezes</th><th>etapa</th><th>mensagem</th></tr></thead><tbody>${failures
          .map(
            (f) =>
              `<tr><td class="num">${f.count}</td><td>${esc(f.step)}</td><td>${esc(f.message)}</td></tr>`,
          )
          .join("")}</tbody></table>`
      : ""
  }
</div>

<div class="grid2" style="margin-top:16px">
  <div class="card"><h2>Fases da requisição (ms)</h2>
    <div class="scroll"><table><thead><tr><th>fase</th><th class="num">p50</th><th class="num">p90</th><th class="num">p95</th><th class="num">p99</th><th class="num">p99.9</th><th class="num">máx</th><th class="num">média</th><th class="num">n</th></tr></thead><tbody>
    ${latRow("latência (desde o previsto)", l)}${latRow("tempo de serviço", s.serviceTimeMs)}${latRow("TTFB", s.ttfbMs)}${latRow("download", s.downloadMs)}
    ${cn.opened ? `${latRow("DNS (por conexão)", cn.dnsMs)}${latRow("TCP (por conexão)", cn.connectMs)}${cn.tlsMs.max ? latRow("TLS (por conexão)", cn.tlsMs) : ""}` : ""}
    </tbody></table></div>
    <p class="muted">${cn.opened} conexão(ões) nova(s): ${
      Object.entries(cn.byProtocol)
        .map(([k, v]) => `${esc(k)} ${v}`)
        .join(", ") || "—"
    }. Bytes recebidos ${s.bytes.received.toLocaleString("pt-BR")}, enviados ${s.bytes.sent.toLocaleString("pt-BR")}.</p>
  </div>
  <div class="card"><h2>Gerador e máquina</h2>
    <table><tbody>
      <tr><td>workers</td><td class="num">${r.generator.workers}</td></tr>
      ${r.run.model === "open" ? `<tr><td>atraso de agendamento p99 / máx</td><td class="num">${fmtNum(r.generator.scheduleLagMs.p99)} / ${fmtNum(r.generator.scheduleLagMs.max)} ms</td></tr>` : ""}
      <tr><td>atraso do event loop p99 / máx</td><td class="num">${fmtNum(r.generator.loopLagMs.p99)} / ${fmtNum(r.generator.loopLagMs.max)} ms</td></tr>
      <tr><td>CPU dos motores (de 1 núcleo)</td><td class="num">${r.generator.cpuPercent}%</td></tr>
      ${r.generator.throttled ? `<tr><td>esperas pelo teto de RPS</td><td class="num">${r.generator.throttled}</td></tr>` : ""}
      ${r.machine ? `<tr><td>CPU da máquina (média / máx)</td><td class="num">${r.machine.cpuAvg}% / ${r.machine.cpuMax}%</td></tr><tr><td>memória da máquina (máx)</td><td class="num">${r.machine.memMaxPct}%</td></tr><tr><td>memória do processo (máx)</td><td class="num">${r.machine.rssMaxMb} MB</td></tr>` : ""}
      <tr><td>ambiente</td><td class="num">Node ${esc(r.environment.node)} · ${esc(r.environment.platform)}/${esc(r.environment.arch)} · ${r.environment.cpus} CPUs</td></tr>
    </tbody></table>
  </div>
</div>

<div class="card">
  <details><summary>Configuração da execução (segredos mascarados)</summary>
  <pre>${esc(JSON.stringify(r.config, null, 2))}</pre></details>
</div>
<div class="card">
  <details><summary>Dados por segundo (tabela)</summary>
  <div class="scroll"><table><thead><tr><th class="num">t (s)</th><th class="num">pedida</th><th class="num">enviadas</th><th class="num">concluídas</th><th class="num">erros</th><th class="num">simult.</th><th class="num">p50</th><th class="num">p95</th><th class="num">p99</th><th class="num">máx</th><th class="num">CPU %</th></tr></thead><tbody>
  ${tl
    .map(
      (p) =>
        `<tr${p.warmup ? ' class="muted"' : ""}><td class="num">${p.t}</td><td class="num">${fmtNum(p.targetRps)}</td><td class="num">${p.sentRps}</td><td class="num">${p.rps}</td><td class="num">${p.errors}</td><td class="num">${p.concurrency}</td><td class="num">${fmtNum(p.latencyMs.p50)}</td><td class="num">${fmtNum(p.latencyMs.p95)}</td><td class="num">${fmtNum(p.latencyMs.p99)}</td><td class="num">${fmtNum(p.latencyMs.max)}</td><td class="num">${p.cpu ?? "—"}</td></tr>`,
    )
    .join("")}
  </tbody></table></div></details>
</div>
<footer>Gerado por lt ${esc(r.tool.version)} · relatório schemaVersion ${r.schemaVersion} · ${esc(r.run.endedAt)}. Use apenas contra sistemas próprios ou com autorização.</footer>`;
  return page(`${r.run.scenario} — relatório lt`, body);
}

export function renderBenchHtml(b: BenchReport): string {
  const groups = b.groups
    .map((g) => {
      const rows: [string, keyof (typeof g)["summary"], boolean][] = [
        ["latência p50 (ms)", "p50", false],
        ["latência p95 (ms)", "p95", false],
        ["latência p99 (ms)", "p99", false],
        ["vazão (req/s)", "rps", false],
        ["taxa de erro", "errorRate", true],
      ];
      const f = (v: number, isPct: boolean) => (isPct ? pct(v) : fmtNum(v));
      return `<div class="card"><h2>${b.groups.length > 1 ? `${esc(g.label)}: ` : ""}${esc(g.scenario)}</h2><p class="sub">${esc(g.baseUrl)} · ${g.summary.p50.n} rodada(s) válida(s) de ${g.runs.length}</p>
<div class="scroll"><table><thead><tr><th>métrica</th><th class="num">mediana</th><th class="num">IC 95% da mediana</th><th class="num">mín</th><th class="num">máx</th><th class="num">CV</th></tr></thead><tbody>${rows
        .filter(([, k]) => g.summary[k].n)
        .map(([label, k, isPct]) => {
          const s = g.summary[k];
          return `<tr><td>${label}</td><td class="num">${f(s.median, isPct)}</td><td class="num">[${f(s.ci95.lo, isPct)}, ${f(s.ci95.hi, isPct)}]</td><td class="num">${f(s.min, isPct)}</td><td class="num">${f(s.max, isPct)}</td><td class="num">${s.cvPct.toFixed(1)}%</td></tr>`;
        })
        .join("")}</tbody></table></div>
<h3>Rodadas</h3><div class="scroll"><table><thead><tr><th>rodada</th><th class="num">p50</th><th class="num">p95</th><th class="num">p99</th><th class="num">req/s</th><th class="num">erros</th><th>estado</th><th>relatório</th></tr></thead><tbody>${g.runs
        .map(
          (r) =>
            `<tr><td>${esc(r.id)}</td><td class="num">${fmtNum(r.p50)}</td><td class="num">${fmtNum(r.p95)}</td><td class="num">${fmtNum(r.p99)}</td><td class="num">${fmtNum(r.rps)}</td><td class="num">${pct(r.errorRate)}</td><td>${
              r.invalid
                ? statusIcon(false, "inválida")
                : r.status !== "completed"
                  ? statusIcon("warn", r.status)
                  : statusIcon(true, "válida")
            }</td><td><a href="${esc(r.report.replace(/report\.json$/, "report.html"))}">abrir</a></td></tr>`,
        )
        .join("")}</tbody></table></div></div>`;
    })
    .join("");

  // p95 por rodada, na ordem real de execução (mostra deriva e o efeito da alternância)
  const all = b.groups.flatMap((g) => g.runs.map((r) => ({ g: g.label, ...r })));
  const ordered = b.bench.order
    .map((id) => all.find((r) => r.id === id))
    .filter((r): r is NonNullable<typeof r> => r !== undefined);
  const order =
    ordered.length > 1
      ? `<div class="card"><h2>p95 por rodada, na ordem de execução</h2><p class="sub">Uma tendência ao longo da ordem indica deriva do ambiente; a alternância A/B a distribui igualmente entre os grupos.</p>
${lineChart({
  id: "rounds",
  label: "p95 por rodada na ordem de execução",
  size: "full",
  unit: "ms",
  x: ordered.map((_, i) => i + 1),
  series: b.groups.map((g, k) => ({
    name: b.groups.length > 1 ? g.label : "p95",
    color: k === 0 ? "var(--s1)" : "var(--s2)",
    values: ordered.map((r) => (r.g === g.label ? r.p95 : null)),
  })),
})}</div>`
      : "";

  const cmp = b.comparison
    ? `<div class="card"><h2>Comparação A × B</h2>${comparisonTable(b.comparison)}</div>`
    : "";
  const warnings = b.warnings
    .map(
      (w) =>
        `<div class="alert warning"><span class="icon" aria-hidden="true">!</span><span>${esc(w)}</span></div>`,
    )
    .join("");
  const body = `
<header class="top"><div><h1>Benchmark ${esc(b.groups.map((g) => g.scenario).join(" × "))}</h1>
<p class="sub">${esc(b.bench.id)} · ${b.bench.runsPerGroup} rodada(s) por grupo · ordem ${esc(b.bench.order.join(" "))} · seed ${b.bench.seed}</p>
<div class="badges"><span class="badge">${b.bench.status === "completed" ? statusIcon(true, "concluído") : statusIcon("warn", "interrompido")}</span>${
    b.comparison
      ? `<span class="badge">${b.comparison.regression ? statusIcon(false, "regressão em B") : statusIcon(true, b.comparison.conclusion)}</span>`
      : ""
  }</div></div>
<button id="theme" type="button" aria-label="Alternar tema claro/escuro">Tema</button></header>
${warnings}${cmp}${order}${groups}
<footer>Gerado por lt ${esc(b.tool.version)} · ${esc(b.bench.endedAt)}</footer>`;
  return page(`Benchmark — relatório lt`, body);
}
