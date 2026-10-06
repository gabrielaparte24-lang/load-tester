# lt — testador de carga e benchmarking de endpoints HTTP

[![ci](https://github.com/gabrielaparte24-lang/load-tester/actions/workflows/ci.yml/badge.svg)](https://github.com/gabrielaparte24-lang/load-tester/actions/workflows/ci.yml)

CLI + dashboard em tempo real + relatórios reproduzíveis, com métricas estatisticamente corretas
(HdrHistogram, correção de omissão coordenada) e thresholds para CI.

> **⚠ Uso responsável.** Use apenas contra sistemas próprios ou com **autorização por escrito**.
> Esta ferramenta não deve ser usada para negação de serviço (DoS). Por padrão ela só aceita alvos em
> `localhost`/`127.0.0.1`/`::1` e nas faixas de `ALLOWED_TARGETS`; qualquer outro host exige
> `--i-own-this-target` **e** confirmação explícita do hostname.

**Estado:** Fases 0 a 5 concluídas — scripts de operação, demo-target, `lt run` com modelo aberto,
relatório JSON e cenários completos (JSON Schema, templates, CSV, encadeamento, checagens, pesos,
`lt init`, importação de cURL/OpenAPI), motor multi-núcleo com modelos aberto e fechado, perfis,
tempos por fase, HTTP/2, detecção de saturação, benchmarks A/B com significância estatística e
baselines de regressão, relatórios HTML/CSV/Markdown/JUnit/Prometheus, exemplo de CI, API REST + SSE e dashboard web. Veja o [roadmap](#roadmap).

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
| `stop`    | `--clean-logs` (apaga `logs/*.log*`), `--timeout=20` (segundos antes de forçar)                            |
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
| `LT_MAX_VUS`                     | `1000`                 | teto de usuários virtuais no modelo fechado (`--max-vus`)           |
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

Opções de `lt run`: `--out <dir>`, `--report-dir <dir>`, `--format <lista>`, `--quiet`, `--workers <n|auto>`,
`--no-system-metrics`, `--metrics-port <porta>`, `--baseline`, `--baseline-file <arq>`, `--save-baseline`,
`--max-rps <n>`, `--max-connections <n>`, `--max-vus <n>`, `--i-own-this-target`,
`--confirm-target <host>` (confirmação não interativa para CI).

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
  bruto: { bytes: hex } # corpo/mensagem inteiro em hex ou base64
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
`"~regex"`, `exists`, `!exists`. Os matchers são valores fixos (`${…}` é recusado na validação, pois
seria comparado literalmente); para conferir um valor dinâmico, extraia-o e use-o na etapa seguinte. Dica: regex em YAML fica mais simples entre aspas simples
(`'~@exemplo\.test$'`).

Cada checagem é contada separadamente; o resumo e o relatório mostram as reprovadas e as **mensagens de
falha mais comuns** (ex.: `$.body.idade < 35 (recebido: 41)`). Status fora do esperado conta como
`http_4xx`/`http_5xx`; as demais falhas como `check_failed`; templates que não puderam ser montados como
`template_error`.

### WebSocket e gRPC como alvo

Além de `request` (HTTP), uma etapa pode ser `ws` ou `grpc` — exatamente um dos três. O endereço é
**sempre** `target.baseUrl` (não há host por etapa), então allowlist, tetos de taxa/conexões e kill
switch valem do mesmo jeito. Exemplos completos: [examples/websocket.yaml](examples/websocket.yaml) e
[examples/grpc.yaml](examples/grpc.yaml).

**WebSocket** — cada iteração abre uma conexão (`http`→`ws://`, `https`→`wss://`), roda o roteiro em
ordem e fecha. A latência da etapa é a sessão inteira; o resumo mostra também o **handshake** e o **RTT
por mensagem** (do último envio até a mensagem esperada) em `summary.ws`.

```yaml
- name: eco
  ws:
    path: /ws/echo?welcome=1
    headers: { Authorization: "Bearer ${env.API_TOKEN}" } # + target.headers
    subprotocols: [chat.v1] # opcional
    script:
      - expect: { jsonPath: { "$.type": welcome }, timeout: 2s } # espera a PRÓXIMA mensagem
        extract: { sessao: "$.session" } # vale para as ações seguintes
      - sendJson: { sessao: "${sessao}", n: "${iteration()}" }
      - expect: { jsonPath: { "$.n": 1 }, bodyContains: sessao }
      - sleep: 100ms
      - send: "texto ${sessao}"
      - expect: { bodyMatches: "^texto " }
  expect: { maxDuration: 1s } # no nível da etapa ws só vale maxDuration
```

**Mensagens binárias** — `sendBinary` envia um quadro binário a partir de `hex` (espaços ignorados) ou
`base64`, ambos com templates, ou de um `file` (lido na validação, até 16 MB). No `expect` da mensagem,
`type: binary | text` checa o tipo do quadro, `size` o tamanho em bytes e `hex` o conteúdo em hex
minúsculo (matchers: `16`, `">= 4"`, `"~^4c54"`); `extract: { x: { bytes: hex } }` guarda a mensagem
inteira para devolvê-la num `sendBinary: { hex: "${x}" }`. Checagens de texto (`bodyContains`,
`jsonPath`…) leem quadros binários como UTF-8. Exemplo:
[examples/websocket-binario.yaml](examples/websocket-binario.yaml).

```yaml
script:
  - expect: { type: binary, size: 16, hex: "~^4c543031" }
    extract: { token: { bytes: hex } }
  - sendBinary: { hex: "${token}" } # ou { base64: "AAEC/w==" } ou { file: ./frame.bin }
  - expect: { type: binary, size: 16 }
```

Status: `ws:101` (sessão aberta) ou `ws:falha` (handshake recusado). Erros: `timeout` (handshake ou
mensagem que não chegou a tempo), `connection_refused`/`dns`/…, `ws_error` (HTTP ≠ 101 no handshake,
conexão fechada pelo servidor) e `check_failed`. Checagens aparecem como `msg N: …`.

**gRPC** (unário e streaming) — o `.proto` é carregado na validação (serviço, método e tipo de
streaming são conferidos com mensagens claras). `http://` = sem TLS; `https://` = TLS (com `target.tls.ca` para CA própria).
`target.timeoutMs` é o deadline da chamada unária (`grpc.deadline` muda); `target.headers` e
`metadata` viram metadados.

```yaml
- name: SayHello
  grpc:
    proto: ./protos/demo.proto # relativo ao cenário
    service: demo.Greeter # com o pacote
    method: SayHello
    message: { name: "${nome}", times: 2 } # JSON com templates
    metadata: { x-pedido: "${uuid()}" }
  expect:
    grpcStatus: OK # padrão; aceita nome, número ou lista: [OK, NOT_FOUND]
    jsonPath: { "$.message": "~^Olá" } # a resposta vira JSON (campos como no .proto)
  extract: { tamanho: "$.length" }
```

Status: `grpc:OK`, `grpc:UNAVAILABLE`… Erros: `grpc_status` (código fora de `grpcStatus`), `timeout`
(DEADLINE_EXCEEDED), `connection_refused` e `check_failed`.

**Streaming gRPC** — o tipo vem do `.proto` e define o que vale no `script` (ações em ordem):

| tipo                                   | requisição       | `script`                                       | checagens da etapa (`expect`/`extract`) |
| -------------------------------------- | ---------------- | ---------------------------------------------- | --------------------------------------- |
| server (`returns (stream X)`)          | `message`        | `expect` (+ `extract`), `sleep`                | última mensagem do stream               |
| client (`(stream X) returns (Y)`)      | `send` no script | `send`, `sleep`, `end`                         | a resposta única                        |
| bidi (`(stream X) returns (stream Y)`) | `send` no script | `send`, `expect` (+ `extract`), `sleep`, `end` | última mensagem do stream               |

```yaml
- name: Chat
  grpc:
    proto: ./protos/demo.proto
    service: demo.Greeter
    method: Chat # bidi
    deadline: 10s # prazo do stream inteiro (padrão nos streams: nenhum)
    script:
      - send: { name: Ana } # mensagem JSON com templates
      - expect: { jsonPath: { "$.message": "Olá, Ana!" }, timeout: 1s } # PRÓXIMA mensagem
        extract: { sessao: "$.metadata.x-sessao" } # vale para as ações seguintes
      - send: { name: "${sessao}" }
      - expect: { bodyMatches: "^Olá" }
      - end: true # encerra o envio (implícito no fim do script)
  expect:
    grpcStatus: OK # status final
    messages: ">= 2" # quantas mensagens chegaram
```

Depois do script, o envio é encerrado e o resto do stream é lido até o status final. Cada espera
(`expect` ou o fim do stream) tem timeout (`expect.timeout` ou `target.timeoutMs` sem nenhuma
mensagem nova), então streams longos e contínuos não estouram. A latência da etapa é o stream
inteiro; `summary.grpcStreams` traz streams, mensagens enviadas/recebidas, tempo até a **1ª mensagem**
e **RTT por mensagem** (do envio até o `expect` seguinte). Falhas: status no meio do stream
(`grpc_status`), mensagem que não chegou (`timeout`), stream que terminou antes de um `expect`
(`check_failed`, "o stream terminou antes") e `grpc.deadline` estourado (`timeout`). Exemplo com os
três tipos: [examples/grpc-streaming.yaml](examples/grpc-streaming.yaml).

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

## Modelos de carga, perfis e workers

### Modelo aberto × fechado

|                    | `model: open` (padrão)                                  | `model: closed`                                          |
| ------------------ | ------------------------------------------------------- | -------------------------------------------------------- |
| O que você define  | taxa de chegada: `rps: 50 -> 300`                       | usuários virtuais: `vus: 10 -> 50` (+ `pacing` opcional) |
| Alvo lento         | requisições continuam chegando no horário; fila aparece | VUs esperam a resposta e **enviam menos**                |
| Latência sob carga | correta (mede desde o instante previsto)                | subestimada sem `pacing` (omissão coordenada)            |
| Bom para           | APIs, SLOs, capacidade, comparações                     | sessões de usuário, limites de concorrência              |

**Use o modelo aberto para endpoints.** No modelo fechado, cada VU repete o fluxo em laço (com `think`).
Com `pacing: 1s`, cada VU inicia uma iteração a cada 1 s; se o alvo atrasar, a próxima iteração conta a
latência desde o horário em que **deveria** ter começado. Validado: VUs com `pacing: 50ms` contra
`/slow?ms=150` têm tempo de serviço ≈ 150 ms, mas latência p99 > 1 s, que é o atraso acumulado que
um usuário real sentiria. Sem `pacing`, o relatório avisa que a latência pode estar subestimada.

No fechado, o teto `LT_MAX_RPS` é **aplicado ativamente** (limitador GCRA com tolerância de rajada de
100 ms): VUs rápidos contra um alvo rápido não passam do teto, e o relatório avisa quando isso
aconteceu. O número máximo de VUs é limitado por `LT_MAX_VUS` (padrão 1000; `--max-vus`).

### Perfis prontos

```bash
npx lt init cenarios/stress.yaml --profile stress --target http://127.0.0.1:4100 --path /fast
```

| Perfil   | Forma                                                         | Thresholds sugeridos           |
| -------- | ------------------------------------------------------------- | ------------------------------ |
| `smoke`  | 2 rps por 30 s                                                | p95 < 500ms, sem erros         |
| `load`   | rampa 1 min → platô de 5 min na carga nominal → descida       | p95 < 300ms, p99 < 800ms, < 1% |
| `stress` | degraus 50 → 200 → 400 → 800 → 1600 rps com `stopWhen`        | p95 < 1s, < 5%                 |
| `spike`  | base 20 rps → pico de 400 rps em 10 s → recuperação           | p95 < 1s, < 5%                 |
| `soak`   | 50 rps por 1 h (acompanhe memória/latência ao longo do tempo) | p95 < 300ms, p99 < 1s, < 0,5%  |

Exemplos gerados em [examples/perfis/](examples/perfis/).

### Parar no ponto de ruptura (`stopWhen`)

```yaml
load:
  stopWhen: ["errorRate > 5%", "p95 > 2s"]
```

As condições usam a sintaxe dos thresholds e são avaliadas a cada segundo sobre a janela dos últimos 3 s
(depois do aquecimento e com pelo menos 10 requisições). Quando uma vale, o teste para de forma graciosa
e o relatório registra `run.stopReason` e `run.breakingPoint` (segundo, carga pedida e vazão obtida). O
status continua `completed`: parar na ruptura é o objetivo do teste de stress.

### Workers (vários núcleos)

`load.workers: auto` (padrão) ou `--workers N`. Com mais de um, cada worker é uma `worker_thread` com
seu próprio pool de conexões e agendador. No aberto, o worker _w_ atende as chegadas _k_ com
_k_ mod _N_ = _w_; no fechado, divide os VUs. O índice global da iteração é a semente dos dados, então
**o resultado não depende de quantos workers há**. Um teste automatizado compara 1 e 3 workers e exige
contagens de falhas idênticas. A coordenação mescla histogramas por segundo; a subida das threads
(~0,1 s cada, em paralelo) não entra na janela medida.

`auto` usa 1 worker a cada 1.500 rps pedidos (ou 250 VUs), até núcleos − 1. Calibração nesta máquina,
com alvo e gerador juntos:

| `/fast`  | 1 worker                                                           | 4 workers                       |
| -------- | ------------------------------------------------------------------ | ------------------------------- |
| 3000 rps | **inválido** (atraso de agendamento p99 19 ms)                     | válido: p50 0,46 ms, p99 5,6 ms |
| 5000 rps | limite do **alvo** (demo-target usa um único núcleo, ~4,7 mil rps) | idem                            |

### HTTP/2 e TLS

`target.http2: true` usa HTTP/2 por ALPN em `https://` e h2c (conhecimento prévio) em `http://`. O
demo-target também escuta h2c em `LT_DEMO_PORT + 1` (4101). Certificados são **sempre** verificados;
para uma CA própria use `target.tls.ca: ./minha-ca.pem`. O protocolo negociado aparece em
`summary.connections.byProtocol`.

## Benchmarking e comparação

### `lt bench`: N rodadas do mesmo cenário

```bash
npx lt bench cenarios/api.yaml --runs 7 --interval 10s
```

Roda o cenário N vezes (mínimo 5), com pausa entre rodadas, e resume cada métrica com **mediana**,
**IC 95% da mediana** (bootstrap), mínimo, máximo e **CV entre rodadas**. O CV é a variabilidade do
ambiente: diferenças menores que ela dificilmente serão detectáveis, e o relatório avisa quando o CV do
p95 passa de 10%. Rodadas inválidas (gerador saturado) ou interrompidas são excluídas da estatística e
listadas. Todas as rodadas usam a mesma semente, ou seja, os mesmos dados. Cada rodada gera seu
`report.json`, e o resumo fica em `reports/<id>/bench.json`.

### A/B: duas versões ou configurações

```bash
npx lt bench cenarios/api.yaml --ab-target http://127.0.0.1:8081 --runs 7   # mesmo cenário, outra URL
npx lt bench cenarios/v1.yaml --ab cenarios/v2.yaml --runs 7 --fail-on-regression
```

As rodadas são **alternadas em pares contrabalançados** (A B, B A, A B…) para que aquecimento de cache,
JIT e deriva da máquina não favoreçam um lado. Os dois grupos recebem a mesma semente (mesmos dados).

### `lt compare`: diferença real ou ruído?

```bash
npx lt compare reports/<id-A> reports/<id-B>           # duas execuções (ou dois bench.json)
npx lt compare reports/<bench-ab>                      # o A × B de um benchmark
npx lt compare A B --alpha 0.05 --min-effect 5% --json --fail-on-regression
```

Exemplo real (A/B com 5 ms a mais em B, 5 rodadas cada):

```text
  métrica                  A          B           Δ       Δ%  IC95% (B−A)            p (Holm)  veredito
  latência p50 ms      21.20      26.08       +4.88   +23.0%  [+4.16, +5.94]            0.040  PIOR
  latência p95 ms      22.57      26.98       +4.40   +19.5%  [+1.57, +8.37]            0.040  PIOR
  latência p99 ms      23.74      27.87       +4.13   +17.4%  [-2.02, +9.38]            0.167  sem diferença
  vazão req/s          50.00      50.00        0.00     0.0%  [0.00, 0.00]              1.000  sem diferença
  taxa de erro         0.00%      0.00%     0.00 pp        —  [0.00 pp, 0.00 pp]        1.000  sem diferença
  Conclusão: REGRESSÃO em B: latência p50, latência p95
```

Como a decisão é tomada (e por quê):

- **Unidade de análise.** Requisições de uma mesma execução **não são independentes**: uma execução
  lenta deixa milhares de requisições lentas ao mesmo tempo. Testar requisição contra requisição
  declararia "significativa" qualquer flutuação. Por isso:
  - **benchmarks:** cada **rodada** é uma amostra;
  - **execuções únicas:** a amostra é um **bloco de 5 s** da linha do tempo (`--block`). Sem rodadas
    repetidas, a variação entre execuções é desconhecida, e o resultado avisa isso.
- **Teste:** Mann-Whitney U, não paramétrico, porque latências não seguem distribuição normal. É
  **exato** (enumeração das permutações dos postos, com empates) quando viável e usa aproximação normal
  com correção de empates nos demais casos. A **taxa de erro** de execuções únicas usa o teste z de duas
  proporções.
- **Tamanho do efeito:** deslocamento de Hodges-Lehmann e **IC 95% da diferença** por bootstrap, com
  semente fixa (reprodutível).
- **Várias métricas:** p50, p95, p99, vazão e erros são corrigidos por **Holm**, para que "alguma
  métrica mudou" não apareça por acaso.
- **Veredito:**
  - **PIOR** ou **MELHOR**: p ajustado < α **e** efeito ≥ `--min-effect` (5%; para latência, também ≥ 1 ms;
    para erros, ≥ 0,5 ponto percentual);
  - **diferença pequena**: significativa, mas abaixo do efeito mínimo;
  - **sem diferença detectável**: sem evidência. O lt diz isso explicitamente em vez de chamar ruído
    de melhora.
- **Poder estatístico:** com 5 × 5 rodadas, o menor p exato possível é 2/252 e, após Holm, ~0,04. Ou
  seja, só uma separação completa entre os grupos é detectável, e o resultado avisa isso. Com α menor
  que esse piso, o resultado diz que nenhuma diferença pode ser declarada. **Use 7–10 rodadas** para
  diferenças sutis.

Validação: um teste A/A (o mesmo alvo dos dois lados) precisa dar "sem diferença" e um A/B com +15 ms
precisa dar PIOR, com o IC contendo o valor real. Os dois rodam na suíte automatizada contra o demo-target.

### Baseline e regressão no CI

```bash
npx lt run cenarios/api.yaml --save-baseline                # salva se a execução passou
npx lt baseline set reports/<id>                            # ou marca qualquer execução / bench.json
npx lt run cenarios/api.yaml --baseline --regression-threshold 10%   # regressão → exit 1
npx lt baseline list | show <cenário> | clear <cenário>
```

Há uma baseline por cenário (pelo nome), em `data/baselines/`.

- **Baseline de uma execução:** usa a comparação por blocos descrita acima. Há regressão quando a piora
  é significativa **e** maior que o limite.
- **Baseline de um `bench.json`:** a execução atual regride quando fica pior que a mediana das rodadas
  além do limite **e** fora da faixa observada (mínimo/máximo).

Execuções inválidas ou interrompidas não viram baseline.

## Como as métricas são medidas

**Chegadas no modelo aberto.** As chegadas seguem um cronograma determinístico calculado a partir da taxa
pedida. Isso vale inclusive em rampas: a k-ésima chegada ocorre quando a integral da taxa atinge k + ½.
Novas requisições saem no horário, **independentemente** de as anteriores terem respondido.

**Omissão coordenada.** A latência é medida a partir do instante em que a requisição **deveria** ter
sido enviada (modelo aberto, ou fechado com `pacing`), não de quando foi enviada. Se o pool de conexões
estiver saturado ou o alvo engasgar, a espera entra na latência, como o usuário sentiria. O relatório
traz também, separadamente:

- **tempo de serviço**: envio real → fim da resposta;
- **TTFB**: envio → headers. Inclui a espera por conexão livre e, quando há, a conexão nova;
- **download**: headers → fim do corpo;
- **DNS, TCP e TLS**: medidos **por conexão nova**, com um connector do undici instrumentado. Com
  keep-alive, poucas requisições abrem conexão, então atribuí-los a cada requisição distorceria as
  médias.

**Precisão do agendador.** No Windows, `setTimeout` tem granularidade de ~15,6 ms (medido: `setTimeout(1)`
dispara ~15 ms depois), o que viraria latência fantasma. O agendador dorme até ~17 ms antes do prazo
(2 ms em Linux/macOS) e faz a aproximação final com `setImmediate`, com precisão de microssegundos. O custo
é até ~1 núcleo de CPU por worker durante o teste.

**Histogramas.** Latências vão para HdrHistogram (µs, 3 dígitos significativos → erro ≤ 0,1%). Nunca são
médias de médias: histogramas de workers e segundos são somados. O relatório inclui o histograma
codificado para comparações.

**Saturação do gerador.** O relatório é marcado `invalid` e o CLI sai com código 3 quando:

- o **atraso de agendamento** p99 passa de 10 ms (modelo aberto): as requisições não saíram no horário;
- o **atraso do event loop** p99 passa de 20 ms (qualquer modelo). Ele é medido com `setImmediate` a cada
  100 ms em cada worker, o que não depende da granularidade de timers do Windows.

O motor faz espera ativa, então a CPU do próprio processo não indica saturação. Por isso a decisão usa os
atrasos. A CPU e a memória da **máquina** são coletadas por segundo (`timeline[].cpu`/`memPct`,
`machine`). Acima de 90% de CPU média, o relatório avisa que gerador e alvo podem estar disputando a
máquina. `--no-system-metrics` desliga a coleta.

### Validação da própria ferramenta (Windows 11, Node 26.7, alvo local)

| Experimento                           | Esperado           | Medido                                          |
| ------------------------------------- | ------------------ | ----------------------------------------------- |
| `/slow?ms=100` a 100 rps, 20 s        | p50 ≈ p99 ≈ 100 ms | p50 100,80 · p99 101,69 · máx 105,43 ms         |
| taxa a 100 / 200 / 1000 rps           | ±2% da pedida      | 100,00 / 200,00 / 1000,00 (0,00%)               |
| `/flaky?rate=0.05`, 3 × 16 000 req    | ≈ 5% (σ ≈ 0,17%)   | 4,71% · 4,94% · 4,96%                           |
| `/flaky?every=20` (determinístico)    | exatamente 5%      | 5% (950 × 200, 50 × 500) — teste automatizado   |
| kill switch (Ctrl+C / `npm run stop`) | poucos segundos    | 0,4 s, parcial salvo, exit 130                  |
| `/slow?ms=100` com 4 workers          | igual a 1 worker   | p50 101,18 · p99 102,85 ms, taxa exata          |
| 1 × 3 workers, mesma semente          | dados idênticos    | mesmas contagens de falhas (teste automatizado) |
| fechado, 20 VUs, ciclo de 100 ms      | ≈ 200 req/s        | 196–200 req/s no platô; rampa 5→20→1 VUs        |
| fechado com `--max-rps 300`           | ≤ teto             | 309,5 req/s (rajada inicial tolerada) + aviso   |

## Relatórios

Cada execução grava uma pasta `reports/<AAAAMMDD-HHMMSS>-<cenário>/`, ou a pasta exata de
`--report-dir`, com:

- **`report.html`**: relatório autocontido, que abre offline e não depende de rede. Traz status,
  indicadores, thresholds e comparação com a baseline. Os gráficos por segundo têm crosshair e
  tooltip (também por teclado): latência p50/p95/p99, vazão pedida × enviada, erros, concorrência e
  CPU. Inclui ainda a distribuição (percentis em escala de "noves" e histograma), as etapas, as falhas
  mais comuns, as fases da requisição e a tabela por segundo. Tema claro/escuro.
- **`report.json`**: formato estável (`schemaVersion: 1`, só mudanças aditivas), documentado campo a
  campo em [docs/relatorios.md](docs/relatorios.md).
- **`timeline.csv`** e **`steps.csv`**, **`summary.md`** (para colar em PR), **`junit.xml`**
  (thresholds, validade e regressões como testes) e, com `--format all`, **`metrics.prom`** (texto do
  Prometheus).

```bash
npx lt run cenarios/api.yaml --format html,md          # escolhe os formatos (padrão: json,html,csv,md,junit)
npx lt run cenarios/api.yaml --report-dir reports/ci/api   # pasta fixa (CI)
npx lt run cenarios/api.yaml --metrics-port 9464       # Prometheus ao vivo em 127.0.0.1:9464/metrics
npx lt report reports/<id> --format all                # regenera a partir do report.json/bench.json
```

`lt bench` gera `bench.html` (resumo, comparação A × B, p95 por rodada na ordem de execução e links
para o relatório de cada rodada), `bench.csv` e `summary.md`.

## CI (GitHub Actions)

[examples/ci.yml](examples/ci.yml) é um workflow completo:

1. setup;
2. sobe o alvo;
3. smoke e carga com thresholds;
4. baseline versionada opcional (`--baseline-file`);
5. resumo em Markdown na página do job (`$GITHUB_STEP_SUMMARY`);
6. relatórios como artefato e JUnit opcional.

O job falha pelos exit codes: `1` threshold ou regressão, `2` configuração, `3` gerador saturado.

```bash
npx lt run cenario.yaml --report-dir reports/ci/x --quiet --baseline-file ci/baselines/x.json
cat reports/ci/x/summary.md >> "$GITHUB_STEP_SUMMARY"
```

Baselines só são comparáveis na **mesma máquina/ambiente**. Gere a baseline versionada no próprio
runner (ou numa máquina equivalente) e, se possível, a partir de `lt bench`.

## Dashboard e API

`npm start` sobe a API e o dashboard em **http://127.0.0.1:4000** (`npm start -- --open` abre o
navegador). Na primeira vez, os cenários de `examples/` são importados.

| Tela              | O que faz                                                                                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cenários**      | Lista e editor YAML (CodeMirror) com **validação em tempo real**: erros marcados no texto com linha/coluna, clique para ir à linha, prévia das 3 primeiras requisições montadas. Salvar, excluir e **Executar**.                            |
| **Ao vivo**       | Gráficos por segundo (vazão pedida × enviada, latência p50/p95/p99, erros, VUs/concorrência), indicadores, progresso por etapa com ETA, log resumido e o botão **Parar** (kill switch: drena e salva o parcial em menos de 1 s nos testes). |
| **Resultados**    | Histórico do dashboard **e do CLI** (importado de `reports/`), filtros por cenário/estado/texto, relatório completo, marcar **baseline** (a mesma usada por `lt run --baseline`) e seleção de duas execuções para comparar.                 |
| **Comparar**      | Escolha A e B, α e efeito mínimo; tabela com Δ%, IC 95%, p ajustado e veredito (pior/melhor/diferença pequena/sem diferença).                                                                                                               |
| **Configurações** | Estado do servidor, tempo real, limites de segurança, alvos permitidos, armazenamento e tema (sistema/claro/escuro).                                                                                                                        |

Executar pelo dashboard segue as mesmas regras do CLI:

- uma execução por vez (duas cargas simultâneas invalidariam as duas medições);
- tetos de RPS, VUs, conexões e duração;
- para alvos **fora da allowlist**, o diálogo exige declarar a autorização **e digitar o host**.

Interface: responsiva (testada em 375 px sem rolagem horizontal), tema claro/escuro com paleta
validada para daltonismo, navegação por teclado, estados de carregamento/erro e status sempre com ícone e
texto (nunca só cor).

### API (REST + SSE)

| Método e rota                                                                                    | Descrição                                                                                         |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `GET /api/health` · `GET /api/status`                                                            | identificação; versão, limites, allowlist, execuções ativas, armazenamento                        |
| `GET /api/scenarios` · `GET /api/scenarios/:id`                                                  | lista / um cenário (com o YAML)                                                                   |
| `POST /api/scenarios` `{yaml}` · `PUT /api/scenarios/:id` `{yaml}` · `DELETE /api/scenarios/:id` | cria (201), atualiza, exclui (204)                                                                |
| `POST /api/scenarios/validate` `{yaml, preview?}`                                                | `{valid, issues[{path,message,line,col}], summary, preview}`                                      |
| `POST /api/runs` `{scenarioId \| yaml, workers?, iOwnThisTarget?, confirmTarget?}`               | inicia (202); 409 se já houver execução; 403 `target_confirmation_required`; 422 cenário inválido |
| `POST /api/runs/:id/stop`                                                                        | kill switch (202)                                                                                 |
| `GET /api/runs?scenario=&status=&q=&limit=&offset=`                                              | histórico paginado                                                                                |
| `GET /api/runs/:id`                                                                              | execução + relatório (ou, se ativa, histórico por segundo e logs)                                 |
| `GET /api/runs/:id/report?format=html\|json\|md\|csv\|junit`                                     | arquivos do relatório                                                                             |
| `POST /api/runs/:id/baseline` · `GET /api/baselines` · `DELETE /api/baselines/:cenario`          | baselines por cenário                                                                             |
| `POST /api/compare` `{a, b, alpha?, minEffectPct?, blockSeconds?}`                               | comparação estatística                                                                            |
| `GET /api/events`                                                                                | **SSE**: `hello`, `run-started`, `progress` (1/s), `log`, `run-finished`, `scenarios-changed`     |
| `GET /metrics`                                                                                   | Prometheus: execuções por status, ativas e as métricas ao vivo da execução em andamento           |

SSE em vez de WebSocket: o tráfego é só servidor → navegador, a reconexão é automática e funciona
através de qualquer proxy HTTP.

Entradas validadas por JSON Schema: campos desconhecidos dão 400, e não são ignorados em silêncio. As
proteções:

- o servidor escuta **só em 127.0.0.1**;
- o `Host` precisa ser de loopback (defesa contra DNS rebinding, 421);
- CORS restrito a origens localhost;
- requisições que alteram estado vindas de outra origem recebem 403 (CSRF);
- o encerramento pelo `npm run stop` usa um token aleatório.

**Armazenamento:**

- `data/lt.db` (SQLite via `node:sqlite`, sem compilação nativa) guarda cenários e o índice de execuções;
- os relatórios completos ficam em `reports/<id>/`;
- as baselines ficam em `data/baselines/`, compartilhadas com o CLI.

Ao parar o servidor com execuções em andamento, elas são interrompidas e salvas como `interrupted`. Se o
processo morrer de forma abrupta, as execuções que ficaram "em andamento" viram `failed` na próxima
inicialização.

### Desenvolvimento do dashboard

```bash
npm start -- --dev        # API com hot reload (tsx watch), em primeiro plano
npm run dev:web           # Vite em http://127.0.0.1:5173 com proxy para a API
```

## Alvo de demonstração

`npm start -- --with-demo` sobe em `http://127.0.0.1:4100`:
`/fast`, `/slow?ms=100&jitter=10`, `/flaky?rate=0.05&status=500`, `/flaky?every=20`, `/echo`,
`/status/:code`, `/bytes?n=1024`, `/products?page=1`, `/products/:id`, `/health`. As mesmas rotas
em HTTP/2 sem TLS (h2c) em `http://127.0.0.1:4101` (`LT_DEMO_H2_PORT`; se a porta estiver ocupada,
só o h2c fica indisponível).

- **WebSocket**: `ws://127.0.0.1:4100/ws/echo?delay=0&welcome=0` — devolve cada mensagem; JSON vira
  `{"echo": <mensagem>, "n": <nº>}` e quadros binários voltam binários; `welcome=1` envia
  `{"type":"welcome","session":"<uuid>"}` ao conectar e `welcome=binary`, um quadro binário de 16 bytes
  (`LT01` + 12 aleatórios).
- **gRPC** (sem TLS): `127.0.0.1:4102` (`LT_DEMO_GRPC_PORT`), serviço `demo.Greeter` em
  [packages/demo-target/proto/demo.proto](packages/demo-target/proto/demo.proto): `SayHello`,
  `Slow { ms }`, `Flaky { every | rate, code }` e os streams `Countdown { from, interval_ms, fail_at }`
  (server), `Sum` (client, soma `{ value }`) e `Chat` (bidi, responde a cada `{ name, delay_ms }`).

## Desenvolvimento

```bash
npm run build       # tsc -b (pacotes) + Vite (dashboard em packages/web/dist)
npm test            # build + Vitest (unidade, parser, percentis, taxa ±2%, erros, kill switch, API)
npm run lint        # ESLint
npm run format      # Prettier
```

Estrutura: `packages/core` (motor, métricas, cenários, relatórios), `packages/cli` (`lt`), `packages/server`
(API, SQLite, SSE), `packages/web` (dashboard React + Vite),
`packages/demo-target`, `scripts/` (operação), `examples/`, `tests/`.

O workflow [.github/workflows/ci.yml](.github/workflows/ci.yml) roda em cada push na `main` e em pull
requests: ESLint + Prettier e a suíte completa em Linux e Windows, com Node 22 (mínimo suportado) e 24.
O resultado dos testes (JUnit) fica como artefato do job. Para validar um serviço com carga no CI, veja
[examples/ci.yml](examples/ci.yml) (seção "CI (GitHub Actions)").

## Solução de problemas

- **"porta 4000 já está em uso pelo PID X"** — outro programa usa a porta; altere `LT_PORT` no `.env`.
  O lt nunca encerra processos que não iniciou.
- **"alvo ... fora da allowlist"** — adicione o host/faixa em `ALLOWED_TARGETS` ou, se o sistema é seu,
  use `--i-own-this-target` (e `--confirm-target <host>` em CI).
- **"resultado inválido: o gerador não conseguiu sustentar a taxa"** ou **"o gerador está saturado"**
  (exit 3): aumente `--workers`, reduza a taxa, feche programas pesados ou rode o gerador em outra
  máquina. Se `machine.cpuAvg` estiver alto, alvo e gerador estão disputando a CPU.
- **Descartes (`dropped`) com latência subindo**: geralmente é o **alvo** que não acompanha; veja
  `timeline[].concurrency` crescendo. Aumente `load.maxInFlight` só se tiver certeza de que o alvo aguenta.
- **Erro de certificado**: o lt sempre verifica TLS. Para CA própria use `target.tls.ca`.
- **npm 12 avisa "install scripts blocked" (esbuild)** — inofensivo: o binário do esbuild vem como
  dependência opcional; `tsx` e `vitest` funcionam sem o postinstall.
- **Serviço não sobe** — o `start` mostra o fim de `logs/<serviço>.log`; veja o arquivo completo.

## Roadmap

- [x] **Fase 0** — scripts, demo-target, `lt run` (modelo aberto), relatório JSON, validação.
- [x] **Fase 1** — JSON Schema, templates (`randInt`, `uuid`, `pick`), CSV, extração/encadeamento,
      pesos, `lt init`, import cURL/OpenAPI.
- [x] **Fase 2** — `worker_threads`, modelo fechado, perfis (smoke/load/stress/spike/soak), tempos de
      DNS/conexão/TLS/TTFB, HTTP/2, detecção ampliada de saturação, CPU/memória.
- [x] **Fase 3** — `lt bench`, A/B, `lt compare` com significância estatística, baseline.
- [x] **Fase 4** — relatórios HTML/CSV/Markdown, JUnit, Prometheus, exemplo de GitHub Actions.
- [x] **Fase 5** — API completa, SQLite, tempo real (SSE/WebSocket), dashboard React.
- [x] **Extras** — WebSocket e gRPC (unário) como alvo.
- [x] gRPC com streaming (server, client e bidi).
- [x] Mensagens WebSocket binárias no roteiro (`sendBinary`, `type`/`size`/`hex`, `extract bytes`).
