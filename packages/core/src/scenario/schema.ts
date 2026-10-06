import { HTTP_METHODS } from "./types.js";

/**
 * JSON Schema (draft-07) do cenário. Valida a ESTRUTURA; regras semânticas (templates,
 * variáveis definidas, arquivos existentes, thresholds) ficam em load.ts.
 * `x-erro` é a mensagem amigável usada quando um `pattern` falha.
 * Publicado em schema/scenario.schema.json (`lt schema`) para autocompletar no editor.
 */
const DURATION_RE = "^\\s*(\\d+(\\.\\d+)?\\s*(ms|s|m|h)\\s*)+$";

const duration = {
  type: "string",
  pattern: DURATION_RE,
  "x-erro": 'duração inválida: use ms, s, m ou h (ex.: "500ms", "30s", "1m30s")',
};
const scalar = { type: ["string", "number", "boolean"] };
const varName = {
  pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
  "x-erro": "nome inválido: use letras, números e _ (começando por letra ou _)",
};
const templMap = { type: "object", additionalProperties: scalar };
const matcher = {
  type: ["string", "number", "boolean", "null"],
  description: '200, true, "texto", ">0", ">= 5", "== ok", "!= x", "~regex", "exists", "!exists"',
};

const request = {
  type: "object",
  additionalProperties: false,
  required: ["path"],
  properties: {
    method: {
      type: "string",
      enum: [...HTTP_METHODS, ...HTTP_METHODS.map((m) => m.toLowerCase())],
    },
    path: {
      type: "string",
      pattern: "^/",
      "x-erro": 'deve começar com "/" (relativo a target.baseUrl)',
      description: "Caminho com templates, ex.: /products/${productId}",
    },
    headers: templMap,
    query: {
      type: "object",
      additionalProperties: { type: ["string", "number", "boolean", "array"], items: scalar },
    },
    json: {
      description: "Corpo JSON (strings aceitam templates; ${expr} sozinho preserva o tipo)",
    },
    body: { type: "string", description: "Corpo de texto com templates" },
    form: { ...templMap, description: "application/x-www-form-urlencoded" },
    file: { type: "string", description: "Corpo bruto lido de um arquivo (relativo ao cenário)" },
    multipart: {
      type: "object",
      description:
        'multipart/form-data: campo: "texto" ou campo: { file: ./a.png, contentType?, filename? }',
      additionalProperties: {
        type: ["string", "number", "boolean", "object"],
        additionalProperties: false,
        required: ["file"],
        properties: {
          file: { type: "string" },
          contentType: { type: "string" },
          filename: { type: "string" },
        },
      },
    },
    contentType: { type: "string" },
  },
};

const jsonPathChecks = {
  type: "object",
  additionalProperties: matcher,
  propertyNames: { pattern: "^\\$", "x-erro": 'JSONPath deve começar com "$"' },
};

const extractSchema = {
  type: "object",
  propertyNames: varName,
  additionalProperties: {
    type: ["string", "object"],
    pattern: "^\\$",
    "x-erro": 'use um JSONPath ("$.id") ou { jsonPath | regex | header }',
    additionalProperties: false,
    properties: {
      jsonPath: { type: "string", pattern: "^\\$", "x-erro": 'JSONPath deve começar com "$"' },
      regex: { type: "string" },
      group: { type: "integer", minimum: 0 },
      header: { type: "string" },
      default: {},
    },
  },
};

const GRPC_CODES = [
  "OK",
  "CANCELLED",
  "UNKNOWN",
  "INVALID_ARGUMENT",
  "DEADLINE_EXCEEDED",
  "NOT_FOUND",
  "ALREADY_EXISTS",
  "PERMISSION_DENIED",
  "RESOURCE_EXHAUSTED",
  "FAILED_PRECONDITION",
  "ABORTED",
  "OUT_OF_RANGE",
  "UNIMPLEMENTED",
  "INTERNAL",
  "UNAVAILABLE",
  "DATA_LOSS",
  "UNAUTHENTICATED",
];
export { GRPC_CODES };
const grpcCode = {
  anyOf: [
    { type: "integer", minimum: 0, maximum: 16 },
    { type: "string", enum: GRPC_CODES },
  ],
};

const ws = {
  type: "object",
  additionalProperties: false,
  required: ["path"],
  description:
    "Etapa WebSocket: conecta em target.baseUrl (http→ws, https→wss) + path e roda o roteiro",
  properties: {
    path: {
      type: "string",
      pattern: "^/",
      "x-erro": 'deve começar com "/" (relativo a target.baseUrl)',
    },
    headers: templMap,
    subprotocols: { type: "array", items: { type: "string" } },
    script: {
      type: "array",
      description: "Ações em ordem: send | sendJson | expect (+ extract) | sleep",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          send: { ...scalar, description: "Mensagem de texto (templates)" },
          sendJson: { description: "Mensagem JSON (templates; ${expr} sozinho preserva o tipo)" },
          expect: {
            type: "object",
            additionalProperties: false,
            description: "Espera a PRÓXIMA mensagem e a checa",
            properties: {
              jsonPath: jsonPathChecks,
              bodyContains: { type: ["string", "array"], items: { type: "string" } },
              bodyMatches: { type: "string" },
              timeout: duration,
            },
          },
          extract: extractSchema,
          sleep: duration,
        },
      },
    },
  },
};

const grpc = {
  type: "object",
  additionalProperties: false,
  required: ["proto", "service", "method"],
  description: "Chamada gRPC unária para target.baseUrl (http = sem TLS, https = TLS)",
  properties: {
    proto: { type: "string", description: "Arquivo .proto (relativo ao cenário)" },
    service: { type: "string", description: "Serviço com pacote, ex.: demo.Greeter" },
    method: { type: "string" },
    message: { description: "Mensagem da requisição em JSON (templates)" },
    metadata: templMap,
  },
};

const step = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    request,
    ws,
    grpc,
    expect: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: {
          type: ["integer", "array"],
          minimum: 100,
          maximum: 599,
          minItems: 1,
          items: { type: "integer", minimum: 100, maximum: 599 },
        },
        grpcStatus: {
          description: 'gRPC: código(s) aceito(s), ex.: OK, "NOT_FOUND" ou [0, 5] (padrão: OK)',
          anyOf: [grpcCode, { type: "array", minItems: 1, items: grpcCode }],
        },
        maxDuration: duration,
        jsonPath: jsonPathChecks,
        headers: { type: "object", additionalProperties: matcher },
        bodyContains: { type: ["string", "array"], items: { type: "string" } },
        bodyMatches: { type: "string" },
      },
    },
    extract: extractSchema,
    think: {
      type: "string",
      pattern:
        "^\\s*(\\d+(\\.\\d+)?\\s*(ms|s|m|h)\\s*)+(\\.\\.\\s*(\\d+(\\.\\d+)?\\s*(ms|s|m|h)\\s*)+)?$",
      "x-erro": 'use uma duração ("500ms") ou um intervalo aleatório ("1s..3s")',
    },
  },
};

const dataset = {
  type: "object",
  additionalProperties: false,
  required: ["file"],
  properties: {
    file: { type: "string", description: "CSV com cabeçalho (relativo ao cenário)" },
    order: {
      type: "string",
      enum: ["sequential", "random"],
      description: "rodízio (padrão) ou aleatório",
    },
    name: {
      type: "string",
      ...varName,
      description: "com name, acesse ${name.coluna}; sem, ${coluna}",
    },
    delimiter: { type: "string", minLength: 1, maxLength: 1 },
  },
};

export const scenarioSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "urn:lt:scenario-schema:1",
  title: "Cenário do lt (load tester)",
  type: "object",
  additionalProperties: false,
  required: ["name", "target", "load"],
  properties: {
    $schema: { type: "string" },
    name: { type: "string", minLength: 1 },
    description: { type: "string" },
    seed: {
      type: "integer",
      minimum: 1,
      description: "Semente dos dados aleatórios (reprodutível)",
    },
    target: {
      type: "object",
      additionalProperties: false,
      required: ["baseUrl"],
      properties: {
        baseUrl: {
          type: "string",
          pattern: "^https?://",
          "x-erro": "URL inválida (use http:// ou https://)",
        },
        headers: templMap,
        timeoutMs: { type: "integer", minimum: 1 },
        timeout: duration,
        http2: {
          type: "boolean",
          description: "HTTP/2: via ALPN em https:// ou h2c (conhecimento prévio) em http://",
        },
        tls: {
          type: "object",
          additionalProperties: false,
          properties: {
            ca: {
              type: "string",
              description: "PEM de uma CA adicional a confiar (relativo ao cenário)",
            },
          },
        },
      },
    },
    load: {
      type: "object",
      additionalProperties: false,
      required: ["stages"],
      properties: {
        model: {
          type: "string",
          enum: ["open", "closed"],
          description:
            "open = taxa de chegada fixa (rps); closed = N usuários virtuais em laço (vus)",
        },
        warmup: duration,
        pacing: {
          ...duration,
          description:
            "modelo fechado: intervalo entre inícios de iteração de cada VU (corrige omissão coordenada)",
        },
        workers: {
          type: ["integer", "string"],
          minimum: 1,
          pattern: "^auto$",
          "x-erro": 'use um inteiro ≥ 1 ou "auto"',
        },
        stopWhen: {
          type: "array",
          items: { type: "string" },
          description:
            'para o teste quando a condição vale por 3 s seguidos, ex.: "errorRate > 5%", "p95 > 2s"',
        },
        maxInFlight: { type: "integer", minimum: 1 },
        connections: { type: "integer", minimum: 1 },
        stages: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["duration"],
            properties: {
              duration,
              rps: {
                type: ["number", "string"],
                minimum: 0,
                pattern: "^\\s*\\d+(\\.\\d+)?\\s*((->|→)\\s*\\d+(\\.\\d+)?\\s*)?$",
                "x-erro": 'deve ser um número ≥ 0 ou uma rampa "50 -> 300"',
              },
              vus: {
                type: ["integer", "string"],
                minimum: 0,
                pattern: "^\\s*\\d+\\s*((->|→)\\s*\\d+\\s*)?$",
                "x-erro": 'deve ser um inteiro ≥ 0 ou uma rampa "10 -> 50"',
              },
            },
          },
        },
      },
    },
    thresholds: { type: "array", items: { type: "string" } },
    variables: {
      type: "object",
      propertyNames: varName,
      additionalProperties: scalar,
      description: "Avaliadas no início de cada iteração, na ordem (podem usar funções e dados)",
    },
    data: { ...dataset, type: ["object", "array"], items: dataset },
    flow: { type: "array", minItems: 1, items: step },
    flows: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["steps"],
        properties: {
          name: { type: "string" },
          weight: { type: "number", exclusiveMinimum: 0 },
          steps: { type: "array", minItems: 1, items: step },
        },
      },
    },
  },
} as const;
