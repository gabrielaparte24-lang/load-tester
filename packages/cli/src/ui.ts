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
    `alvo ${fx(p.targetRps, 0)} rps | enviado ${p.sentRps} | concluído ${p.rps} | ` +
    `erros ${p.errors ? c.red(p.errors) : 0} | p50 ${fx(p.latencyMs.p50)} p95 ${fx(p.latencyMs.p95)} p99 ${fx(p.latencyMs.p99)} ms | ` +
    `em andamento ${p.inFlight}`
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
    `${c.bold(r.run.scenario)}  ${statusText} em ${formatDuration(r.run.durationMs)}  ${c.dim(`(modelo aberto, seed ${r.run.seed})`)}`,
  );
  out.push(
    `  Requisições  ${s.requests.total}  ok ${s.requests.ok}  falhas ${s.requests.failed ? c.red(s.requests.failed) : 0} ` +
      `(${fx(s.errorRate * 100, 2)}%)`,
  );
  const dev = s.rps.requested ? ((s.rps.sent - s.rps.requested) / s.rps.requested) * 100 : 0;
  out.push(
    `  Taxa         pedida ${fx(s.rps.requested, 2)}/s  enviada ${fx(s.rps.sent, 2)}/s (${dev >= 0 ? "+" : ""}${fx(dev, 2)}%)  ` +
      `concluída ${fx(s.rps.achieved, 2)} req/s`,
  );
  out.push(
    `  Latência ms  p50 ${fx(l.p50, 2)}  p90 ${fx(l.p90, 2)}  p95 ${fx(l.p95, 2)}  p99 ${fx(l.p99, 2)}  p99.9 ${fx(l.p999, 2)}  ` +
      `máx ${fx(l.max, 2)}  média ${fx(l.mean, 2)} ± ${fx(l.stdev, 2)}`,
  );
  out.push(
    `  Serviço ms   p50 ${fx(s.serviceTimeMs.p50, 2)}  p99 ${fx(s.serviceTimeMs.p99, 2)}  ${c.dim("(do envio real até a resposta)")}`,
  );
  const errs = Object.entries(s.errorsByType);
  if (errs.length) out.push(`  Erros        ${errs.map(([k, v]) => `${k}: ${v}`).join("  ")}`);
  const codes = Object.entries(s.statusCodes);
  if (codes.length) out.push(`  Status       ${codes.map(([k, v]) => `${k}: ${v}`).join("  ")}`);
  if (r.steps.length > 1) {
    out.push("  Etapas");
    for (const st of r.steps) {
      out.push(
        `    ${st.name.padEnd(28)} ${String(st.requests).padStart(7)} req  p50 ${fx(st.latencyMs.p50, 2)}  p95 ${fx(st.latencyMs.p95, 2)}  ` +
          `p99 ${fx(st.latencyMs.p99, 2)} ms  erros ${fx(st.errorRate * 100, 2)}%`,
      );
    }
  }
  const lag = r.generator.scheduleLagMs;
  out.push(
    c.dim(
      `  Gerador      atraso de agendamento p50 ${fx(lag.p50, 3)} p99 ${fx(lag.p99, 3)} máx ${fx(lag.max, 2)} ms  CPU ${r.generator.cpuPercent}%`,
    ),
  );
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
