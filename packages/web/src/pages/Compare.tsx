import { useEffect, useState } from "react";
import { api, fmt, pct, when, type ComparisonResult, type RunRow } from "../api";
import { Alert, Loading, Status } from "../components/ui";
import { go } from "../router";

export function ComparePage({ a, b }: { a?: string; b?: string }) {
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [alpha, setAlpha] = useState(0.05);
  const [minEffect, setMinEffect] = useState(5);
  const [result, setResult] = useState<ComparisonResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api<{ items: RunRow[] }>("/api/runs?status=completed&limit=200")
      .then((p) => setRuns(p.items))
      .catch((e) => setError((e as Error).message));
  }, []);

  useEffect(() => {
    setResult(null);
    if (!a || !b) return;
    setLoading(true);
    setError(null);
    api<ComparisonResult>("/api/compare", { body: { a, b, alpha, minEffectPct: minEffect } })
      .then(setResult)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [a, b, alpha, minEffect]);

  const set = (na?: string, nb?: string) => {
    const q = new URLSearchParams();
    if (na) q.set("a", na);
    if (nb) q.set("b", nb);
    go(`/comparar?${q}`);
  };
  const label = (r: RunRow) => `${when(r.startedAt)} · ${r.scenario} · p95 ${fmt(r.p95)} ms`;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Comparar execuções</h1>
          <p className="sub">
            Diferença real ou ruído? Blocos de 5 s, Mann-Whitney U, IC 95% por bootstrap e correção
            de Holm. Para decisões robustas, use <code>lt bench --ab</code>.
          </p>
        </div>
      </div>
      <div className="card stack">
        {!runs && !error ? <Loading what="carregando execuções" /> : null}
        {runs ? (
          <div className="row">
            <label className="field" style={{ flex: 1, minWidth: 240 }}>
              A (referência)
              <select value={a ?? ""} onChange={(e) => set(e.target.value || undefined, b)}>
                <option value="">— escolha —</option>
                {runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    {label(r)}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="ghost"
              onClick={() => set(b, a)}
              aria-label="Trocar A e B"
              title="Trocar A e B"
            >
              ⇄
            </button>
            <label className="field" style={{ flex: 1, minWidth: 240 }}>
              B (candidata)
              <select value={b ?? ""} onChange={(e) => set(a, e.target.value || undefined)}>
                <option value="">— escolha —</option>
                {runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    {label(r)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              α
              <select value={alpha} onChange={(e) => setAlpha(Number(e.target.value))}>
                {[0.01, 0.05, 0.1].map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              efeito mínimo
              <select value={minEffect} onChange={(e) => setMinEffect(Number(e.target.value))}>
                {[2, 5, 10, 20].map((v) => (
                  <option key={v} value={v}>
                    {v}%
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : null}
        {error ? <Alert kind="error">{error}</Alert> : null}
        {loading ? <Loading what="comparando" /> : null}
        {result ? (
          <ComparisonView c={result} />
        ) : !a || !b ? (
          <p className="muted">Escolha duas execuções concluídas.</p>
        ) : null}
      </div>
    </>
  );
}

export function ComparisonView({ c }: { c: ComparisonResult }) {
  const f = (v: number, unit: string) =>
    !Number.isFinite(v) ? "—" : unit === "%" ? pct(v) : fmt(v);
  return (
    <div className="stack">
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>métrica</th>
              <th className="num">A</th>
              <th className="num">B</th>
              <th className="num">Δ%</th>
              <th className="num">IC 95% (B−A)</th>
              <th className="num">p (Holm)</th>
              <th>veredito</th>
            </tr>
          </thead>
          <tbody>
            {c.metrics.map((m) => (
              <tr key={m.metric}>
                <td>
                  {m.label} <span className="muted">{m.unit === "%" ? "" : m.unit}</span>
                </td>
                <td className="num">{f(m.a, m.unit)}</td>
                <td className="num">{f(m.b, m.unit)}</td>
                <td className="num">
                  {m.deltaPct === null
                    ? "—"
                    : `${m.deltaPct > 0 ? "+" : ""}${m.deltaPct.toFixed(1)}%`}
                </td>
                <td className="num">
                  {Number.isFinite(m.ci.lo)
                    ? `[${f(m.ci.lo, m.unit)}, ${f(m.ci.hi, m.unit)}]`
                    : "—"}
                </td>
                <td className="num">
                  {Number.isFinite(m.pAdj) ? (m.pAdj < 0.001 ? "<0.001" : m.pAdj.toFixed(3)) : "—"}
                </td>
                <td>
                  {m.verdict === "pior" ? (
                    <Status kind="fail">pior</Status>
                  ) : m.verdict === "melhor" ? (
                    <Status kind="ok">melhor</Status>
                  ) : m.verdict === "pequena" ? (
                    <Status kind="warn">diferença pequena</Status>
                  ) : (
                    <span className="muted">{m.verdict}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ margin: 0 }}>
        <strong>Conclusão:</strong>{" "}
        {c.regression ? (
          <Status kind="fail">{c.conclusion}</Status>
        ) : c.improvement ? (
          <Status kind="ok">{c.conclusion}</Status>
        ) : (
          c.conclusion
        )}
      </p>
      <p className="muted" style={{ margin: 0 }}>
        {c.method}
      </p>
      {c.warnings.map((w) => (
        <Alert key={w} kind="warn">
          {w}
        </Alert>
      ))}
    </div>
  );
}
