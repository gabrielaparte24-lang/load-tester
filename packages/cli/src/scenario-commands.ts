import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import {
  ArrivalSchedule,
  ConfigError,
  ExitCode,
  LtError,
  formatDuration,
  getConfig,
  importCurl,
  importOpenApi,
  initScenarioYaml,
  loadScenarioFile,
  previewIterations,
  resolveInside,
  scenarioSchema,
  scenarioToYaml,
  schemaRef,
  tokenizeShell,
  type ImportResult,
  type Scenario,
} from "@lt/core";
import { c } from "./ui.js";

const positiveInt = (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new ConfigError(`"${v}" deve ser um inteiro positivo`);
  return n;
};

/** Grava dentro do projeto; recusa sobrescrever sem --force. */
function writeInsideProject(file: string, content: string, force?: boolean): string {
  const target = resolveInside(getConfig().root, path.resolve(file), "arquivo de saída");
  if (fs.existsSync(target) && !force) {
    throw new ConfigError(`"${file}" já existe (use --force para sobrescrever)`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

function describeScenario(file: string, sc: Scenario): string {
  const schedule = new ArrivalSchedule(sc.load.stages);
  const steps = sc.flows.reduce((n, f) => n + f.steps.length, 0);
  const lines = [
    `${c.green("✓")} ${file}: "${sc.name}" válido`,
    `    carga     ${sc.load.stages.length} etapa(s), ${formatDuration(schedule.totalMs)}, pico ${schedule.peakRps} rps` +
      (sc.load.warmupMs ? `, aquecimento ${formatDuration(sc.load.warmupMs)}` : ""),
    `    fluxos    ${sc.flows.map((f) => (sc.flows.length > 1 ? `${f.name} (peso ${f.weight}, ${f.steps.length} etapa(s))` : `${f.steps.length} etapa(s)`)).join("; ")}` +
      (sc.flows.length > 1 ? `  — total ${steps} etapa(s)` : ""),
  ];
  if (sc.variables.length) lines.push(`    variáveis ${sc.variables.map(([k]) => k).join(", ")}`);
  for (const d of sc.data) {
    lines.push(
      `    dados     ${d.file}: ${d.rows.length} linha(s), ${d.order}, colunas ${d.name ? `${d.name}.{${d.columns.join(",")}}` : d.columns.join(", ")}`,
    );
  }
  if (sc.thresholds.length) lines.push(`    limites   ${sc.thresholds.join(" · ")}`);
  if (sc.secrets.length)
    lines.push(`    segredos  ${sc.secrets.length} valor(es) de \${env.*} (mascarados nas saídas)`);
  return lines.join("\n");
}

function printImport(
  result: ImportResult,
  out: string | undefined,
  force: boolean | undefined,
  source: string,
): void {
  const root = getConfig().root;
  const yaml = scenarioToYaml(
    result.scenario,
    [
      `Gerado por \`lt import ${source}\`. Revise antes de executar.`,
      "Valide com: npx lt validate <arquivo> --preview 3",
    ],
    schemaRef(out, root),
  );
  if (out) {
    const written = writeInsideProject(out, yaml, force);
    console.error(`${c.green("✓")} cenário gravado em ${path.relative(process.cwd(), written)}`);
  } else process.stdout.write(yaml);
  for (const n of result.notes) console.error(c.yellow(`! ${n}`));
}

export function registerScenarioCommands(program: Command): void {
  program
    .command("validate")
    .description("valida cenário(s) sem executar; --preview mostra as requisições montadas")
    .argument("<cenario...>", "arquivo(s) YAML/JSON")
    .option(
      "-p, --preview <n>",
      "monta (sem enviar) as requisições das N primeiras iterações",
      positiveInt,
    )
    .action((files: string[], flags: { preview?: number }) => {
      let failed = 0;
      for (const f of files) {
        try {
          const sc = loadScenarioFile(f);
          console.log(describeScenario(f, sc));
          if (flags.preview) {
            let last = -1;
            for (const p of previewIterations(sc, flags.preview)) {
              if (p.iteration !== last) {
                console.log(
                  c.bold(
                    `\n  iteração ${p.iteration}${sc.flows.length > 1 ? ` — fluxo "${p.flow}"` : ""}`,
                  ),
                );
                last = p.iteration;
              }
              if (p.error) {
                console.log(c.red(`    ${p.step}: ${p.error}`));
                continue;
              }
              console.log(`    ${c.cyan(p.method)} ${p.url}  ${c.dim(`(${p.step})`)}`);
              for (const [k, v] of Object.entries(p.headers))
                console.log(c.dim(`      ${k}: ${v}`));
              if (p.body !== undefined) console.log(c.dim(`      corpo: ${p.body}`));
            }
            console.log(
              c.dim("\n  <nome> = valor que só existe após a resposta da etapa anterior (extract)"),
            );
          }
        } catch (e) {
          failed++;
          if (e instanceof LtError) console.error(c.red(`✗ ${e.message}`));
          else throw e;
        }
      }
      if (failed) process.exitCode = ExitCode.CONFIG_ERROR;
    });

  program
    .command("init")
    .description("gera um cenário de exemplo comentado")
    .argument("[arquivo]", "arquivo a criar", "scenario.yaml")
    .option("--target <url>", "URL base do alvo", "http://127.0.0.1:4100")
    .option("--name <nome>", "nome do cenário")
    .option("--force", "sobrescreve se existir")
    .action((file: string, flags: { target: string; name?: string; force?: boolean }) => {
      if (!/^https?:\/\//.test(flags.target))
        throw new ConfigError("--target deve começar com http:// ou https://");
      const name = flags.name ?? path.basename(file).replace(/\.(ya?ml|json)$/i, "");
      const written = writeInsideProject(
        file,
        initScenarioYaml({
          name,
          baseUrl: flags.target.replace(/\/+$/, ""),
          schemaPath: schemaRef(file, getConfig().root),
        }),
        flags.force,
      );
      const rel = path.relative(process.cwd(), written);
      console.log(`${c.green("✓")} ${rel} criado`);
      console.log(
        `  Próximos passos: ${c.cyan(`npx lt validate ${rel} --preview 3`)} e ${c.cyan(`npx lt run ${rel}`)}`,
      );
    });

  program
    .command("schema")
    .description("imprime o JSON Schema dos cenários (autocompletar no editor)")
    .option("-o, --out <arquivo>", "grava no arquivo (dentro do projeto)")
    .option("--force", "sobrescreve se existir")
    .action((flags: { out?: string; force?: boolean }) => {
      const json = `${JSON.stringify(scenarioSchema, null, 2)}\n`;
      if (flags.out) {
        writeInsideProject(flags.out, json, flags.force);
        console.error(`${c.green("✓")} schema gravado em ${flags.out}`);
      } else process.stdout.write(json);
    });

  const imp = program.command("import").description("gera cenários a partir de cURL ou OpenAPI");

  imp
    .command("curl")
    .description('converte um comando cURL (entre aspas, ou após "--")')
    .argument(
      "[comando...]",
      "ex.: \"curl -X POST https://api/x -H 'Content-Type: application/json' -d '{}'\"",
    )
    .option(
      "-f, --file <arquivo>",
      "lê o comando de um arquivo (evita segredos no histórico do shell)",
    )
    .option("-o, --out <arquivo>", "grava no arquivo (dentro do projeto); sem isso, imprime")
    .option("--name <nome>", "nome do cenário")
    .option("--force", "sobrescreve se existir")
    .allowUnknownOption()
    .action(
      (parts: string[], flags: { file?: string; out?: string; name?: string; force?: boolean }) => {
        let args: string[];
        if (flags.file) {
          try {
            args = tokenizeShell(fs.readFileSync(flags.file, "utf8").trim());
          } catch (e) {
            if (e instanceof LtError) throw e;
            throw new ConfigError(
              `não foi possível ler "${flags.file}": ${(e as NodeJS.ErrnoException).code}`,
            );
          }
        } else if (parts.length) {
          args = parts.length === 1 ? tokenizeShell(parts[0]!) : parts;
        } else
          throw new ConfigError("informe o comando cURL (entre aspas, após --, ou com --file)");
        printImport(importCurl(args, { name: flags.name }), flags.out, flags.force, "curl");
      },
    );

  imp
    .command("openapi")
    .description("gera um cenário com um fluxo por operação (só GET/HEAD por padrão)")
    .argument("<arquivo>", "especificação OpenAPI 3.x ou Swagger 2.0 (YAML/JSON)")
    .option("-o, --out <arquivo>", "grava no arquivo (dentro do projeto); sem isso, imprime")
    .option("--base-url <url>", "sobrescreve a URL base da especificação")
    .option("--all-methods", "inclui POST/PUT/PATCH/DELETE (alteram dados!)")
    .option("--name <nome>", "nome do cenário")
    .option("--force", "sobrescreve se existir")
    .action(
      (
        file: string,
        flags: {
          out?: string;
          baseUrl?: string;
          allMethods?: boolean;
          name?: string;
          force?: boolean;
        },
      ) => {
        let text: string;
        try {
          text = fs.readFileSync(file, "utf8");
        } catch (e) {
          throw new ConfigError(
            `não foi possível ler "${file}": ${(e as NodeJS.ErrnoException).code}`,
          );
        }
        printImport(
          importOpenApi(text, {
            name: flags.name,
            baseUrl: flags.baseUrl,
            allMethods: flags.allMethods,
          }),
          flags.out,
          flags.force,
          "openapi",
        );
      },
    );
}
