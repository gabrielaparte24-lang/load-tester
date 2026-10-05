import type { RateStage } from "../schedule.js";
import type { Segment } from "./jsonpath.js";
import type { Matcher } from "./matchers.js";
import type { JsonTemplate, Template } from "./template.js";

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export type BodySpec =
  | { kind: "text"; template: Template; contentType?: string }
  | { kind: "json"; value: JsonTemplate; contentType: string }
  | { kind: "form"; fields: [string, Template][]; contentType: string }
  | { kind: "file"; data: Buffer; contentType: string; source: string }
  | {
      kind: "multipart";
      parts: (
        | { name: string; value: Template }
        | { name: string; file: Buffer; filename: string; contentType: string }
      )[];
    };

export interface RequestSpec {
  method: HttpMethod;
  path: Template;
  headers: [string, Template][];
  query: [string, Template][];
  body?: BodySpec;
}

export interface ExpectSpec {
  /** Status aceitos; se ausente, qualquer status < 400 é sucesso. */
  status?: number[];
  maxDurationMs?: number;
  jsonPath: { path: string; segments: Segment[]; matcher: Matcher }[];
  headers: { name: string; matcher: Matcher }[];
  bodyContains: string[];
  bodyMatches?: RegExp;
}

export type Extractor =
  | { kind: "jsonPath"; path: string; segments: Segment[]; default?: unknown }
  | { kind: "regex"; re: RegExp; group: number; default?: unknown }
  | { kind: "header"; name: string; default?: unknown };

export interface Step {
  name: string;
  request: RequestSpec;
  expect: ExpectSpec;
  extract: [string, Extractor][];
  /** Tempo de pensamento após a etapa: fixo (min = max) ou uniforme em [min, max]. */
  think: { minMs: number; maxMs: number };
  /** A resposta precisa ser lida (checagens de corpo ou extração). */
  needsBody: boolean;
  /** Texto do método + caminho original (para relatórios). */
  label: string;
}

export interface Flow {
  name: string;
  weight: number;
  steps: Step[];
}

export interface Dataset {
  file: string;
  name?: string;
  order: "sequential" | "random";
  columns: string[];
  rows: Record<string, string>[];
}

export interface Scenario {
  name: string;
  description?: string;
  target: {
    baseUrl: string;
    headers: [string, Template][];
    timeoutMs: number;
    http2: boolean;
    /** CA adicional (PEM) para alvos com certificado próprio. */
    ca?: string;
  };
  load: {
    model: "open" | "closed";
    /** Modelo aberto: taxa de chegada por etapa. */
    stages: RateStage[];
    /** Modelo fechado: usuários virtuais por etapa. */
    vuStages: VuStage[];
    /** Modelo fechado: intervalo entre inícios de iteração de cada VU. */
    pacingMs?: number;
    workers: number | "auto";
    /** Condições (sintaxe de threshold) que encerram o teste quando valem por 3 s seguidos. */
    stopWhen: string[];
    /** Início descartado das estatísticas (aquecimento). */
    warmupMs: number;
    /** Máximo de iterações simultâneas; acima disso a chegada é descartada (dropped). */
    maxInFlight?: number;
    /** Tamanho do pool de conexões por origem. */
    connections?: number;
  };
  thresholds: string[];
  variables: [string, Template][];
  data: Dataset[];
  flows: Flow[];
  seed: number;
  /** Valores vindos de ${env.X}: tratados como segredos e mascarados nas saídas. */
  secrets: string[];
  sourceFile?: string;
  /** Texto original: workers reconstroem o cenário a partir dele (com a mesma semente). */
  source: { text: string; file?: string; baseDir: string };
}

export interface VuStage {
  durationMs: number;
  vusFrom: number;
  vusTo: number;
}
