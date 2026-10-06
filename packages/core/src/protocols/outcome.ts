import type { ErrorType } from "../metrics.js";

/** Resultado de uma etapa não HTTP (WebSocket, gRPC), no formato que o motor registra. */
export interface ProtocolOutcome {
  /** Rótulo de status para a contagem por status (ex.: "ws:101", "grpc:OK"). */
  statusKey?: string;
  error?: ErrorType;
  message?: string;
  checks: { label: string; ok: boolean }[];
  bytesIn: number;
  bytesOut: number;
  /** Instante (performance.now) dos headers da resposta (só HTTP: TTFB/download). */
  firstByteAt?: number;
  messagesSent?: number;
  messagesReceived?: number;
}
