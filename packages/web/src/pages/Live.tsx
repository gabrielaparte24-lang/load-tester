import { useEffect, useMemo, useRef, useState } from "react";
import { api, dur, fmt, pct, type RunReport, type RunRow } from "../api";
import { TimeChart } from "../components/Chart";
import { Alert, Loading, RunStatus, Status, Tile } from "../components/ui";
import { useLive } from "../live";
import { go, href } from "../router";

export function LivePage({ id }: { id?: string }) {
  const { active, history, logs, finished, connected } = useLive();

  // sem id: segue a execução ativa
  useEffect(() => {
    if (!id && active) go(`/ao-vivo/${encodeURIComponent(active.id)}`);
  }, [id, active]);

  if (!id) {
    return (
      <>
        <h1>Ao vivo</h1>
        <div className="card empty" style={{ marginTop: 16 }}>
          <p>Nenhuma execução em andamento.</p>
          <a className="btn" href={href("/cenarios")}>
            Escolher um cenário para executar
          </a>
        </div>
      </>
    );
  }
  if (active?.id === id) return <ActiveView />;
  return (
    <FinishedView
      id={id}
      justFinished={finished?.id === id ? finished : null}
      connected={connected}
      logs={finished?.id === id ? logs : []}
      history={finished?.id === id ? history : []}
    />
  );
}

function ActiveView() {
  const { active, history, logs, connected } = useLive();
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const a = active!;
  const last = history[history.length - 1] ?? a.last;
  const elapsed = last?.elapsedMs ?? 0;
  const totals = useMemo(() => {
    let req = 0;
    let err = 0;
    for (const p of history) {
      req += p.rps;
      err += p.errors;
    }
    return { req, err };
  }, [history]);

  const charts = useMemo(() => {
    const x = history.map((p) => Math.round(p.elapsedMs / 1000));
    return {
      thr:
        a.model === "open"
          ? [x, history.map((p) => p.targetRps), history.map((p) => p.sentRps)]
          : [x, history.map((p) => p.rps)],
      lat: [
        x,
        history.map((p) => (p.rps ? p.latencyMs.p50 : null)),
        history.map((p) => (p.rps ? p.latencyMs.p95 : null)),
        history.map((p) => (p.rps ? p.latencyMs.p99 : null)),
      ],
      err: [x, history.map((p) => p.errors)],
      conc: [x, history.map((p) => p.concurrency)],
    };
  }, [history, a.model]);

  const stop = async () => {
    setStopping(true);
    setStopError(null);
    try {
      await api(`/api/runs/${encodeURIComponent(a.id)}/stop`, { method: "POST" });
    } catch (e) {
      setStopError((e as Error).message);
      setStopping(false);
    }
  };

  const remaining = Math.max(0, a.totalMs - elapsed);
  const logRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs.length]);

  return (
    <section className="stack" aria-label="Execução em andamento">
      <div className="page-head">
        <div>
          <h1>
            {a.scenario} <span className="badge">em andamento</span>
          </h1>
          <p className="sub">
            <code>{a.baseUrl}</code> · modelo {a.model === "open" ? "aberto" : "fechado"} ·{" "}
            {a.workers} worker(s) · execução {a.id}
          </p>
        </div>
        <button
          type="button"
          className="danger kill"
          onClick={() => void stop()}
          disabled={stopping}
          aria-label="Parar a execução agora"
        >
          ■ {stopping ? "Parando… (drenando)" : "Parar"}
        </button>
      </div>
      {stopError ? <Alert kind="error">{stopError}</Alert> : null}
      {!connected ? <Alert kind="warn">Conexão de tempo real perdida; reconectando…</Alert> : null}

      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <strong>
            {dur(elapsed)} / {dur(a.totalMs)}
          </strong>
          <span className="muted">
            {last?.warmup ? "aquecimento · " : ""}etapa {last ? last.stage + 1 : 1} de{" "}
            {a.stages.length} · faltam ~{dur(remaining)}
          </span>
        </div>
        <div
          className="progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round((elapsed / a.totalMs) * 100)}
          aria-label="Progresso da execução"
        >
          {a.stages.map((s, i) => (
            <div
              key={i}
              className="seg"
              style={{ width: `${(s.durationMs / a.totalMs) * 100}%` }}
            />
          ))}
          <div
            className="fill"
            style={{ width: `${Math.min(100, (elapsed / a.totalMs) * 100)}%` }}
          />
        </div>
      </div>

      <div className="tiles">
        <Tile
          label="Requisições"
          value={totals.req.toLocaleString("pt-BR")}
          note="desde o início (inclui aquecimento)"
        />
        <Tile
          label="Erros"
          value={totals.err.toLocaleString("pt-BR")}
          note={totals.req ? pct(totals.err / totals.req) : "—"}
        />
        <Tile
          label="Vazão (último s)"
          value={`${fmt(last?.rps ?? 0, 0)} req/s`}
          note={a.model === "open" ? `alvo ${fmt(last?.targetRps ?? 0, 0)} it/s` : undefined}
        />
        <Tile
          label="p95 (último s)"
          value={`${fmt(last?.latencyMs.p95 ?? 0)} ms`}
          note={`p99 ${fmt(last?.latencyMs.p99 ?? 0)} ms`}
        />
        <Tile
          label={a.model === "open" ? "Em andamento" : "VUs ativos"}
          value={last?.concurrency ?? 0}
          note={a.model === "closed" ? `pedidos ${last?.targetVus ?? 0}` : undefined}
        />
        <Tile
          label="CPU da máquina"
          value={last?.cpu !== undefined ? `${fmt(last.cpu, 0)}%` : "—"}
        />
      </div>

      <div className="grid2">
        <div className="card">
          <h2>
            {a.model === "open"
              ? "Vazão: pedida × enviada (it/s)"
              : "Requisições concluídas por segundo"}
          </h2>
          <TimeChart
            title="Vazão por segundo"
            unit={a.model === "open" ? "it/s" : "req/s"}
            series={
              a.model === "open"
                ? [
                    { label: "pedida", color: "--s1" },
                    { label: "enviada", color: "--s2" },
                  ]
                : [{ label: "concluídas", color: "--s1", fill: true }]
            }
            data={charts.thr}
          />
        </div>
        <div className="card">
          <h2>Latência (ms)</h2>
          <TimeChart
            title="Latência p50, p95 e p99 por segundo"
            unit="ms"
            series={[
              { label: "p50", color: "--s1" },
              { label: "p95", color: "--s2" },
              { label: "p99", color: "--s3" },
            ]}
            data={charts.lat}
          />
        </div>
        <div className="card">
          <h2>Erros por segundo</h2>
          <TimeChart
            title="Erros por segundo"
            unit="erros/s"
            series={[{ label: "erros", color: "--s8", fill: true }]}
            data={charts.err}
          />
        </div>
        <div className="card">
          <h2>{a.model === "open" ? "Iterações em andamento" : "Usuários virtuais"}</h2>
          <TimeChart
            title="Concorrência"
            unit={a.model === "open" ? "iterações" : "VUs"}
            series={[
              { label: a.model === "open" ? "em andamento" : "VUs", color: "--s1", fill: true },
            ]}
            data={charts.conc}
          />
        </div>
      </div>

      <div className="card">
        <h2>Log</h2>
        <ul className="logs" ref={logRef} aria-live="polite">
          {logs.map((l, i) => (
            <li key={i} className={l.level}>
              <span className="ts">{new Date(l.ts).toLocaleTimeString("pt-BR")}</span>
              <span>{l.msg}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function FinishedView({
  id,
  justFinished,
  logs,
}: {
  id: string;
  justFinished: RunRow | null;
  connected: boolean;
  logs: { ts: string; level: string; msg: string }[];
  history: unknown[];
}) {
  const [data, setData] = useState<{ run: RunRow | null; report: RunReport | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ run: RunRow | null; report: RunReport | null }>(`/api/runs/${encodeURIComponent(id)}`)
      .then(setData)
      .catch((e) => setError((e as Error).message));
  }, [id, justFinished]);

  if (error) return <Alert kind="error">{error}</Alert>;
  if (!data) return <Loading what="carregando execução" />;
  const run = data.run;
  if (!run) return <Alert kind="error">Execução não encontrada.</Alert>;
  const r = data.report;
  return (
    <section className="stack">
      <div className="page-head">
        <div>
          <h1>
            {run.scenario} <RunStatus run={run} />
          </h1>
          <p className="sub">
            {new Date(run.startedAt).toLocaleString("pt-BR")} · {dur(run.durationMs)} · execução{" "}
            {run.id}
          </p>
        </div>
        <div className="row">
          <a className="btn" href={href("/resultados")}>
            Resultados
          </a>
          {r ? (
            <a
              className="btn"
              href={`/api/runs/${encodeURIComponent(run.id)}/report`}
              target="_blank"
              rel="noopener"
            >
              Abrir relatório completo ↗
            </a>
          ) : null}
        </div>
      </div>
      {run.error ? <Alert kind="error">{run.error}</Alert> : null}
      {r ? (
        <>
          {r.run.invalidReasons.map((m) => (
            <Alert key={m} kind="error">
              {m}
            </Alert>
          ))}
          <div className="tiles">
            <Tile label="Requisições" value={r.summary.requests.total.toLocaleString("pt-BR")} />
            <Tile label="Taxa de erro" value={pct(r.summary.errorRate)} />
            <Tile label="Vazão" value={`${fmt(r.summary.rps.achieved)} req/s`} />
            <Tile label="p50" value={`${fmt(r.summary.latencyMs.p50)} ms`} />
            <Tile label="p95" value={`${fmt(r.summary.latencyMs.p95)} ms`} />
            <Tile label="p99" value={`${fmt(r.summary.latencyMs.p99)} ms`} />
          </div>
          {r.thresholds.length ? (
            <div className="card">
              <h2>Thresholds</h2>
              <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none" }}>
                {r.thresholds.map((t) => (
                  <li key={t.expression}>
                    <Status kind={t.passed ? "ok" : "fail"}>
                      {t.passed ? "passou" : "falhou"}
                    </Status>{" "}
                    <code>{t.expression}</code>{" "}
                    <span className="muted">
                      (medido{" "}
                      {t.actual === null
                        ? "—"
                        : t.metric === "errorRate"
                          ? pct(t.actual)
                          : fmt(t.actual)}
                      )
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}
      {logs.length ? (
        <div className="card">
          <h2>Log da execução</h2>
          <ul className="logs">
            {logs.map((l, i) => (
              <li key={i} className={l.level}>
                <span className="ts">{new Date(l.ts).toLocaleTimeString("pt-BR")}</span>
                <span>{l.msg}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
