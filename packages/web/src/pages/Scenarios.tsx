import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  api,
  dur,
  type ScenarioMeta,
  type ScenarioRow,
  type ValidateResult,
} from "../api";
import { RunDialog } from "../components/RunDialog";
import { Alert, Loading, Modal, Status } from "../components/ui";
import { YamlEditor, type YamlEditorHandle } from "../components/YamlEditor";
import { useLive } from "../live";
import { go, href } from "../router";

const TEMPLATE = `# yaml-language-server: $schema=../schema/scenario.schema.json
name: novo-cenario
target:
  baseUrl: http://127.0.0.1:4100
  timeoutMs: 5000
load:
  model: open
  stages:
    - { duration: 30s, rps: 10 }
thresholds:
  - "p95 < 300ms"
  - "errorRate < 1%"
flow:
  - name: requisição principal
    request: { method: GET, path: /fast }
    expect: { status: 200 }
`;

export function ScenariosPage({ id }: { id?: string }) {
  const [list, setList] = useState<ScenarioMeta[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const { version } = useLive();

  useEffect(() => {
    api<ScenarioMeta[]>("/api/scenarios")
      .then((l) => {
        setList(l);
        setListError(null);
      })
      .catch((e) => setListError((e as Error).message));
  }, [version]);

  // sem cenário escolhido: abre o primeiro
  useEffect(() => {
    if (!id && list?.length) go(`/cenarios/${encodeURIComponent(list[0]!.id)}`);
  }, [id, list]);

  const create = async () => {
    const s = await api<ScenarioRow>("/api/scenarios", { body: { yaml: TEMPLATE } });
    go(`/cenarios/${encodeURIComponent(s.id)}`);
  };

  const shown = (list ?? []).filter((s) =>
    `${s.name} ${s.id}`.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Cenários</h1>
          <p className="sub">Edite com validação em tempo real e execute contra o alvo.</p>
        </div>
        <button type="button" className="primary" onClick={() => void create()}>
          + Novo cenário
        </button>
      </div>
      <div className="scen-layout">
        <nav className="card scen-list" aria-label="Lista de cenários">
          <input
            type="search"
            placeholder="Filtrar…"
            aria-label="Filtrar cenários"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{ width: "100%", marginBottom: 8 }}
          />
          {listError ? <Alert kind="error">{listError}</Alert> : null}
          {!list && !listError ? <Loading /> : null}
          {list && !shown.length ? <p className="empty">Nenhum cenário.</p> : null}
          {shown.map((s) => (
            <a
              key={s.id}
              href={href(`/cenarios/${encodeURIComponent(s.id)}`)}
              aria-current={s.id === id ? "true" : undefined}
            >
              {s.name}
              <span className="id">{s.id}</span>
            </a>
          ))}
        </nav>
        {id ? (
          <ScenarioEditor key={id} id={id} />
        ) : (
          <div className="card empty">Crie ou escolha um cenário.</div>
        )}
      </div>
    </>
  );
}

function ScenarioEditor({ id }: { id: string }) {
  const [row, setRow] = useState<ScenarioRow | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [saved, setSaved] = useState("");
  const [result, setResult] = useState<ValidateResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const [runOpen, setRunOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tab, setTab] = useState<"problemas" | "previa">("problemas");
  const editor = useRef<YamlEditorHandle | null>(null);
  const { active } = useLive();

  useEffect(() => {
    api<ScenarioRow>(`/api/scenarios/${encodeURIComponent(id)}`)
      .then((r) => {
        setRow(r);
        setText(r.yaml);
        setSaved(r.yaml);
      })
      .catch((e) =>
        setLoadError(
          e instanceof ApiError && e.status === 404
            ? "Cenário não encontrado."
            : (e as Error).message,
        ),
      );
  }, [id]);

  const validate = useCallback(
    async (yaml: string) => {
      try {
        const r = await api<ValidateResult>("/api/scenarios/validate", {
          body: { yaml, scenarioId: id, preview: 3 },
        });
        setResult(r);
        return r.issues;
      } catch (e) {
        setResult({ valid: false, issues: [{ path: "", message: (e as Error).message }] });
        return [];
      }
    },
    [id],
  );

  const dirty = text !== saved;
  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const r = await api<ScenarioRow>(`/api/scenarios/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: { yaml: text },
      });
      setSaved(r.yaml);
      setRow(r);
      setMessage({ kind: "info", text: "Salvo." });
      return true;
    } catch (e) {
      setMessage({ kind: "error", text: (e as Error).message });
      return false;
    } finally {
      setSaving(false);
    }
  };

  const del = async () => {
    await api(`/api/scenarios/${encodeURIComponent(id)}`, { method: "DELETE" });
    setConfirmDelete(false);
    go("/cenarios");
  };

  const runClick = async () => {
    if (dirty && !(await save())) return;
    setRunOpen(true);
  };

  if (loadError) return <Alert kind="error">{loadError}</Alert>;
  if (!row) return <Loading what="carregando cenário" />;

  const s = result?.summary;
  return (
    <section className="stack" aria-label={`Editor do cenário ${row.name}`}>
      <div className="card">
        <div className="row" style={{ marginBottom: 10 }}>
          <div>
            <h2 style={{ margin: 0 }}>{row.name}</h2>
            <span className="muted">
              {row.id} · atualizado {new Date(row.updatedAt).toLocaleString("pt-BR")}
            </span>
          </div>
          <div className="spacer" />
          {dirty ? <span className="badge">alterações não salvas</span> : null}
          <button type="button" onClick={() => void save()} disabled={!dirty || saving}>
            {saving ? "Salvando…" : "Salvar"}
          </button>
          <button type="button" className="ghost" onClick={() => setConfirmDelete(true)}>
            Excluir
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void runClick()}
            disabled={!result?.valid || !!active}
            title={
              active
                ? "Já há uma execução em andamento"
                : !result?.valid
                  ? "Corrija os erros de validação"
                  : undefined
            }
          >
            ▶ Executar
          </button>
        </div>
        {message ? <Alert kind={message.kind}>{message.text}</Alert> : null}
        <YamlEditor
          value={row.yaml}
          onChange={setText}
          validate={validate}
          handleRef={(h) => (editor.current = h)}
          label={`YAML do cenário ${row.name}`}
        />
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          {result === null ? (
            <span className="muted">validando…</span>
          ) : result.valid ? (
            <Status kind="ok">válido</Status>
          ) : (
            <Status kind="fail">{result.issues.length} problema(s)</Status>
          )}
          {s ? (
            <span className="muted">
              {s.model === "open"
                ? `aberto, pico ${s.peakRps} rps`
                : `fechado, até ${s.peakVus} VUs`}{" "}
              · {dur(s.durationMs)} · {s.flows.length} fluxo(s) · {s.baseUrl}
            </span>
          ) : null}
          <div className="spacer" />
          <div role="tablist" className="row" style={{ gap: 4 }}>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "problemas"}
              className={tab === "problemas" ? "" : "ghost"}
              onClick={() => setTab("problemas")}
            >
              Problemas
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "previa"}
              className={tab === "previa" ? "" : "ghost"}
              onClick={() => setTab("previa")}
            >
              Prévia das requisições
            </button>
          </div>
        </div>
        {tab === "problemas" ? (
          result && !result.valid ? (
            <ul className="issues">
              {result.issues.map((i, k) => (
                <li
                  key={k}
                  onClick={() => i.line && editor.current?.goTo(i.line, i.col)}
                  title="Ir para a linha"
                >
                  <strong>{i.line ? `linha ${i.line}, col ${i.col}` : "geral"}</strong> ·{" "}
                  <code>{i.path || "(raiz)"}</code>: {i.message}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              Nenhum problema. Use “Prévia das requisições” para ver as 3 primeiras iterações
              montadas (sem enviar).
            </p>
          )
        ) : result?.preview?.length ? (
          <pre className="preview">
            {result.preview
              .map(
                (p) =>
                  `#${p.iteration} ${p.flow ? `[${p.flow}] ` : ""}${p.error ? `${p.step}: ERRO ${p.error}` : `${p.method} ${p.url}`}` +
                  (p.body ? `\n    corpo: ${p.body}` : ""),
              )
              .join("\n")}
          </pre>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            A prévia aparece quando o cenário é válido.
          </p>
        )}
      </div>

      <RunDialog
        open={runOpen}
        scenarioId={id}
        summary={s ?? null}
        onClose={() => setRunOpen(false)}
      />
      <Modal
        open={confirmDelete}
        title="Excluir cenário?"
        onClose={() => setConfirmDelete(false)}
        footer={
          <>
            <button type="button" onClick={() => setConfirmDelete(false)}>
              Cancelar
            </button>
            <button type="button" className="danger" onClick={() => void del()}>
              Excluir
            </button>
          </>
        }
      >
        <p>
          “{row.name}” será removido. O histórico de execuções e os relatórios continuam disponíveis
          em Resultados.
        </p>
      </Modal>
    </section>
  );
}
