# lt — testador de carga e benchmarking de endpoints HTTP

CLI + (em breve) dashboard em tempo real + relatórios reproduzíveis, com métricas estatisticamente corretas
(HdrHistogram, correção de omissão coordenada) e thresholds para CI.

> **⚠ Uso responsável.** Use apenas contra sistemas próprios ou com **autorização por escrito**.
> Esta ferramenta não deve ser usada para negação de serviço (DoS). Por padrão ela só aceita alvos em
> `localhost`/`127.0.0.1`/`::1` e nas faixas de `ALLOWED_TARGETS`; qualquer outro host exige
> `--i-own-this-target` **e** confirmação explícita do hostname.

**Estado:** Fases 0 e 1 concluídas — scripts de operação, demo-target, `lt run` com modelo aberto,
relatório JSON e cenários completos (JSON Schema, templates, CSV, encadeamento, checagens, pesos,
`lt init`, importação de cURL/OpenAPI). Veja o [roadmap](#roadmap).

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
npx lt validate examples/*.yaml              # valida sem executar (--preview N mostra as requisições)
```

Durante a execução há uma linha de progresso por segundo; **Ctrl+C** para de agendar e drena as
requisições em andamento (até 5 s) e salva o relatório parcial; um segundo Ctrl+C força a saída.

Opções de `lt run`: `--out <dir>`, `--quiet`, `--max-rps <n>`, `--max-connections <n>`,
`--i-own-this-target`, `--confirm-target <host>` (confirmação não interativa para CI).

### Exit codes

| Código | Significado                                                         |
| ------ | ------------------------------------------------------------------- |
| `0`    | ok                                                                  |
| `1`    | algum threshold violado                                             |
| `2`    | erro de configuração/cenário/segurança                              |
| `3`    | execução inválida (o gerador não sustentou a taxa)                  |
| `130`  | interrompido (Ctrl+C ou `npm run stop`) — relatório parcial é salvo |

## Cenários

Comece com um exemplo comentado, valide e veja as requisições montadas antes de gerar carga:

```bash
npx lt init cenarios/meu.yaml --target http://127.0.0.1:4100
npx lt validate cenarios/meu.yaml --preview 3   # monta (sem enviar) as 3 primeiras iterações
npx lt run cenarios/meu.yaml
```

Os cenários são YAML (ou JSON) validados por um **JSON Schema** ([schema/scenario.schema.json](schema/scenario.schema.json))
mais regras semânticas. Os erros apontam arquivo, **linha, coluna** e campo — todos de uma vez:

```text
✗ meu.yaml: 3 problema(s)
  - linha 6, coluna 19: load.stages[0].duration: duração inválida: use ms, s, m ou h (ex.: "500ms", "30s", "1m30s")
  - linha 13, coluna 40: flows[0].steps[0].request.path: variável "produto" não definida (disponíveis: page)
  - linha 18, coluna 18: flows[0].steps[1].extrass: campo desconhecido "extrass" (permitidos: name, request, expect, extract, think)
```

Para autocompletar no VS Code (extensão YAML da Red Hat), a primeira linha do arquivo aponta o schema —
`lt init` e `lt import` já fazem isso: `# yaml-language-server: $schema=../schema/scenario.schema.json`.

### Estrutura completa

```yaml
name: checkout-api
seed: 42 # dados aleatórios reprodutíveis (omitido = semente aleatória, registrada no relatório)
target:
  baseUrl: http://127.0.0.1:4100 # pode ter caminho: https://api.interna/v1
  headers: { Authorization: "Bearer ${env.API_TOKEN}" } # vale para todas as etapas
  timeoutMs: 5000 # ou timeout: 5s
load:
  model: open
  warmup: 5s
  stages:
    - { duration: 30s, rps: 50 }
    - { duration: 2m, rps: 50 -> 300 }
thresholds: ["p95 < 300ms", "errorRate < 1%"]
variables: # avaliadas no início de cada iteração, em ordem
  page: "${randInt(1, 20)}"
  cliente: "${pick('ana', 'bruno', 'carla')}"
data: # CSV com cabeçalho; colunas viram variáveis
  file: ./dados/clientes.csv # relativo ao arquivo do cenário
  order: sequential # rodízio (padrão) ou random
  # name: cli        # opcional: acesso como ${cli.email}
flows: # ou `flow:` (lista de etapas) quando há um único fluxo
  - name: navegar
    weight: 3 # 3 de cada 4 iterações
    steps:
      - name: listar produtos
        request: { method: GET, path: /products, query: { page: "${page}" } }
        expect: { status: 200, jsonPath: { "$.items.length": ">0" } }
        extract: { productId: "$.items[0].id" }
        think: 500ms..2s # pausa aleatória (ou fixa: 500ms)
      - name: detalhe
        request: { method: GET, path: "/products/${productId}" }
        expect: { status: 200, maxDuration: 300ms }
  - name: comprar
    weight: 1
    steps:
      - request:
          method: POST
          path: /echo
          json: { id: "${randInt(1, 1000)}", email: "${email}", quando: "${isoNow()}" }
```

### Templates `${...}`

Funcionam em `path`, `query`, `headers`, `json`, `body`, `form`, campos de `multipart` e `variables`.

| Expressão                                                    | Resultado                                                          |
| ------------------------------------------------------------ | ------------------------------------------------------------------ |
| `${nome}` `${cli.email}` `${itens[0].id}`                    | variável, propriedade ou índice (de `variables`, CSV ou `extract`) |
| `${env.API_TOKEN}`                                           | variável de ambiente/`.env` — resolvida ao carregar, **mascarada** |
| `${randInt(1, 20)}` `${randFloat(1, 9, 2)}`                  | número aleatório (inclusivo) / decimal com casas                   |
| `${uuid()}` `${randString(8)}`                               | UUID v4 / texto alfanumérico (ou `randString(4, 'abc')`)           |
| `${pick('a', 'b', 'c')}`                                     | escolhe um item (ou `pick(lista)`)                                 |
| `${iteration()}` `${__iteration}`                            | índice global da iteração (0, 1, 2…)                               |
| `${now()}` `${isoNow()}`                                     | epoch em ms / data ISO 8601                                        |
| `${num(x)}` `${str(x)}`                                      | conversões                                                         |
| `${base64(x)}` `${urlencode(x)}` `${lower(x)}` `${upper(x)}` | utilidades — ex.: `Basic ${base64(env.CRED)}`                      |
| `$${texto}`                                                  | escape: produz literalmente `${texto}`                             |

- No `json`, uma string que é **só** uma expressão preserva o tipo: `id: "${randInt(1, 9)}"` envia número;
  `id: "n-${randInt(1, 9)}"` envia texto.
- **Reprodutibilidade:** cada iteração k tem um gerador aleatório próprio derivado de `(seed, k)` (sfc32).
  Com a mesma `seed`, as mesmas iterações geram os mesmos dados — independentemente da concorrência, da
  ordem das respostas e da máquina. A semente usada fica em `run.seed` no relatório.
- Variáveis inexistentes são apontadas **na validação** (inclusive "só é extraída na etapa 3, depois desta").

### Corpo da requisição

Use um entre `json`, `body` (texto), `form` (urlencoded), `file` (bytes de um arquivo, `contentType`
deduzido pela extensão) e `multipart` (`campo: "texto"` ou `foto: { file: ./a.png, contentType: image/png }`).
`contentType` sobrescreve o padrão; `headers` da etapa sobrescrevem os de `target` (sem diferenciar maiúsculas).

### Extração e encadeamento (`extract`)

```yaml
extract:
  token: "$.data.token" # JSONPath (atalho)
  local: { header: location } # header da resposta
  pedido: { regex: "pedido=(\\d+)", group: 1 } # regex no corpo (grupo 1 por padrão se houver)
  plano: { jsonPath: "$.plano", default: basico } # valor padrão se não encontrar
```

O valor fica disponível nas etapas seguintes da mesma iteração. Se a extração falhar (sem `default`), a
etapa conta como `check_failed` e a iteração para ali — etapas dependentes não são enviadas.

JSONPath suportado: `$`, `.nome`, `['nome']`, `[0]`, `[-1]`, `[*]`/`.*` (vira lista) e `.length`.

### Checagens (`expect`)

```yaml
expect:
  status: 200 # ou [200, 201]; sem status, qualquer < 400 é sucesso
  maxDuration: 300ms # latência (desde o instante previsto) acima disso falha
  jsonPath: { "$.items.length": ">0", "$.ok": true, "$.id": exists, "$.nome": "~^Ana" }
  headers: { content-type: "~json" }
  bodyContains: "pedido criado" # ou lista
  bodyMatches: "id=\\d+"
```

Matchers: valor literal (igualdade), `">0"` `">= 5"` `"<10"` `"<= 2"`, `"== ok"` `"!= erro"`,
`"~regex"`, `exists`, `!exists`. Dica: regex em YAML fica mais simples entre aspas simples
(`'~@exemplo\.test$'`).

Cada checagem é contada separadamente; o resumo e o relatório mostram as reprovadas e as **mensagens de
falha mais comuns** (ex.: `$.body.idade < 35 (recebido: 41)`). Status fora do esperado conta como
`http_4xx`/`http_5xx`; as demais falhas como `check_failed`; templates que não puderam ser montados como
`template_error`.

### Importar de cURL e OpenAPI

```bash
npx lt import curl "curl -X POST https://api.exemplo.test/v1/x -H 'Authorization: Bearer ...' --json '{\"q\":1}'" -o cenarios/x.yaml
npx lt import curl --file comando-curl.txt -o cenarios/x.yaml   # evita o segredo no histórico do shell
npx lt import openapi openapi.yaml -o cenarios/api.yaml [--base-url URL] [--all-methods]
```

- **Segredos nunca são copiados**: `Authorization`, `Cookie`, chaves de API e `-u usuario:senha` viram
  `${env.LT_*}` e o comando lista as variáveis a definir no `.env`.
- cURL: entende `-X`, `-H`, `-d`/`--data*`, `--data-urlencode`, `--json`, `-F` (multipart), `-G`, `-u`,
  `-b`, `-A`, `-e`, `--url`; aceita continuações de linha do bash (`\`), cmd (`^`) e PowerShell (`` ` ``).
- OpenAPI 3.x e Swagger 2.0: resolve `$ref` locais e variáveis de servidor, gera valores de exemplo a
  partir dos schemas (`example`, `default`, `enum`, formatos `uuid`/`email`/`date-time`, faixas numéricas)
  e cria **um fluxo de peso 1 por operação**. Por segurança só inclui `GET`/`HEAD`; `--all-methods` inclui
  os que alteram dados.

`lt schema [-o arquivo]` imprime o JSON Schema.

### Thresholds

`p50`…`p99.9` (qualquer percentil), `min`, `max`, `mean`/`avg`, `errorRate` (`%` ou fração), `rps`;
operadores `<`, `<=`, `>`, `>=`, `==`; unidades `ms`, `s`, `us`.

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
- `config`: alvo (headers mascarados), etapas de carga, aquecimento, conexões, thresholds, `flows`
  (nome, peso, etapas), `data` (arquivo, ordem, linhas, colunas) e nomes de `variables`.
- `summary`: janela medida, requisições ok/falhas, iterações (agendadas/iniciadas/concluídas/descartadas),
  `errorRate` (0..1), `rps` (pedida/enviada/concluída), `latencyMs` e `serviceTimeMs`
  (`count, min, mean, stdev, p50, p75, p90, p95, p99, p999, max`), status HTTP, erros por tipo
  (`timeout`, `connection_refused`, `connection_reset`, `dns`, `http_4xx`, `http_5xx`, `check_failed`,
  `template_error`, …), bytes, `checks` (aprovadas/reprovadas).
- `steps[]`: as mesmas métricas por etapa (`flow` + `name`), `checks[]` (nome, aprovadas, reprovadas) e
  `failures[]` (mensagens de falha mais frequentes, até 20 distintas, já mascaradas).
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
- [x] **Fase 1** — JSON Schema, templates (`randInt`, `uuid`, `pick`), CSV, extração/encadeamento,
      pesos, `lt init`, import cURL/OpenAPI.
- [ ] **Fase 2** — `worker_threads`, modelo fechado, perfis (smoke/load/stress/spike/soak), tempos de
      DNS/conexão/TLS/TTFB, HTTP/2, detecção ampliada de saturação, CPU/memória.
- [ ] **Fase 3** — `lt bench`, A/B, `lt compare` com significância estatística, baseline.
- [ ] **Fase 4** — relatórios HTML/CSV/Markdown, JUnit, Prometheus, exemplo de GitHub Actions.
- [ ] **Fase 5** — API completa, SQLite, tempo real (SSE/WebSocket), dashboard React.
- [ ] **Extras** — WebSocket e gRPC como alvo.
