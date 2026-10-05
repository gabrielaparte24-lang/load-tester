import { performance } from "node:perf_hooks";
import type { Socket } from "node:net";
import { buildConnector } from "undici";

export interface ConnectionTiming {
  /** Resolução de nome (0 quando o host já é um IP). */
  dnsMs: number;
  /** Handshake TCP. */
  connectMs: number;
  /** Handshake TLS (0 em http://). */
  tlsMs: number;
  /** "h2", "http/1.1" ou "http/1.1" implícito em texto puro. */
  protocol: string;
}

export interface ConnectorOptions {
  timeoutMs: number;
  http2: boolean;
  ca?: string;
}

/**
 * Connector do undici instrumentado. DNS, TCP e TLS só existem quando uma conexão nova é aberta
 * (com keep-alive, a maioria das requisições reutiliza conexões), por isso esses tempos são
 * medidos POR CONEXÃO; TTFB e download são medidos por requisição no motor.
 */
export function instrumentedConnector(
  opts: ConnectorOptions,
  onConnection: (t: ConnectionTiming) => void,
): buildConnector.connector {
  const base = buildConnector({
    timeout: opts.timeoutMs,
    allowH2: opts.http2,
    preferH2: opts.http2,
    useH2c: opts.http2,
    ...(opts.ca ? { ca: opts.ca } : {}),
  } as buildConnector.BuildOptions);

  return (connectOpts, callback) => {
    const t0 = performance.now();
    let tLookup = 0;
    let tConnect = 0;
    const https = connectOpts.protocol === "https:";
    const socket = base(connectOpts, (err, sock) => {
      if (!err && sock) {
        const end = performance.now();
        const connected = tConnect || end;
        const looked = tLookup || t0;
        onConnection({
          dnsMs: looked - t0,
          connectMs: connected - looked,
          tlsMs: https ? end - connected : 0,
          protocol: (sock as Socket & { alpnProtocol?: string | false }).alpnProtocol || "http/1.1",
        });
      }
      callback(err as Error, sock as never);
    }) as unknown as Socket | undefined;
    socket?.once("lookup", () => (tLookup = performance.now()));
    socket?.once("connect", () => (tConnect = performance.now()));
    return socket as never;
  };
}
