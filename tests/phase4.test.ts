import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_FORMATS,
  LiveMetrics,
  benchMarkdown,
  logBuckets,
  parseFormats,
  parseScenario,
  percentileCurve,
  renderBenchHtml,
  renderRunHtml,
  runJUnit,
  runMarkdown,
  runPrometheus,
  runScenario,
  stepsCsv,
  timelineCsv,
  writeRunReports,
  type BenchReport,
  type RunReport,
} from "../packages/core/src/index.js";
import { freePort, startDemo } from "./helpers.js";

let demo: Awaited<ReturnType<typeof startDemo>>;
let report: RunReport;
let tmp: string;

beforeAll(async () => {
  demo = await startDemo();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lt-rep-"));
  // nome com HTML/fórmula para testar escape em todos os formatos
  report = await runScenario(
    parseScenario(`
name: "<img src=x onerror=alert(1)> =cmd|calc"
seed: 1
target: { baseUrl: "${demo.url}" }
load: { warmup: 1s, stages: [ { duration: 4s, rps: 40 } ] }
thresholds: ["p95 < 500ms", "p99 < 0.001ms"]
flow:
  - name: "=SOMA(A1)"
    request: { path: "/flaky?every=10" }
`),
    { toolVersion: "test", connections: 8 },
  );
});
afterAll(async () => {
  await demo?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("formatos", () => {
  it("parseFormats", () => {
    expect(parseFormats("html, md")).toEqual(["html", "md"]);
    expect(parseFormats("all")).toContain("prom");
    expect(() => parseFormats("pdf")).toThrow(/desconhecido/);
    expect(DEFAULT_FORMATS).toEqual(["json", "html", "csv", "md", "junit"]);
  });

  it("grava todos os arquivos e o JSON é a fonte", () => {
    const files = writeRunReports(report, tmp, parseFormats("all"));
    expect(Object.keys(files).sort()).toEqual(
      [
        "junit.xml",
        "metrics.prom",
        "report.html",
        "report.json",
        "steps.csv",
        "summary.md",
        "timeline.csv",
      ].sort(),
    );
    expect(JSON.parse(fs.readFileSync(files["report.json"]!, "utf8")).run.id).toBe(report.run.id);
  });
});

describe("HTML autocontido", () => {
  const html = () => renderRunHtml(report);
  it("não depende de rede e traz gráficos SVG com dados para o tooltip", () => {
    const h = html();
    expect(h).not.toMatch(/<script[^>]+src=/);
    expect(h).not.toMatch(/<link[^>]+href=/);
    expect(h.match(/<svg viewBox/g)!.length).toBeGreaterThanOrEqual(5);
    for (const id of [
      "latency",
      "throughput",
      "errors",
      "concurrency",
      "percentiles",
      "histogram",
    ]) {
      expect(h).toContain(`id="data-${id}"`);
    }
    expect(h).toContain("prefers-color-scheme: dark");
    expect(Buffer.byteLength(h)).toBeLessThan(1_000_000);
  });
  it("escapa conteúdo vindo do cenário (sem injeção de HTML)", () => {
    const h = html();
    expect(h).not.toContain("<img src=x");
    expect(h).toContain("&lt;img src=x onerror=alert(1)&gt;");
    // JSON embutido nunca fecha a tag <script>
    const blocks = h.match(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)!;
    for (const b of blocks) expect(b.slice(30, -9)).not.toContain("<");
  });
  it("benchmark em HTML com links para as rodadas", () => {
    const b = {
      schemaVersion: 1,
      kind: "bench",
      tool: { name: "lt", version: "t" },
      bench: {
        id: "b1",
        status: "completed",
        startedAt: "",
        endedAt: "",
        mode: "single",
        runsPerGroup: 2,
        intervalMs: 0,
        order: ["A01", "A02"],
        seed: 1,
      },
      groups: [
        {
          label: "A",
          scenario: "s",
          baseUrl: "http://x",
          runs: [
            {
              id: "A01",
              status: "completed",
              invalid: false,
              requests: 1,
              errors: 0,
              report: "A01/report.json",
              p50: 1,
              p90: 2,
              p95: 3,
              p99: 4,
              mean: 1,
              rps: 10,
              errorRate: 0,
            },
            {
              id: "A02",
              status: "completed",
              invalid: false,
              requests: 1,
              errors: 0,
              report: "A02/report.json",
              p50: 1,
              p90: 2,
              p95: 3.5,
              p99: 4,
              mean: 1,
              rps: 10,
              errorRate: 0,
            },
          ],
          summary: Object.fromEntries(
            ["p50", "p90", "p95", "p99", "mean", "rps", "errorRate"].map((k) => [
              k,
              {
                n: 2,
                median: 1,
                mean: 1,
                stdev: 0,
                cvPct: 0,
                min: 1,
                max: 1,
                ci95: { lo: 1, hi: 1 },
              },
            ]),
          ),
        },
      ],
      warnings: [],
    } as unknown as BenchReport;
    const h = renderBenchHtml(b);
    expect(h).toContain('href="A01/report.html"');
    expect(h).toContain('id="data-rounds"');
    expect(benchMarkdown(b)).toContain("| p95 (ms) |");
  });
});

describe("distribuição", () => {
  it("curva de percentis é monótona e o histograma soma o total", () => {
    const c = percentileCurve(report.histograms.latencyUs);
    for (let i = 1; i < c.ms.length; i++) expect(c.ms[i]!).toBeGreaterThanOrEqual(c.ms[i - 1]!);
    const total = logBuckets(report.histograms.latencyUs).reduce((a, b) => a + b.count, 0);
    expect(Math.abs(total - report.summary.latencyMs.count)).toBeLessThanOrEqual(2);
  });
});

describe("CSV, Markdown, JUnit e Prometheus", () => {
  it("CSV com cabeçalho estável e proteção contra fórmulas", () => {
    const t = timelineCsv(report).split("\r\n");
    expect(t[0]).toBe(
      "t_s,warmup,target_rps,sent,requests,errors,concurrency,p50_ms,p95_ms,p99_ms,max_ms,cpu_pct,mem_pct",
    );
    expect(t.length).toBeGreaterThanOrEqual(5);
    const s = stepsCsv(report);
    expect(s).toContain(",'=SOMA(A1),"); // fórmula neutralizada
    expect(s).not.toMatch(/,=SOMA/);
  });

  it("Markdown: reprovado quando threshold falha; sem escapes dentro de código", () => {
    const md = runMarkdown(report);
    expect(md).toMatch(/^### ❌ lt · /);
    expect(md).toContain("| ❌ | `p99 < 0.001ms` |");
    expect(md).toContain("| ✅ | `p95 < 500ms` |");
    // escapado como "\<img": o GitHub mostra o texto literal, nunca HTML
    expect(md).not.toMatch(/(^|[^\\])<img/);
    expect(md).toContain("\\<img");
  });

  it("JUnit: um caso por threshold, falhas contadas e XML escapado", () => {
    const x = runJUnit(report);
    expect(x).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>/);
    expect(x).toContain('tests="4" failures="1"');
    expect(x).toContain('name="p99 &lt; 0.001ms"');
    expect(x.match(/<failure /g)!.length).toBe(1);
    expect(x).not.toContain("<img");
  });

  it("Prometheus: formato de exposição válido", () => {
    const p = runPrometheus(report);
    for (const line of p.trim().split("\n")) {
      expect(line).toMatch(/^(# (HELP|TYPE) [a-z_]+ .+|[a-z_]+\{[^}]*\} (-?[\d.e+-]+|NaN))$/);
    }
    expect(p).toContain("lt_errors_total{scenario=");
    expect(p).toMatch(/lt_threshold_passed\{[^}]*threshold="p99 < 0.001ms"\} 0/);
  });
});

describe("métricas ao vivo", () => {
  it("expõe /metrics só em 127.0.0.1", async () => {
    const port = await freePort();
    const live = new LiveMetrics("ao-vivo");
    await live.listen(port);
    live.update({
      elapsedMs: 3000,
      totalMs: 10_000,
      stage: 0,
      warmup: false,
      model: "open",
      targetRps: 50,
      targetVus: 0,
      sentRps: 50,
      rps: 49,
      errors: 1,
      concurrency: 3,
      totalRequests: 150,
      totalErrors: 2,
      latencyMs: { p50: 10, p95: 20, p99: 30 },
    });
    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(res.headers.get("content-type")).toMatch(/text\/plain; version=0.0.4/);
    const body = await res.text();
    expect(body).toContain('lt_live_rps{scenario="ao-vivo"} 49');
    expect(body).toContain('lt_live_latency_ms{scenario="ao-vivo",quantile="0.99"} 30');
    expect((await fetch(`http://127.0.0.1:${port}/outro`)).status).toBe(404);
    await live.close();
  });
});
