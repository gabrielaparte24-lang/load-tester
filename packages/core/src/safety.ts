import dns from "node:dns/promises";
import net from "node:net";
import { formatDuration } from "./duration.js";
import { ConfigError } from "./errors.js";
import { ArrivalSchedule } from "./schedule.js";
import type { Scenario } from "./scenario/types.js";

export const RESPONSIBLE_USE_NOTICE =
  "Use apenas contra sistemas próprios ou com autorização por escrito. Esta ferramenta não deve ser usada para negação de serviço (DoS).";

export interface TargetCheck {
  host: string;
  addresses: string[];
  allowed: boolean;
  reason: string;
}

/**
 * Um alvo é permitido sem confirmação quando:
 *  - o host é "localhost" ou consta literalmente em ALLOWED_TARGETS (aceita "*.dominio"), ou
 *  - TODOS os IPs resolvidos são loopback ou estão numa faixa de ALLOWED_TARGETS.
 */
export async function checkTarget(
  baseUrl: string,
  allowedTargets: readonly string[],
): Promise<TargetCheck> {
  const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const list = new net.BlockList();
  list.addSubnet("127.0.0.0", 8, "ipv4");
  list.addAddress("::1", "ipv6");
  const hostEntries: string[] = [];

  for (const entry of allowedTargets) {
    const [addr, bits] = entry.split("/");
    const family = net.isIP(addr!);
    if (family && bits !== undefined)
      list.addSubnet(addr!, Number(bits), family === 6 ? "ipv6" : "ipv4");
    else if (family) list.addAddress(addr!, family === 6 ? "ipv6" : "ipv4");
    else hostEntries.push(entry.toLowerCase());
  }

  const hostListed =
    host === "localhost" ||
    hostEntries.some((h) => (h.startsWith("*.") ? host.endsWith(h.slice(1)) : host === h));

  let addresses: string[] = [];
  if (net.isIP(host)) addresses = [host];
  else {
    try {
      addresses = (await dns.lookup(host, { all: true })).map((a) => a.address);
    } catch (e) {
      if (!hostListed) {
        return {
          host,
          addresses,
          allowed: false,
          reason: `não foi possível resolver ${host} (${(e as NodeJS.ErrnoException).code})`,
        };
      }
    }
  }

  if (hostListed) return { host, addresses, allowed: true, reason: "host na allowlist" };
  const allAllowed =
    addresses.length > 0 &&
    addresses.every((a) => list.check(a, net.isIP(a) === 6 ? "ipv6" : "ipv4"));
  return {
    host,
    addresses,
    allowed: allAllowed,
    reason: allAllowed
      ? "IP(s) loopback ou em ALLOWED_TARGETS"
      : `fora da allowlist (${addresses.join(", ")})`,
  };
}

export interface Limits {
  maxRps: number;
  maxConnections: number;
  maxDurationMs: number;
  maxVus: number;
}

export interface LoadSummary {
  model: "open" | "closed";
  /** Pico de taxa pedida (aberto); no fechado, o teto aplicado durante a execução. */
  peakRps: number;
  peakVus: number;
  durationMs: number;
  /** Estimativa (aberto); null no fechado, onde depende da velocidade do alvo. */
  expectedRequests: number | null;
  connections: number;
}

/** Recusa cenários acima dos tetos de segurança (configuráveis no .env ou por flag explícita). */
export function enforceLimits(scenario: Scenario, limits: Limits): LoadSummary {
  const schedule = new ArrivalSchedule(scenario.load.stages);
  const connections = scenario.load.connections ?? limits.maxConnections;
  const open = scenario.load.model === "open";
  const peakVus = Math.max(0, ...scenario.load.vuStages.map((s) => Math.max(s.vusFrom, s.vusTo)));
  const summary: LoadSummary = {
    model: scenario.load.model,
    peakRps: open ? schedule.peakRps : limits.maxRps,
    peakVus,
    durationMs: schedule.totalMs,
    expectedRequests: open ? Math.round(schedule.expectedCount * avgSteps(scenario)) : null,
    connections,
  };
  const problems: string[] = [];
  if (!open && peakVus > limits.maxVus) {
    problems.push(`${peakVus} VUs excedem o teto de ${limits.maxVus} (LT_MAX_VUS ou --max-vus)`);
  }
  if (open && summary.peakRps > limits.maxRps) {
    problems.push(
      `pico de ${summary.peakRps} rps excede o teto de ${limits.maxRps} rps (LT_MAX_RPS ou --max-rps)`,
    );
  }
  if (connections > limits.maxConnections) {
    problems.push(
      `${connections} conexões excedem o teto de ${limits.maxConnections} (LT_MAX_CONNECTIONS ou --max-connections)`,
    );
  }
  if (summary.durationMs > limits.maxDurationMs) {
    problems.push(
      `duração ${formatDuration(summary.durationMs)} excede o teto de ${formatDuration(limits.maxDurationMs)} (LT_MAX_DURATION)`,
    );
  }
  if (problems.length)
    throw new ConfigError(`limites de segurança:\n  - ${problems.join("\n  - ")}`);
  return summary;
}

/** Requisições por iteração, ponderadas pelo peso de cada fluxo. */
function avgSteps(sc: Scenario): number {
  const w = sc.flows.reduce((s, f) => s + f.weight, 0);
  return w ? sc.flows.reduce((s, f) => s + f.weight * f.steps.length, 0) / w : 0;
}
