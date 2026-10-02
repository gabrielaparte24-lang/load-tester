# lt — testador de carga e benchmarking de endpoints HTTP

CLI + (em breve) dashboard em tempo real + relatórios reproduzíveis, com métricas estatisticamente corretas
(HdrHistogram, correção de omissão coordenada) e thresholds para CI.

> **⚠ Uso responsável.** Use apenas contra sistemas próprios ou com **autorização por escrito**.
> Esta ferramenta não deve ser usada para negação de serviço (DoS). Por padrão ela só aceita alvos em
> `localhost`/`127.0.0.1`/`::1` e nas faixas de `ALLOWED_TARGETS`; qualquer outro host exige
> `--i-own-this-target` **e** confirmação explícita do hostname.

**Estado:** Fase 0 (experimento mínimo ponta a ponta) concluída — scripts de operação, demo-target,
`lt run` com modelo aberto e relatório JSON. Veja o [roadmap](#roadmap).

## Requisitos

- **Node.js ≥ 22.19** (testado no 26.7) e npm. Windows, Linux e macOS.
  O SQLite (fases seguintes) usa o `node:sqlite` embutido — sem compilação nativa.

## Instalação e operação

```bash
npm run setup                 # verifica Node/npm, instala, compila, cria .env e data/ reports/ logs/ run/
npm start                     # sobe a API em segundo plano em http://127.0.0.1:4000
npm start -- --with-demo      # ... e também o alvo de demonstração em http://127.0.0.1:4100
npm run status                # estado dos serviços e testes em andamento
npm run stop                  # para tudo (só processos do lt), salvando testes em andamento como "interrompido"
npm run restart -- --with-demo
```

Equivalentes sem npm: `scripts/<nome>.sh` (Linux/macOS), `scripts\<nome>.bat` (cmd) e
`scripts\<nome>.ps1` (PowerShell), para `setup`, `start`, `stop`, `status` e `restart`.

| Script    | Opções                                                                                                     |
| --------- | ---------------------------------------------------------------------------------------------------------- |
| `setup`   | `--skip-build` (só instala), `--force` (reinstala dependências mesmo se atualizadas)                       |
| `start`   | `--with-demo`, `--foreground` (primeiro plano), `--dev` (hot reload com `tsx watch`), `--open` (navegador) |
| `stop`    | `--clean-logs` (apaga `logs/*.log*`), `--timeout=10` (segundos antes de forçar)                            |
| `restart` | repassa as opções ao `start`                                                                               |

Como os scripts se comportam:

- **Idempotentes**: `start` com o serviço já no ar só informa; `stop` sem nada rodando não falha.
- **Só mexem no que é nosso**: o PID fica em `run/<serviço>.pid` (+ `run/<serviço>.json` com `instanceId`).
  Um processo só é considerado nosso se o `/health` devolver o mesmo `instanceId` ou se a linha de comando
  contiver o nosso entrypoint. PIDs mortos ou **reaproveitados** por outro programa são detectados e o
  arquivo é descartado sem matar nada.
- **Porta ocupada**: `start` mostra o PID e o nome do processo dono da porta e sai sem derrubá-lo.
- **Parada graciosa → forçada**: `stop` pede encerramento via endpoint de controle (protegido por token
  aleatório gerado no `start`), espera o timeout e só então encerra a árvore de processos
  (`taskkill /T /F` no Windows; `SIGTERM`→`SIGKILL` no grupo de processos no Linux/macOS).
- **Testes do CLI em andamento**: cada `lt run` registra `run/cli-<pid>.json`; o `stop` pede a parada,
  o teste drena as requisições em andamento e grava o relatório parcial com `status: "interrupted"`.
- **Logs** em `logs/<serviço>.log`, com rotação simples (5 MB × 3) a cada `start`.

## Configuração (`.env`)

Criado a partir de [`.env.example`](.env.example) pelo `setup`. Principais variáveis:

| Variável                         | Padrão                 | Descrição                                                           |
| -------------------------------- | ---------------------- | ------------------------------------------------------------------- |
| `LT_PORT`                        | `4000`                 | API/dashboard (sempre em `127.0.0.1`)                               |
| `LT_DEMO_PORT`                   | `4100`                 | alvo de demonstração                                                |
| `LT_DATA_DIR` / `LT_REPORTS_DIR` | `./data` / `./reports` | precisam ficar dentro do projeto                                    |
| `LT_MAX_RPS`                     | `2000`                 | teto de RPS por execução (`--max-rps` eleva pontualmente)           |
| `LT_MAX_CONNECTIONS`             | `512`                  | teto de conexões (`--max-connections`)                              |
| `LT_MAX_DURATION`                | `2h`                   | duração máxima de uma execução                                      |
| `ALLOWED_TARGETS`                | _(vazio)_              | hosts, IPs ou CIDRs extras permitidos: `10.0.0.0/8,*.interna.local` |

Segredos usados nos cenários vêm do ambiente/`.env` via `${env.NOME}` e são **mascarados** (`***`) em
relatórios e logs; headers como `Authorization`, `Cookie` e `X-Api-Key` são sempre mascarados.

## Executando testes de carga

```bash
npm start -- --with-demo
npm run lt -- run examples/smoke.yaml        # ou: npx lt run examples/smoke.yaml
npx lt validate examples/*.yaml              # valida sem executar
```

Durante a execução há uma linha de progresso por segundo; **Ctrl+C** para de agendar e drena as
requisições em andamento (até 5 s) e salva o relatório parcial; um segundo Ctrl+C força a saída.

Opções de `lt run`: `--out <dir>`, `--quiet`, `--max-rps <n>`, `--max-connections <n>`,
`--i-own-this-target`, `--confirm-target <host>` (confirmação não interativa para CI).

### Cenário (subconjunto da Fase 0)

```yaml
name: checkout-api
target:
  baseUrl: http://127.0.0.1:4100
  headers: { Authorization: "Bearer ${env.API_TOKEN}" }
  timeoutMs: 5000
load:
  model: open # taxa de chegada fixa
  warmup: 5s # descartado das estatísticas
  stages:
    - { duration: 5s, rps: 50 }
    - { duration: 2m, rps: 50 -> 300 } # rampa linear
    - { duration: 5m, rps: 300 }
thresholds: ["p95 < 300ms", "p99 < 800ms", "errorRate < 1%"]
flow:
  - name: listar produtos
    request: { method: GET, path: /products, query: { page: 1 } }
    expect: { status: 200 }
  - name: criar
    request: { method: POST, path: /echo, json: { id: 1 } } # também: body (texto) ou form
    expect: { status: [200, 201], maxDuration: 500ms }
    think: 500ms
```

Erros de validação apontam arquivo, **linha, coluna** e campo. Templates (`randInt`, `uuid`, CSV,
extração/encadeamento), modelo fechado e pesos entre fluxos chegam na Fase 1/2.

Thresholds suportados: `p50`…`p99.9` (qualquer percentil), `min`, `max`, `mean`/`avg`, `errorRate`
(`%` ou fração), `rps`; operadores `<`, `<=`, `>`, `>=`, `==`; unidades `ms`, `s`, `us`.

### Exit codes

| Código | Significado                                                         |
| ------ | ------------------------------------------------------------------- |
| `0`    | ok                                                                  |
| `1`    | algum threshold violado                                             |
| `2`    | erro de configuração/cenário/segurança                              |
| `3`    | execução inválida (o gerador não sustentou a taxa)                  |
| `130`  | interrompido (Ctrl+C ou `npm run stop`) — relatório parcial é salvo |

## Como as métricas são medidas

**Modelo aberto (padrão).** As chegadas seguem um cronograma determinístico calculado a partir da taxa
pedida (inclusive em rampas: a k-ésima chegada ocorre quando a integral da taxa atinge k + ½). Novas
requisições saem no horário **independentemente** de as anteriores terem respondido — como usuários reais
de uma API. No modelo fechado (N usuários em laço, Fase 2) um servidor lento reduz a própria carga, o que
esconde problemas.

**Omissão coordenada.** A latência é medida a partir do instante em que a requisição **deveria** ter
sido enviada, não de quando foi enviada. Se o pool de conexões estiver saturado ou o alvo engasgar, a
espera entra na latência (como o usuário sentiria). O relatório traz também o **tempo de serviço**
(envio real → resposta) e o **atraso de agendamento** do gerador, separadamente.

**Precisão do agendador.** No Windows, `setTimeout` tem granularidade de ~15,6 ms (medido: `setTimeout(1)`
dispara ~15 ms depois), o que viraria latência fantasma. O agendador dorme até ~17 ms antes do prazo
(2 ms em Linux/macOS) e faz a aproximação final com `setImmediate`, com precisão de microssegundos. O custo
é ~1 núcleo de CPU ocupado durante o teste.

**Histogramas.** Latências vão para HdrHistogram (µs, 3 dígitos significativos → erro ≤ 0,1%); nunca médias
de médias. O relatório inclui o histograma codificado para comparações futuras.

**Validade.** Se o atraso de agendamento p99 passar de 10 ms, o gerador não sustentou a taxa: o relatório
é marcado `invalid` e o CLI sai com código 3. Gerador e alvo na mesma máquina disputam CPU — leve isso em
conta em taxas altas.

### Validação da própria ferramenta (Windows 11, Node 26.7, alvo local)

| Experimento                           | Esperado           | Medido                                        |
| ------------------------------------- | ------------------ | --------------------------------------------- |
| `/slow?ms=100` a 100 rps, 20 s        | p50 ≈ p99 ≈ 100 ms | p50 100,80 · p99 101,69 · máx 105,43 ms       |
| taxa a 100 / 200 / 1000 rps           | ±2% da pedida      | 100,00 / 200,00 / 1000,00 (0,00%)             |
| `/flaky?rate=0.05`, 3 × 16 000 req    | ≈ 5% (σ ≈ 0,17%)   | 4,71% · 4,94% · 4,96%                         |
| `/flaky?every=20` (determinístico)    | exatamente 5%      | 5% (950 × 200, 50 × 500) — teste automatizado |
| kill switch (Ctrl+C / `npm run stop`) | poucos segundos    | 0,4 s, parcial salvo, exit 130                |

## Relatório JSON (`schemaVersion: 1`)

Gravado em `reports/<AAAAMMDD-HHMMSS>-<cenário>/report.json`. Campos principais:

- `run`: id, status (`completed` | `interrupted` | `failed`), início/fim, seed, `invalid` + motivos, avisos.
- `config`: alvo (headers mascarados), etapas, aquecimento, conexões, thresholds.
- `summary`: janela medida, requisições ok/falhas, iterações (agendadas/iniciadas/concluídas/descartadas),
  `errorRate` (0..1), `rps` (pedida/enviada/concluída), `latencyMs` e `serviceTimeMs`
  (`count, min, mean, stdev, p50, p75, p90, p95, p99, p999, max`), status HTTP, erros por tipo
  (`timeout`, `connection_refused`, `connection_reset`, `dns`, `http_4xx`, `http_5xx`, `check_failed`, …), bytes.
- `steps[]`: as mesmas métricas por etapa do fluxo.
- `timeline[]`: por segundo — taxa pedida/enviada/concluída, erros, p50/p95/p99/máx.
- `thresholds[]`: expressão, valor medido, aprovado.
- `generator`: atraso de agendamento, CPU do processo.
- `histograms.latencyUs`: HdrHistogram base64 comprimido.

## Alvo de demonstração

`npm start -- --with-demo` sobe em `http://127.0.0.1:4100`:
`/fast`, `/slow?ms=100&jitter=10`, `/flaky?rate=0.05&status=500`, `/flaky?every=20`, `/echo`,
`/status/:code`, `/bytes?n=1024`, `/products?page=1`, `/products/:id`, `/health`.

## Desenvolvimento

```bash
npm run build       # tsc -b (monorepo com project references)
npm test            # build + Vitest (unidade, parser, percentis, taxa ±2%, erros, kill switch, API)
npm run lint        # ESLint
npm run format      # Prettier
```

Estrutura: `packages/core` (motor, métricas, cenários), `packages/cli` (`lt`), `packages/server` (API),
`packages/demo-target`, `scripts/` (operação), `examples/`, `tests/`.

## Solução de problemas

- **"porta 4000 já está em uso pelo PID X"** — outro programa usa a porta; altere `LT_PORT` no `.env`.
  O lt nunca encerra processos que não iniciou.
- **"alvo ... fora da allowlist"** — adicione o host/faixa em `ALLOWED_TARGETS` ou, se o sistema é seu,
  use `--i-own-this-target` (e `--confirm-target <host>` em CI).
- **"resultado inválido: o gerador não conseguiu sustentar a taxa"** (exit 3) — reduza a taxa, feche
  programas pesados ou rode o gerador em outra máquina. (Workers multi-núcleo chegam na Fase 2.)
- **npm 12 avisa "install scripts blocked" (esbuild)** — inofensivo: o binário do esbuild vem como
  dependência opcional; `tsx` e `vitest` funcionam sem o postinstall.
- **Serviço não sobe** — o `start` mostra o fim de `logs/<serviço>.log`; veja o arquivo completo.

## Roadmap

- [x] **Fase 0** — scripts, demo-target, `lt run` (modelo aberto), relatório JSON, validação.
- [ ] **Fase 1** — JSON Schema, templates (`randInt`, `uuid`, `pick`), CSV, extração/encadeamento,
      pesos, `lt init`, import cURL/OpenAPI.
- [ ] **Fase 2** — `worker_threads`, modelo fechado, perfis (smoke/load/stress/spike/soak), tempos de
      DNS/conexão/TLS/TTFB, HTTP/2, detecção ampliada de saturação, CPU/memória.
- [ ] **Fase 3** — `lt bench`, A/B, `lt compare` com significância estatística, baseline.
- [ ] **Fase 4** — relatórios HTML/CSV/Markdown, JUnit, Prometheus, exemplo de GitHub Actions.
- [ ] **Fase 5** — API completa, SQLite, tempo real (SSE/WebSocket), dashboard React.
- [ ] **Extras** — WebSocket e gRPC como alvo.
