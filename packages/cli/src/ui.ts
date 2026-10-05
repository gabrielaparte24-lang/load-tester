import readline from "node:readline/promises";
import { formatDuration, type ProgressSnapshot, type RunReport } from "@lt/core";

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
  out.push(
    `  Fases ms     TTFB p50 ${fx(s.ttfbMs.p50, 2)} p99 ${fx(s.ttfbMs.p99, 2)}  download p50 ${fx(s.downloadMs.p50, 2)} p99 ${fx(s.downloadMs.p99, 2)}`,
  );
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
