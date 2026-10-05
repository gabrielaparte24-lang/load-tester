/**
 * Perfis de teste prontos (`lt init --profile <nome>`). Todos usam o modelo aberto (taxa de
 * chegada), que mede corretamente a latência sob carga; ajuste taxas e durações ao seu sistema.
 */
export const PROFILES = ["smoke", "load", "stress", "spike", "soak"] as const;
export type Profile = (typeof PROFILES)[number];

interface ProfileSpec {
  description: string;
  notes: string[];
  load: string;
  thresholds: string[];
}

const SPECS: Record<Profile, ProfileSpec> = {
  smoke: {
    description: "Smoke: poucas requisições para confirmar que tudo responde antes de gerar carga",
    notes: ["Rode antes de qualquer outro perfil (e em todo PR, no CI)."],
    load: `  stages:
    - { duration: 30s, rps: 2 }`,
    thresholds: ["p95 < 500ms", "errorRate == 0%"],
  },
  load: {
    description: "Load: carga nominal esperada em produção, sustentada por alguns minutos",
    notes: ["Ajuste o platô para o tráfego de pico real (ex.: pico de 1 h de produção × 1,2)."],
    load: `  warmup: 1m
  stages:
    - { duration: 1m, rps: 10 -> 100 } # aquecimento (descartado)
    - { duration: 5m, rps: 100 } # platô na carga nominal
    - { duration: 1m, rps: 100 -> 0 } # descida`,
    thresholds: ["p95 < 300ms", "p99 < 800ms", "errorRate < 1%"],
  },
  stress: {
    description:
      "Stress: aumenta a carga em degraus até o sistema quebrar (stopWhen registra onde)",
    notes: [
      "O teste para sozinho quando uma condição de stopWhen vale por 3 s seguidos; o relatório",
      "traz breakingPoint (carga pedida × vazão obtida no momento da ruptura).",
      "Degraus acima de LT_MAX_RPS exigem elevar o teto (.env ou --max-rps).",
    ],
    load: `  warmup: 30s
  stopWhen: ["errorRate > 5%", "p95 > 2s"]
  stages:
    - { duration: 30s, rps: 50 } # aquecimento
    - { duration: 1m, rps: 50 -> 200 }
    - { duration: 1m, rps: 200 -> 400 }
    - { duration: 1m, rps: 400 -> 800 }
    - { duration: 1m, rps: 800 -> 1600 }
    - { duration: 1m, rps: 1600 }`,
    thresholds: ["p95 < 1s", "errorRate < 5%"],
  },
  spike: {
    description: "Spike: pico súbito de tráfego e recuperação",
    notes: ["Compare a latência antes, durante e depois do pico na linha do tempo do relatório."],
    load: `  stages:
    - { duration: 1m, rps: 20 } # linha de base
    - { duration: 10s, rps: 20 -> 400 } # subida brusca
    - { duration: 1m, rps: 400 } # pico
    - { duration: 10s, rps: 400 -> 20 }
    - { duration: 2m, rps: 20 } # recuperação`,
    thresholds: ["p95 < 1s", "errorRate < 5%"],
  },
  soak: {
    description: "Soak: carga moderada por muito tempo para achar vazamentos e degradação lenta",
    notes: [
      "Acompanhe a latência e a memória (cpu/memPct na linha do tempo) ao longo das horas.",
      "Durações acima de LT_MAX_DURATION (padrão 2h) exigem ajustar o .env.",
    ],
    load: `  warmup: 2m
  stages:
    - { duration: 2m, rps: 5 -> 50 }
    - { duration: 1h, rps: 50 }`,
    thresholds: ["p95 < 300ms", "p99 < 1s", "errorRate < 0.5%"],
  },
};

export function profileYaml(
  profile: Profile,
  opts: { name: string; baseUrl: string; path: string; schemaPath: string },
): string {
  const s = SPECS[profile];
  return `# yaml-language-server: $schema=${opts.schemaPath}
# Perfil "${profile}" — ${s.description}
${s.notes.map((n) => `# ${n}`).join("\n")}
name: ${JSON.stringify(opts.name)}
description: ${JSON.stringify(s.description)}
target:
  baseUrl: ${opts.baseUrl}
  timeoutMs: 10000
load:
  model: open
${s.load}
thresholds:
${s.thresholds.map((t) => `  - "${t}"`).join("\n")}
flow:
  - name: requisição principal
    request: { method: GET, path: ${opts.path} }
    expect: { status: 200 }
`;
}
