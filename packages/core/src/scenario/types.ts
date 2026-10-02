import type { RateStage } from "../schedule.js";

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface RequestSpec {
  method: HttpMethod;
  path: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  /** Corpo já serializado e o content-type correspondente. */
  body?: string;
  contentType?: string;
}

export interface ExpectSpec {
  /** Status aceitos; se ausente, qualquer status < 400 é sucesso. */
  status?: number[];
  /** Tempo máximo de resposta; acima disso conta como falha de checagem. */
  maxDurationMs?: number;
}

export interface Step {
  name: string;
  request: RequestSpec;
  expect: ExpectSpec;
  thinkMs: number;
}

export interface Scenario {
  name: string;
  description?: string;
  target: {
    baseUrl: string;
    headers: Record<string, string>;
    timeoutMs: number;
  };
  load: {
    model: "open";
    stages: RateStage[];
    /** Início descartado das estatísticas (aquecimento). */
    warmupMs: number;
    /** Máximo de iterações simultâneas; acima disso a chegada é descartada (dropped). */
    maxInFlight?: number;
    /** Tamanho do pool de conexões por origem. */
    connections?: number;
  };
  thresholds: string[];
  flow: Step[];
  seed: number;
  /** Valores vindos de ${env.X}: tratados como segredos e mascarados nas saídas. */
  secrets: string[];
  sourceFile?: string;
}
