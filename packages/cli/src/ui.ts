import readline from "node:readline/promises";
import {
  formatDuration,
  type BenchGroup,
  type BenchReport,
  type ComparisonResult,
  type MetricComparison,
  type ProgressSnapshot,
  type RunReport,
  type Verdict,
} from "@lt/core";

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: number) => (s: string | number) =>
  color ? `\x1b[${code}m${s}\x1b[0m` : String(s);
export const c = {
  red: wrap(31),
  green: wrap(32),
  yellow: wrap(33),
  cyan: wrap(36),
  dim: wrap(2),
  bold: wrap(1),
};

const fx = (n: number, d = 1) => n.toFixed(d);

export function progressLine(p: ProgressSnapshot, stages: number): string {
  const phase = p.warmup ? c.yellow("aquecimento") : `etapa ${p.stage + 1}/${stages}`;
  return (
    `[${formatDuration(p.elapsedMs)}/${formatDuration(p.totalMs)}] ${phase} ` +
    (p.model === "open"
      ? `alvo ${fx(p.targetRps, 0)} rps | enviado ${p.sentRps} | `
      : `VUs ${p.concurrency}/${p.targetVus} | iniciadas ${p.sentRps} | `) +
    `concluído ${p.rps} | ` +
    `erros ${p.errors ? c.red(p.errors) : 0} | p50 ${fx(p.latencyMs.p50)} p95 ${fx(p.latencyMs.p95)} p99 ${fx(p.latencyMs.p99)} ms | ` +
    (p.model === "open" ? `em andamento ${p.concurrency}` : "") +
    (p.cpu !== undefined ? ` | CPU ${fx(p.cpu, 0)}%` : "")
  );
}

export function printSummary(r: RunReport, reportPath: string): void {
  const s = r.summary;
  const l = s.latencyMs;
  const statusText =
    r.run.status === "completed"
      ? c.green("concluído")
      : c.yellow(r.run.status === "interrupted" ? "INTERROMPIDO" : r.run.status);
  const out: string[] = [];
  out.push("");
  out.push(
    `${c.bold(r.run.scenario)}  ${statusText} em ${formatDuration(r.run.durationMs)}  ${c.dim(`(modelo ${r.run.model === "open" ? "aberto" : "fechado"}, ${r.generator.workers} worker(s), seed ${r.run.seed})`)}`,
  );
  out.push(
    `  Requisições  ${s.requests.total}  ok ${s.requests.ok}  falhas ${s.requests.failed ? c.red(s.requests.failed) : 0} ` +
      `(${fx(s.errorRate * 100, 2)}%)`,
  );
  if (s.rps.requested !== null) {
    const dev = s.rps.requested ? ((s.rps.sent - s.rps.requested) / s.rps.requested) * 100 : 0;
    out.push(
      `  Taxa         pedida ${fx(s.rps.requested, 2)}/s  enviada ${fx(s.rps.sent, 2)}/s (${dev >= 0 ? "+" : ""}${fx(dev, 2)}%)  ` +
        `concluída ${fx(s.rps.achieved, 2)} req/s  pico simultâneo ${s.maxConcurrency}`,
    );
  } else {
    out.push(
      `  Vazão        ${fx(s.rps.achieved, 2)} req/s  iterações ${fx(s.rps.sent, 2)}/s  VUs (pico) ${s.maxConcurrency}`,
    );
  }
  out.push(
    `  Latência ms  p50 ${fx(l.p50, 2)}  p90 ${fx(l.p90, 2)}  p95 ${fx(l.p95, 2)}  p99 ${fx(l.p99, 2)}  p99.9 ${fx(l.p999, 2)}  ` +
      `máx ${fx(l.max, 2)}  média ${fx(l.mean, 2)} ± ${fx(l.stdev, 2)}`,
  );
  out.push(
    `  Serviço ms   p50 ${fx(s.serviceTimeMs.p50, 2)}  p99 ${fx(s.serviceTimeMs.p99, 2)}  ${c.dim("(do envio real até a resposta)")}`,
  );
  if (s.ttfbMs.count) {
    out.push(
      `  Fases ms     TTFB p50 ${fx(s.ttfbMs.p50, 2)} p99 ${fx(s.ttfbMs.p99, 2)}  download p50 ${fx(s.downloadMs.p50, 2)} p99 ${fx(s.downloadMs.p99, 2)}`,
    );
  }
  if (s.ws) {
    out.push(
      `  WebSocket    ${s.ws.sessions} sessão(ões)  mensagens enviadas ${s.ws.messagesSent} recebidas ${s.ws.messagesReceived}  ` +
        `handshake p50 ${fx(s.ws.connectMs.p50, 2)} p99 ${fx(s.ws.connectMs.p99, 2)}  RTT p50 ${fx(s.ws.rttMs.p50, 2)} p99 ${fx(s.ws.rttMs.p99, 2)} ms`,
    );
  }
  const cn = s.connections;
  if (cn.opened) {
    const protos = Object.entries(cn.byProtocol)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    out.push(
      `  Conexões     ${cn.opened} nova(s) (${protos})  DNS p50 ${fx(cn.dnsMs.p50, 2)}  TCP p50 ${fx(cn.connectMs.p50, 2)}` +
        (cn.tlsMs.max ? `  TLS p50 ${fx(cn.tlsMs.p50, 2)}` : "") +
        ` ms`,
    );
  }
  const errs = Object.entries(s.errorsByType);
  if (errs.length) out.push(`  Erros        ${errs.map(([k, v]) => `${k}: ${v}`).join("  ")}`);
  const codes = Object.entries(s.statusCodes);
  if (codes.length) out.push(`  Status       ${codes.map(([k, v]) => `${k}: ${v}`).join("  ")}`);
  if (r.steps.length > 1) {
    out.push("  Etapas");
    for (const st of r.steps) {
      const label = st.flow ? `${st.flow} › ${st.name}` : st.name;
      out.push(
        `    ${label.padEnd(32)} ${String(st.requests).padStart(7)} req  p50 ${fx(st.latencyMs.p50, 2)}  p95 ${fx(st.latencyMs.p95, 2)}  ` +
          `p99 ${fx(st.latencyMs.p99, 2)} ms  erros ${fx(st.errorRate * 100, 2)}%`,
      );
    }
  }
  if (s.checks.passed + s.checks.failed) {
    out.push(
      `  Checagens    ${s.checks.passed} ok  ${s.checks.failed ? c.red(`${s.checks.failed} reprovadas`) : "0 reprovadas"}`,
    );
    for (const st of r.steps) {
      for (const ch of st.checks.filter((x) => x.failed)) {
        const total = ch.passed + ch.failed;
        out.push(
          c.red(
            `    ✗ ${st.flow ? `${st.flow} › ` : ""}${st.name}: ${ch.name}  ${ch.failed}/${total} (${fx((ch.failed / total) * 100, 1)}%)`,
          ),
        );
      }
    }
  }
  const failures = r.steps.flatMap((st) => st.failures.map((f) => ({ ...f, step: st.name })));
  if (failures.length) {
    out.push("  Falhas mais comuns");
    for (const f of failures.sort((a, b) => b.count - a.count).slice(0, 5)) {
      out.push(c.dim(`    ${String(f.count).padStart(6)}×  ${f.step}: ${f.message}`));
    }
  }
  const g = r.generator;
  out.push(
    c.dim(
      `  Gerador      ${g.workers} worker(s)` +
        (r.run.model === "open"
          ? `  agendamento p99 ${fx(g.scheduleLagMs.p99, 3)} máx ${fx(g.scheduleLagMs.max, 2)} ms`
          : "") +
        `  event loop p99 ${fx(g.loopLagMs.p99, 2)} ms  CPU ${g.cpuPercent}% de 1 núcleo`,
    ),
  );
  if (r.machine) {
    out.push(
      c.dim(
        `  Máquina      CPU média ${r.machine.cpuAvg}% (máx ${r.machine.cpuMax}%)  memória máx ${r.machine.memMaxPct}%  processo ${r.machine.rssMaxMb} MB`,
      ),
    );
  }
  if (r.run.breakingPoint) {
    const bp = r.run.breakingPoint;
    out.push(
      c.yellow(
        `  Ruptura      ${bp.condition} no segundo ${bp.t} — carga pedida ${bp.targetRps !== undefined ? `${bp.targetRps} rps` : `${bp.vus} VUs`}, vazão obtida ${bp.achievedRps} req/s`,
      ),
    );
  }
  if (r.thresholds.length) {
    out.push("  Thresholds");
    for (const t of r.thresholds) {
      const actual =
        t.actual === null
          ? "sem dados"
          : t.metric === "errorRate"
            ? `${fx(t.actual * 100, 2)}%`
            : fx(t.actual, 2);
      out.push(
        `    ${t.passed ? c.green("✓") : c.red("✗")} ${t.expression}  ${c.dim(`(medido: ${actual})`)}`,
      );
    }
  }
  for (const w of r.run.warnings) out.push(c.yellow(`  ! ${w}`));
  for (const w of r.run.invalidReasons) out.push(c.red(`  ✗ ${w}`));
  out.push(`  Relatório    ${reportPath}`);
  console.log(out.join("\n"));
}

export async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

const VERDICT: Record<Verdict, (s: string) => string> = {
  pior: (s) => c.red(c.bold(s.toUpperCase())),
  melhor: (s) => c.green(c.bold(s.toUpperCase())),
  pequena: () => c.yellow("diferença pequena"),
  "sem diferença": (s) => c.dim(s),
  "amostra insuficiente": (s) => c.yellow(s),
};

function fmtVal(v: number, unit: MetricComparison["unit"]): string {
  if (!Number.isFinite(v)) return "—";
  if (unit === "%") return `${(v * 100).toFixed(2)}%`;
  return v.toFixed(2);
}

function fmtDelta(v: number, unit: MetricComparison["unit"]): string {
  if (!Number.isFinite(v)) return "—";
  const sign = v > 0 ? "+" : "";
  return unit === "%" ? `${sign}${(v * 100).toFixed(2)} pp` : `${sign}${v.toFixed(2)}`;
}

export function printComparison(r: ComparisonResult): void {
  const out: string[] = [];
  out.push(
    `  A: ${r.a.id} (${r.a.scenario}, n=${r.a.n})   B: ${r.b.id} (${r.b.scenario}, n=${r.b.n})`,
  );
  out.push(c.dim(`  Método: ${r.method}`));
  out.push(
    `  ${"métrica".padEnd(15)}${"A".padStart(11)}${"B".padStart(11)}${"Δ".padStart(12)}${"Δ%".padStart(9)}  ${"IC95% (B−A)".padEnd(22)}${"p (Holm)".padStart(9)}  veredito`,
  );
  for (const m of r.metrics) {
    const ci = Number.isFinite(m.ci.lo)
      ? `[${fmtDelta(m.ci.lo, m.unit)}, ${fmtDelta(m.ci.hi, m.unit)}]`
      : "—";
    const p = Number.isFinite(m.pAdj) ? (m.pAdj < 0.001 ? "<0.001" : m.pAdj.toFixed(3)) : "—";
    out.push(
      `  ${(m.label + (m.unit === "ms" ? " ms" : m.unit === "req/s" ? " req/s" : "")).padEnd(15)}` +
        `${fmtVal(m.a, m.unit).padStart(11)}${fmtVal(m.b, m.unit).padStart(11)}` +
        `${fmtDelta(m.delta, m.unit).padStart(12)}` +
        `${(m.deltaPct === null ? "—" : `${m.deltaPct > 0 ? "+" : ""}${m.deltaPct.toFixed(1)}%`).padStart(9)}  ` +
        `${ci.padEnd(22)}${p.padStart(9)}  ${VERDICT[m.verdict](m.verdict)}`,
    );
  }
  const concl = r.regression
    ? c.red(c.bold(r.conclusion))
    : r.improvement
      ? c.green(r.conclusion)
      : r.conclusion;
  out.push(`  Conclusão: ${concl}`);
  for (const w of r.warnings) out.push(c.yellow(`  ! ${w}`));
  console.log(out.join("\n"));
}

export function printBench(r: BenchReport, file: string): void {
  const out: string[] = [""];
  const st = r.bench.status === "completed" ? c.green("concluído") : c.yellow("INTERROMPIDO");
  out.push(
    `${c.bold(r.bench.id)}  ${st}  ${r.bench.mode === "ab" ? "A/B" : "rodadas"}: ${r.bench.order.join(" ")}  ${c.dim(`(seed ${r.bench.seed})`)}`,
  );
  for (const g of r.groups) {
    out.push(c.bold(`  ${r.groups.length > 1 ? `${g.label}: ` : ""}${g.scenario} → ${g.baseUrl}`));
    out.push(
      `    ${"métrica".padEnd(14)}${"mediana".padStart(10)}  ${"IC95% da mediana".padEnd(22)}${"mín".padStart(9)}${"máx".padStart(9)}${"CV".padStart(8)}`,
    );
    const rows: [string, keyof BenchGroup["summary"], boolean][] = [
      ["p50 ms", "p50", false],
      ["p95 ms", "p95", false],
      ["p99 ms", "p99", false],
      ["vazão req/s", "rps", false],
      ["erros", "errorRate", true],
    ];
    for (const [label, k, isPct] of rows) {
      const s = g.summary[k];
      if (!s.n) continue;
      const f = (v: number) => (isPct ? `${(v * 100).toFixed(2)}%` : v.toFixed(2));
      out.push(
        `    ${label.padEnd(14)}${f(s.median).padStart(10)}  ${`[${f(s.ci95.lo)}, ${f(s.ci95.hi)}]`.padEnd(22)}` +
          `${f(s.min).padStart(9)}${f(s.max).padStart(9)}${`${s.cvPct.toFixed(1)}%`.padStart(8)}`,
      );
    }
    out.push(c.dim(`    ${g.summary.p50.n} rodada(s) válida(s) de ${g.runs.length}`));
  }
  console.log(out.join("\n"));
  if (r.comparison) {
    console.log(c.bold("\n  Comparação A × B"));
    printComparison(r.comparison);
  }
  for (const w of r.warnings) console.log(c.yellow(`  ! ${w}`));
  console.log(`  Relatório    ${file}`);
}
