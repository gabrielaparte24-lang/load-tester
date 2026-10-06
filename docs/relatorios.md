# Relatórios do lt

Cada execução grava uma pasta (`reports/<AAAAMMDD-HHMMSS>-<cenário>/` ou a pasta de `--report-dir`) com:

| Arquivo                    | Formato (`--format`) | Para quê                                                        |
| -------------------------- | -------------------- | --------------------------------------------------------------- |
| `report.json`              | sempre               | fonte de verdade; formato estável descrito abaixo               |
| `report.html`              | `html`               | relatório autocontido (abre offline, sem dependências externas) |
| `timeline.csv`             | `csv`                | uma linha por segundo                                           |
| `steps.csv`                | `csv`                | uma linha por etapa/endpoint                                    |
| `summary.md`               | `md`                 | resumo para colar em PR ou em `$GITHUB_STEP_SUMMARY`            |
| `junit.xml`                | `junit`              | thresholds, validade e regressões como casos de teste           |
| `metrics.prom`             | `prom`               | formato de texto do Prometheus (textfile collector)             |
| `baseline-comparison.json` | com `--baseline*`    | resultado da comparação com a baseline                          |

Padrão: `json,html,csv,md,junit`. Use `--format all` para incluir `prom`. Para regenerar a partir de um
`report.json` ou `bench.json` existente: `lt report <pasta|id|arquivo> --format html,md`.

Benchmarks (`lt bench`) gravam `bench.json`, `bench.html`, `bench.csv` e `summary.md` na pasta do
benchmark, e cada rodada tem sua subpasta (`A01/`, `B01/`…) com os arquivos de execução.

## HTML

Uma única página, sem rede (CSS, scripts e gráficos SVG embutidos), com tema claro/escuro (segue o
sistema; botão "Tema" alterna):

- status (aprovado/reprovado, concluído/interrompido), indicadores e alertas (execução inválida,
  stopWhen, avisos);
- thresholds, erros por tipo e, com `--baseline`, a tabela de comparação;
- gráficos por segundo com crosshair e tooltip (mouse ou teclado ← →): latência p50/p95/p99, vazão
  (pedida × enviada), erros, concorrência, CPU da máquina; o aquecimento aparece sombreado;
- distribuição: latência por percentil (escala de "noves") e histograma em faixas logarítmicas;
- etapas, checagens reprovadas, falhas mais comuns, fases da requisição, gerador e máquina;
- a configuração (segredos mascarados) e a **tabela por segundo**, que é o equivalente acessível dos
  gráficos.

Execuções longas são reduzidas a ≤ 900 pontos nos gráficos (latência pelo **máximo** de cada intervalo,
para picos não sumirem; vazão pela média). A tabela e o CSV mantêm todos os segundos.

## CSV

`timeline.csv`: `t_s, warmup, target_rps, sent, requests, errors, concurrency, p50_ms, p95_ms, p99_ms,
max_ms, cpu_pct, mem_pct`.

`steps.csv`: `flow, step, method, path, requests, errors, error_rate, p50_ms, p90_ms, p95_ms, p99_ms,
p999_ms, max_ms, mean_ms, bytes_received, bytes_sent`.

Separador vírgula, decimal com ponto, fim de linha CRLF (RFC 4180). Células que começam com `= + - @`
e não são números recebem `'` na frente, para não virarem fórmulas ao abrir numa planilha.

## JUnit XML

Uma `testsuite` por execução, com casos:

- `execucao`: "execução válida (gerador sustentou a carga)" e "execução concluída";
- `thresholds`: um caso por threshold; falha com a mensagem `medido: …`;
- `baseline`: um caso por métrica comparada; falha quando o veredito é "pior".

As checagens individuais vão em `system-out`. A decisão de falhar o CI fica com os thresholds, porque
uma checagem que falha em 0,01% das requisições não deve, sozinha, reprovar um build.

## Prometheus

`metrics.prom` (pós-execução): `lt_requests_total`, `lt_errors_total{type}`,
`lt_latency_ms{quantile}` (summary), `lt_latency_max_ms`, `lt_rps_achieved`, `lt_rps_requested`,
`lt_error_ratio`, `lt_run_duration_seconds`, `lt_run_invalid`, `lt_threshold_passed{threshold}`, todos
com os rótulos `scenario` e `run`.

Ao vivo: `lt run --metrics-port 9464` expõe `http://127.0.0.1:9464/metrics` durante a execução
(`lt_live_*`: requisições, erros, vazão e latência do último segundo, concorrência, alvo e CPU). Fica
só em loopback. O dashboard (fase 5) também terá `/metrics`.

## `report.json` (`schemaVersion: 1`)

**Política de estabilidade:** dentro de `schemaVersion: 1` só há mudanças **aditivas** (novos campos).
Remover ou mudar o significado de um campo incrementa `schemaVersion`. Consumidores devem ignorar campos
desconhecidos. Tempos em **ms** (floats com 3 casas, resolução de µs); taxas como **fração 0..1**.

| Campo                             | Tipo / descrição                                                                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `schemaVersion`                   | `1`                                                                                                                                                                            |
| `tool`                            | `{ name: "lt", version }`                                                                                                                                                      |
| `run.id`                          | id da execução (nome da pasta)                                                                                                                                                 |
| `run.scenario`, `scenarioFile`    | nome e arquivo do cenário                                                                                                                                                      |
| `run.status`                      | `completed` · `interrupted` · `failed`                                                                                                                                         |
| `run.startedAt`, `endedAt`        | ISO 8601                                                                                                                                                                       |
| `run.durationMs`                  | duração real                                                                                                                                                                   |
| `run.seed`                        | semente dos dados aleatórios (reprodutibilidade)                                                                                                                               |
| `run.model`                       | `open` · `closed`                                                                                                                                                              |
| `run.invalid`, `invalidReasons`   | gerador saturado: os números não representam o alvo (exit 3)                                                                                                                   |
| `run.warnings`                    | avisos (descartes, teto de RPS, poucas amostras, CPU alta…)                                                                                                                    |
| `run.stopReason`, `breakingPoint` | quando `stopWhen` encerrou: `{ t, condition, measured, targetRps \| vus, achievedRps }`                                                                                        |
| `environment`                     | `{ node, platform, arch, cpus }`                                                                                                                                               |
| `config.target`                   | `{ baseUrl, headers (mascarados), timeoutMs, http2 }`                                                                                                                          |
| `config.load`                     | `{ model, stages[], vuStages[], pacingMs?, warmupMs, connections, maxInFlight?, workers, stopWhen[] }`                                                                         |
| `config.thresholds`               | expressões                                                                                                                                                                     |
| `config.flows[]`                  | `{ name, weight, steps: ["GET /x", …] }`                                                                                                                                       |
| `config.data[]`                   | `{ file, name?, order, rows, columns[] }`                                                                                                                                      |
| `config.variables`                | nomes                                                                                                                                                                          |
| `summary.windowMs`                | janela medida (sem aquecimento)                                                                                                                                                |
| `summary.requests`                | `{ total, ok, failed }`                                                                                                                                                        |
| `summary.iterations`              | `{ scheduled, started, completed, dropped }`                                                                                                                                   |
| `summary.errorRate`               | fração de requisições com falha                                                                                                                                                |
| `summary.rps`                     | `{ requested (null no fechado), sent, achieved }`                                                                                                                              |
| `summary.maxConcurrency`          | pico de iterações simultâneas / VUs                                                                                                                                            |
| `summary.latencyMs`               | desde o instante **previsto**: `{ count, min, mean, stdev, p50, p75, p90, p95, p99, p999, max }`                                                                               |
| `summary.serviceTimeMs`           | envio real → fim da resposta (mesmos campos)                                                                                                                                   |
| `summary.ttfbMs`, `downloadMs`    | envio → headers; headers → fim do corpo                                                                                                                                        |
| `summary.connections`             | `{ opened, byProtocol, dnsMs, connectMs, tlsMs }` (por conexão nova)                                                                                                           |
| `summary.statusCodes`             | `{ "200": n, "ws:101": n, "grpc:OK": n, … }`                                                                                                                                   |
| `summary.errorsByType`            | `timeout`, `connection_refused`, `connection_reset`, `dns`, `http_4xx`, `http_5xx`, `check_failed`, `template_error`, `ws_error`, `grpc_status`, `dropped`, `aborted`, `other` |
| `summary.bytes`                   | `{ received, sent }`                                                                                                                                                           |
| `summary.checks`                  | `{ passed, failed }`                                                                                                                                                           |
| `summary.ws`                      | só com etapas WebSocket: `{ sessions, messagesSent, messagesReceived, connectMs (handshake), rttMs (envio → mensagem esperada) }`                                              |
| `steps[]`                         | por etapa: `flow, name, method, path, requests, errors, errorRate, latencyMs, statusCodes, errorsByType, bytes, checks[{name,passed,failed}], failures[{message,count}]`       |
| `timeline[]`                      | por segundo: `t, warmup, targetRps, sentRps, rps, errors, concurrency, latencyMs{p50,p95,p99,max}, cpu?, memPct?`                                                              |
| `thresholds[]`                    | `{ expression, metric, op, value, actual, passed }`                                                                                                                            |
| `generator`                       | `{ workers, scheduleLagMs, loopLagMs, cpuPercent, timerMarginMs, throttled }`                                                                                                  |
| `machine`                         | `{ cpuAvg, cpuMax, memMaxPct, rssMaxMb }` ou `null`                                                                                                                            |
| `histograms.latencyUs`            | HdrHistogram (µs) em base64 comprimido; decodifique com `hdr-histogram-js` (`decodeFromCompressedBase64`)                                                                      |

O `bench.json` (`kind: "bench"`) traz `bench` (id, status, modo, ordem real das rodadas, semente),
`groups[]` (rodadas com p50/p90/p95/p99/média/vazão/erros e `summary` com mediana, IC 95%, CV, mínimo
e máximo por métrica), `comparison` (A/B) e `warnings`.
