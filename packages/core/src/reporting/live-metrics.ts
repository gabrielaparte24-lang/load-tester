import http from "node:http";
import type { ProgressSnapshot } from "../runner.js";

const label = (v: unknown) =>
  String(v).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');

/**
 * Métricas ao vivo no formato do Prometheus durante uma execução (`lt run --metrics-port`).
 * Escuta apenas em 127.0.0.1. Contadores acumulam desde o início; gauges refletem o último segundo.
 */
export class LiveMetrics {
  private last: ProgressSnapshot | null = null;
  private running = 1;
  private server: http.Server | null = null;

  constructor(private readonly scenario: string) {}

  update(p: ProgressSnapshot): void {
    this.last = p;
  }

  finish(): void {
    this.running = 0;
  }

  render(): string {
    const b = `scenario="${label(this.scenario)}"`;
    const p = this.last;
    const g = (name: string, help: string, v: number, type = "gauge", extra = "") =>
      `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${name}{${b}${extra}} ${Number.isFinite(v) ? v : "NaN"}\n`;
    let out = g("lt_live_running", "1 enquanto a execucao esta em andamento", this.running);
    if (!p) return out;
    out += g("lt_live_elapsed_seconds", "Tempo decorrido", p.elapsedMs / 1000);
    out += g(
      "lt_live_requests_total",
      "Requisicoes concluidas (inclui aquecimento)",
      p.totalRequests,
      "counter",
    );
    out += g(
      "lt_live_errors_total",
      "Requisicoes com falha (inclui aquecimento)",
      p.totalErrors,
      "counter",
    );
    out += g("lt_live_rps", "Requisicoes concluidas no ultimo segundo", p.rps);
    out += g("lt_live_errors_per_second", "Falhas no ultimo segundo", p.errors);
    out += g(
      "lt_live_concurrency",
      "Iteracoes simultaneas (aberto) ou VUs ativos (fechado)",
      p.concurrency,
    );
    if (p.model === "open") out += g("lt_live_target_rps", "Taxa de chegada pedida", p.targetRps);
    else out += g("lt_live_target_vus", "VUs pedidos", p.targetVus);
    out +=
      "# HELP lt_live_latency_ms Latencia no ultimo segundo (ms)\n# TYPE lt_live_latency_ms gauge\n" +
      (["0.5", "0.95", "0.99"] as const)
        .map(
          (q, i) =>
            `lt_live_latency_ms{${b},quantile="${q}"} ${[p.latencyMs.p50, p.latencyMs.p95, p.latencyMs.p99][i]}`,
        )
        .join("\n") +
      "\n";
    if (p.cpu !== undefined) out += g("lt_live_machine_cpu_percent", "CPU total da maquina", p.cpu);
    return out;
  }

  /** Sobe o endpoint em 127.0.0.1:port (GET /metrics). */
  listen(port: number): Promise<void> {
    this.server = http.createServer((req, res) => {
      if (req.method === "GET" && (req.url === "/metrics" || req.url?.startsWith("/metrics?"))) {
        res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
        res.end(this.render());
      } else {
        res.writeHead(404).end();
      }
    });
    return new Promise((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, "127.0.0.1", () => resolve());
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}
