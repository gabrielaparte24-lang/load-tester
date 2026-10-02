/** Exit codes estáveis do CLI (documentados no README). */
export const ExitCode = {
  OK: 0,
  THRESHOLDS_FAILED: 1,
  CONFIG_ERROR: 2,
  INVALID_RUN: 3,
  INTERRUPTED: 130,
} as const;

export class LtError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Erro de configuração/cenário/segurança — exit code 2. */
export class ConfigError extends LtError {
  constructor(message: string) {
    super(message, ExitCode.CONFIG_ERROR);
  }
}
