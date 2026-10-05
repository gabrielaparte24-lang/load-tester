import { ConfigError } from "../errors.js";

/**
 * Converte um comando cURL em cenário. Segredos (Authorization, Cookie, chaves de API, -u)
 * NUNCA são gravados: viram ${env.NOME} e a lista de variáveis a definir é devolvida em `env`.
 */
export interface ImportResult {
  scenario: Record<string, unknown>;
  /** Variáveis de ambiente que o usuário precisa definir no .env. */
  env: string[];
  notes: string[];
}

const SECRET_HEADER =
  /^(authorization|cookie|proxy-authorization|x-api-key|api-key|x-auth-token|x-access-token)$|token|secret|apikey|api_key|password/i;

/** Divide uma linha de comando respeitando aspas simples/duplas, escapes e quebras com \ ou ^ ou `. */
export function tokenizeShell(input: string): string[] {
  const src = input.replace(/[\\^`]\r?\n/g, " ");
  const out: string[] = [];
  let cur = "";
  let has = false;
  let q: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (q === "'") {
      if (ch === "'") q = null;
      else cur += ch;
    } else if (q === '"') {
      if (ch === '"') q = null;
      else if (ch === "\\" && /["\\$`]/.test(src[i + 1] ?? "")) cur += src[++i];
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      q = ch;
      has = true;
    } else if (ch === "\\" && i + 1 < src.length) {
      cur += src[++i];
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (q) throw new ConfigError("comando cURL com aspas sem fechamento");
  if (has || cur) out.push(cur);
  return out;
}

const envName = (s: string) =>
  "LT_" +
  s
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

export function importCurl(args: string[], opts: { name?: string } = {}): ImportResult {
  const argv =
    args[0]?.toLowerCase() === "curl" || args[0]?.toLowerCase() === "curl.exe"
      ? args.slice(1)
      : args;
  let url: string | undefined;
  let method: string | undefined;
  let forceGet = false;
  const headers: [string, string][] = [];
  const data: string[] = [];
  const form: [string, string][] = [];
  let jsonFlag = false;
  const env = new Set<string>();
  const notes: string[] = [];

  const secretRef = (label: string) => {
    const n = envName(label);
    env.add(n);
    return n;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new ConfigError(`cURL: ${a} sem valor`);
      return v;
    };
    // forma --opcao=valor
    const eq = /^(--[a-z-]+)=(.*)$/.exec(a);
    const opt = eq ? eq[1]! : a;
    const val = () => (eq ? eq[2]! : next());
    switch (opt) {
      case "-X":
      case "--request":
        method = val().toUpperCase();
        break;
      case "-H":
      case "--header": {
        const h = val();
        const idx = h.indexOf(":");
        if (idx > 0) headers.push([h.slice(0, idx).trim(), h.slice(idx + 1).trim()]);
        break;
      }
      case "-d":
      case "--data":
      case "--data-raw":
      case "--data-ascii":
      case "--data-binary":
        data.push(val());
        break;
      case "--data-urlencode": {
        const v = val();
        const k = v.indexOf("=");
        data.push(
          k > 0 ? `${v.slice(0, k)}=${encodeURIComponent(v.slice(k + 1))}` : encodeURIComponent(v),
        );
        break;
      }
      case "--json":
        data.push(val());
        jsonFlag = true;
        break;
      case "-F":
      case "--form": {
        const v = val();
        const k = v.indexOf("=");
        if (k > 0) form.push([v.slice(0, k), v.slice(k + 1)]);
        break;
      }
      case "-u":
      case "--user":
        val();
        headers.push(["Authorization", `Basic \${base64(env.${secretRef("basic auth")})}`]);
        notes.push(
          "credencial de -u/--user substituída por variável de ambiente (formato usuario:senha)",
        );
        break;
      case "-b":
      case "--cookie":
        val();
        headers.push(["Cookie", `\${env.${secretRef("cookie")}}`]);
        break;
      case "-A":
      case "--user-agent":
        headers.push(["User-Agent", val()]);
        break;
      case "-e":
      case "--referer":
        headers.push(["Referer", val()]);
        break;
      case "-G":
      case "--get":
        forceGet = true;
        break;
      case "--url":
        url = val();
        break;
      case "-k":
      case "--insecure":
        notes.push("--insecure ignorado: certificados TLS são sempre verificados");
        break;
      case "--compressed":
      case "-s":
      case "--silent":
      case "-S":
      case "--show-error":
      case "-v":
      case "--verbose":
      case "-i":
      case "--include":
      case "-L":
      case "--location":
      case "-f":
      case "--fail":
        break;
      case "-o":
      case "--output":
      case "-m":
      case "--max-time":
      case "--connect-timeout":
        val();
        break;
      default:
        if (a.startsWith("-")) notes.push(`opção ignorada: ${a}`);
        else if (!url) url = a;
        else notes.push(`argumento ignorado: ${a}`);
    }
  }
  if (!url) throw new ConfigError("cURL: URL não encontrada");
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  const u = new URL(url);

  // segredos em headers viram ${env.*}
  const outHeaders: Record<string, string> = {};
  for (const [k, v] of headers) {
    if (v.includes("${")) outHeaders[k] = v;
    else if (SECRET_HEADER.test(k)) {
      const scheme = /^(Bearer|Basic|Token|Digest)\s+/i.exec(v)?.[1];
      const ref = `\${env.${secretRef(k)}}`;
      outHeaders[k] = scheme ? `${scheme} ${ref}` : ref;
    } else outHeaders[k] = v;
  }
  if (env.size) notes.push(`segredos não foram copiados; defina no .env: ${[...env].join(", ")}`);

  const contentType = Object.entries(outHeaders).find(
    ([k]) => k.toLowerCase() === "content-type",
  )?.[1];
  const query: Record<string, string | string[]> = {};
  const addQuery = (k: string, v: string) => {
    const prev = query[k];
    query[k] = prev === undefined ? v : ([] as string[]).concat(prev, v);
  };
  for (const [k, v] of u.searchParams) addQuery(k, v);

  const request: Record<string, unknown> = {};
  const body = data.join("&");
  if (forceGet && data.length) {
    for (const [k, v] of new URLSearchParams(body)) addQuery(k, v);
  } else if (form.length) {
    const mp: Record<string, unknown> = {};
    for (const [k, v] of form) {
      if (v.startsWith("@")) {
        const [file, ...attrs] = v.slice(1).split(";");
        const type = attrs.find((x) => x.startsWith("type="))?.slice(5);
        mp[k] = type ? { file, contentType: type } : { file };
      } else mp[k] = v.replace(/^"(.*)"$/, "$1");
    }
    request.multipart = mp;
    notes.push("arquivos de -F são relativos ao arquivo do cenário");
  } else if (data.length) {
    if (data.length === 1 && data[0]!.startsWith("@")) {
      request.file = data[0]!.slice(1);
    } else if (jsonFlag || /json/i.test(contentType ?? "") || /^\s*[[{]/.test(body)) {
      try {
        request.json = JSON.parse(body);
      } catch {
        request.body = body;
      }
    } else if (
      /^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(body) &&
      !/json/i.test(contentType ?? "")
    ) {
      request.form = Object.fromEntries(new URLSearchParams(body));
    } else request.body = body;
  }
  // content-type implícito nos corpos estruturados
  if (request.json || request.form || request.multipart) {
    for (const k of Object.keys(outHeaders))
      if (k.toLowerCase() === "content-type") delete outHeaders[k];
  }

  const m = method ?? (forceGet ? "GET" : data.length || form.length ? "POST" : "GET");
  const stepReq: Record<string, unknown> = { method: m, path: u.pathname || "/" };
  if (Object.keys(query).length) stepReq.query = query;
  if (Object.keys(outHeaders).length) stepReq.headers = outHeaders;
  Object.assign(stepReq, request);

  return {
    scenario: {
      name: opts.name ?? `${m.toLowerCase()} ${u.host}${u.pathname}`.replace(/\/$/, ""),
      target: { baseUrl: u.origin, timeoutMs: 10_000 },
      load: { model: "open", stages: [{ duration: "30s", rps: 5 }] },
      thresholds: ["p95 < 500ms", "errorRate < 1%"],
      flow: [{ name: `${m} ${u.pathname}`, request: stepReq }],
    },
    env: [...env],
    notes,
  };
}
