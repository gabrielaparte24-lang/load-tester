import { useEffect, useState } from "react";
import { api, dur, fmt, pct, when, type RunRow } from "../api";
import { Alert, Loading, RunStatus } from "../components/ui";
import { useLive } from "../live";
import { go, href } from "../router";

interface Page {
  total: number;
  items: RunRow[];
  scenarios: string[];
}

const PAGE = 50;

export function ResultsPage() {
  const [scenario, setScenario] = useState("");
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState<Page | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { version } = useLive();

  useEffect(() => {
    const ctl = new AbortController();
    const params = new URLSearchParams({ limit: String(limit) });
    if (scenario) params.set("scenario", scenario);
    if (status) params.set("status", status);
    if (q.trim()) params.set("q", q.trim());
    const t = setTimeout(() => {
      api<Page>(`/api/runs?${params}`, { signal: ctl.signal })
        .then((p) => {
          setPage(p);
          setError(null);
        })
        .catch((e) => (e as Error).name !== "AbortError" && setError((e as Error).message));
    }, 200);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [scenario, status, q, limit, version, notice]);

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s.slice(-1), id]));

  const markBaseline = async (r: RunRow) => {
    setBusyId(r.id);
    try {
      await api(`/api/runs/${encodeURIComponent(r.id)}/baseline`, { method: "POST" });
      setNotice(
        `“${r.scenario}”: baseline definida (${r.id}). O CLI usa a mesma baseline em lt run --baseline.`,
      );
    } catch (e) {
      setNotice(`Erro: ${(e as Error).message}`);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Resultados</h1>
          <p className="sub">
            Histórico de execuções (dashboard e CLI). Selecione duas para comparar.
          </p>
        </div>
        <button
          type="button"
          className="primary"
          disabled={selected.length !== 2}
          onClick={() =>
            go(
              `/comparar?a=${encodeURIComponent(selected[0]!)}&b=${encodeURIComponent(selected[1]!)}`,
            )
          }
        >
          Comparar selecionadas ({selected.length}/2)
        </button>
      </div>
      <div className="card stack">
        <div className="row" role="search">
          <label className="field">
            Cenário
            <select value={scenario} onChange={(e) => setScenario(e.target.value)}>
              <option value="">todos</option>
              {page?.scenarios.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Estado
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">todos</option>
              <option value="completed">concluída</option>
              <option value="interrupted">interrompida</option>
              <option value="failed">falhou</option>
              <option value="running">em andamento</option>
            </select>
          </label>
          <label className="field" style={{ flex: 1, minWidth: 180 }}>
            Busca
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="id, cenário ou URL"
            />
          </label>
        </div>
        {notice ? (
          <Alert kind={notice.startsWith("Erro") ? "error" : "info"}>{notice}</Alert>
        ) : null}
        {error ? <Alert kind="error">{error}</Alert> : null}
        {!page && !error ? <Loading what="carregando histórico" /> : null}
        {page && !page.items.length ? <p className="empty">Nenhuma execução encontrada.</p> : null}
        {page && page.items.length ? (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>
                    <span className="sr-only">selecionar</span>
                  </th>
                  <th>quando</th>
                  <th>cenário</th>
                  <th>estado</th>
                  <th className="num">req</th>
                  <th className="num">p50</th>
                  <th className="num">p95</th>
                  <th className="num">p99 ms</th>
                  <th className="num">erros</th>
                  <th className="num">req/s</th>
                  <th className="num">thresholds</th>
                  <th>origem</th>
                  <th>ações</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((r) => (
                  <tr key={r.id} className={selected.includes(r.id) ? "selected" : undefined}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.includes(r.id)}
                        onChange={() => toggle(r.id)}
                        disabled={r.status === "running" || r.status === "failed"}
                        aria-label={`Selecionar ${r.id} para comparar`}
                      />
                    </td>
                    <td title={r.id}>
                      {when(r.startedAt)}
                      <div className="muted">{dur(r.durationMs)}</div>
                    </td>
                    <td>
                      {r.scenario}{" "}
                      {r.isBaseline ? (
                        <span className="badge" title="baseline do cenário">
                          ★ baseline
                        </span>
                      ) : null}
                    </td>
                    <td>
                      <RunStatus run={r} />
                    </td>
                    <td className="num">{r.requests?.toLocaleString("pt-BR") ?? "—"}</td>
                    <td className="num">{fmt(r.p50)}</td>
                    <td className="num">{fmt(r.p95)}</td>
                    <td className="num">{fmt(r.p99)}</td>
                    <td className="num">{pct(r.errorRate)}</td>
                    <td className="num">{fmt(r.rps, 1)}</td>
                    <td className="num">
                      {r.thresholdsTotal ? `${r.thresholdsPassed}/${r.thresholdsTotal}` : "—"}
                    </td>
                    <td>{r.source === "cli" ? "CLI" : "dashboard"}</td>
                    <td>
                      <div className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                        {r.status === "running" ? (
                          <a className="btn" href={href(`/ao-vivo/${encodeURIComponent(r.id)}`)}>
                            Acompanhar
                          </a>
                        ) : r.status !== "failed" ? (
                          <>
                            <a
                              className="btn"
                              href={`/api/runs/${encodeURIComponent(r.id)}/report`}
                              target="_blank"
                              rel="noopener"
                            >
                              Relatório ↗
                            </a>
                            <button
                              type="button"
                              disabled={
                                busyId === r.id ||
                                r.isBaseline ||
                                r.invalid ||
                                r.status !== "completed"
                              }
                              onClick={() => void markBaseline(r)}
                              title={
                                r.invalid
                                  ? "Execução inválida não pode ser baseline"
                                  : "Usar como baseline do cenário"
                              }
                            >
                              ★ Baseline
                            </button>
                          </>
                        ) : (
                          <span className="muted" title={r.error ?? ""}>
                            {r.error ? r.error.slice(0, 40) : "—"}
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {page && page.total > page.items.length ? (
          <button type="button" onClick={() => setLimit((l) => l + PAGE)}>
            Carregar mais ({page.items.length} de {page.total})
          </button>
        ) : null}
      </div>
    </>
  );
}
