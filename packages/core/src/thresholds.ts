import { ConfigError } from "./errors.js";

export type ThresholdOp = "<" | "<=" | ">" | ">=" | "==";

export interface Threshold {
  expression: string;
  /** "p95", "p99.9", "max", "min", "mean", "errorRate", "rps" */
  metric: string;
  op: ThresholdOp;
  /** Latência em ms; errorRate como fração 0..1; rps em req/s. */
  value: number;
}

export interface ThresholdResult extends Threshold {
  actual: number | null;
  passed: boolean;
}

const RE =
  /^\s*(p\d+(?:\.\d+)?|max|min|mean|avg|median|errorRate|error_rate|rps|throughput)\s*(<=|>=|<|>|==)\s*(\d+(?:\.\d+)?)\s*(ms|s|us|µs|%)?\s*$/i;

export function parseThreshold(expression: string): Threshold {
  const m = RE.exec(expression);
  if (!m) {
    throw new ConfigError(
      `threshold inválido "${expression}". Exemplos: "p95 < 300ms", "p99.9 <= 1s", "errorRate < 1%", "rps >= 100"`,
    );
  }
  let metric = m[1]!.toLowerCase();
  const op = m[2] as ThresholdOp;
  let value = Number(m[3]);
  const unit = m[4]?.toLowerCase();

  if (metric === "avg") metric = "mean";
  if (metric === "median") metric = "p50";
  if (metric === "error_rate" || metric === "errorrate") metric = "errorRate";
  if (metric === "throughput") metric = "rps";

  if (metric === "errorRate") {
    if (unit === "%") value /= 100;
    else if (unit)
      throw new ConfigError(`threshold "${expression}": errorRate usa % (ex.: errorRate < 1%)`);
    else if (value > 1)
      throw new ConfigError(`threshold "${expression}": use % ou fração entre 0 e 1`);
  } else if (metric === "rps") {
    if (unit) throw new ConfigError(`threshold "${expression}": rps não tem unidade`);
  } else {
    if (metric.startsWith("p")) {
      const p = Number(metric.slice(1));
      if (!(p > 0 && p <= 100))
        throw new ConfigError(`threshold "${expression}": percentil fora de (0, 100]`);
    }
    if (unit === "%") throw new ConfigError(`threshold "${expression}": latência usa ms, s ou us`);
    if (unit === "s") value *= 1000;
    else if (unit === "us" || unit === "µs") value /= 1000;
  }
  return { expression: expression.trim(), metric, op, value };
}

export function compare(actual: number, op: ThresholdOp, value: number): boolean {
  switch (op) {
    case "<":
      return actual < value;
    case "<=":
      return actual <= value;
    case ">":
      return actual > value;
    case ">=":
      return actual >= value;
    case "==":
      return actual === value;
  }
}

/** Avalia thresholds usando uma função que devolve o valor medido de cada métrica. */
export function evaluateThresholds(
  thresholds: Threshold[],
  valueOf: (metric: string) => number | null,
): ThresholdResult[] {
  return thresholds.map((t) => {
    const actual = valueOf(t.metric);
    return { ...t, actual, passed: actual !== null && compare(actual, t.op, t.value) };
  });
}
