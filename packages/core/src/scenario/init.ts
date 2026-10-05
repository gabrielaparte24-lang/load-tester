/** Cenário de exemplo gerado por `lt init`: roda direto contra o demo-target e mostra os recursos principais. */
export function initScenarioYaml(opts: {
  name: string;
  baseUrl: string;
  schemaPath: string;
}): string {
  return `# yaml-language-server: $schema=${opts.schemaPath}
# Cenário gerado por \`lt init\`. Valide com: npx lt validate <arquivo> --preview 3
# Execute com:  npx lt run <arquivo>   (demo: npm start -- --with-demo)
name: ${opts.name}
description: Exemplo com variáveis, encadeamento, checagens e pesos entre fluxos

target:
  baseUrl: ${opts.baseUrl}
  timeoutMs: 5000
  headers:
    X-Client: lt
    # Segredos vêm do ambiente/.env e são mascarados nas saídas:
    # Authorization: "Bearer \${env.API_TOKEN}"

# Semente fixa = mesmos dados aleatórios em todas as execuções (remova para variar)
seed: 42

load:
  model: open # taxa de chegada fixa (requisições saem no horário, como usuários reais)
  warmup: 5s # descartado das estatísticas
  stages:
    - { duration: 5s, rps: 10 }
    - { duration: 20s, rps: 10 -> 50 } # rampa
    - { duration: 30s, rps: 50 } # platô

thresholds:
  - "p95 < 300ms"
  - "p99 < 800ms"
  - "errorRate < 1%"

# Avaliadas no início de cada iteração (podem usar funções)
variables:
  page: "\${randInt(1, 20)}"
  requestId: "\${uuid()}"

# Dados de um CSV (colunas viram variáveis); order: sequential | random
# data:
#   file: ./usuarios.csv
#   order: sequential

flows:
  - name: navegar
    weight: 3 # 3 de cada 4 iterações
    steps:
      - name: listar produtos
        request:
          method: GET
          path: /products
          query: { page: "\${page}" }
          headers: { X-Request-Id: "\${requestId}" }
        expect:
          status: 200
          jsonPath: { "$.items.length": ">0" }
        extract:
          productId: "$.items[0].id"
        think: 200ms..1s # pausa aleatória entre etapas
      - name: detalhe
        request: { method: GET, path: "/products/\${productId}" }
        expect:
          status: 200
          maxDuration: 500ms
          jsonPath: { "$.id": "exists" }

  - name: enviar
    weight: 1
    steps:
      - name: echo
        request:
          method: POST
          path: /echo
          json:
            id: "\${randInt(1, 1000)}" # \${...} sozinho preserva o tipo (número)
            nome: "cliente-\${randString(6)}"
            quando: "\${isoNow()}"
        expect:
          status: 200
          headers: { content-type: "~json" }
          bodyContains: cliente-
`;
}
