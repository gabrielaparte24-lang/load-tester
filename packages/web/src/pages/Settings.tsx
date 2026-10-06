import { useEffect, useState } from "react";
import { api, dur, type StatusInfo } from "../api";
import { Alert, Loading, Status } from "../components/ui";
import { useLive } from "../live";
import { useTheme, type ThemePref } from "../theme";

export function SettingsPage() {
  const [s, setS] = useState<StatusInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { connected, version } = useLive();
  const { pref, setPref } = useTheme();

  useEffect(() => {
    const load = () =>
      api<StatusInfo>("/api/status")
        .then((x) => {
          setS(x);
          setError(null);
        })
        .catch((e) => setError((e as Error).message));
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [version]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Configurações e status</h1>
          <p className="sub">
            Limites de segurança e alvos permitidos vêm do arquivo .env (reinicie com npm run
            restart após mudar).
          </p>
        </div>
      </div>
      {error ? <Alert kind="error">{error}</Alert> : null}
      {!s && !error ? <Loading /> : null}
      {s ? (
        <div className="stack">
          <Alert kind="warn">{s.notice}</Alert>
          <div className="grid2">
            <div className="card">
              <h2>Servidor</h2>
              <table>
                <tbody>
                  <tr>
                    <th>estado</th>
                    <td>
                      <Status kind="ok">no ar</Status> há {dur(s.uptimeMs)}
                    </td>
                  </tr>
                  <tr>
                    <th>tempo real</th>
                    <td>
                      {connected ? (
                        <Status kind="ok">conectado</Status>
                      ) : (
                        <Status kind="warn">reconectando</Status>
                      )}{" "}
                      · {s.sseClients} cliente(s)
                    </td>
                  </tr>
                  <tr>
                    <th>versão</th>
                    <td>lt {s.version}</td>
                  </tr>
                  <tr>
                    <th>runtime</th>
                    <td>
                      Node {s.node} · {s.platform} · PID {s.pid} · {s.memoryMb} MB
                    </td>
                  </tr>
                  <tr>
                    <th>execuções ativas</th>
                    <td>
                      {s.activeRuns.length ? s.activeRuns.map((a) => a.id).join(", ") : "nenhuma"}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="card">
              <h2>Limites de segurança</h2>
              <table>
                <tbody>
                  <tr>
                    <th>RPS máximo</th>
                    <td className="num">{s.limits.maxRps.toLocaleString("pt-BR")}</td>
                    <td className="muted">LT_MAX_RPS</td>
                  </tr>
                  <tr>
                    <th>conexões</th>
                    <td className="num">{s.limits.maxConnections}</td>
                    <td className="muted">LT_MAX_CONNECTIONS</td>
                  </tr>
                  <tr>
                    <th>VUs</th>
                    <td className="num">{s.limits.maxVus}</td>
                    <td className="muted">LT_MAX_VUS</td>
                  </tr>
                  <tr>
                    <th>duração</th>
                    <td className="num">{dur(s.limits.maxDurationMs)}</td>
                    <td className="muted">LT_MAX_DURATION</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="card">
              <h2>Alvos permitidos sem confirmação</h2>
              <ul style={{ margin: 0 }}>
                {s.allowedTargets.map((t) => (
                  <li key={t}>
                    <code>{t}</code>
                  </li>
                ))}
              </ul>
              <p className="muted">
                Outros hosts exigem declarar autorização e digitar o host (ALLOWED_TARGETS no .env).
              </p>
            </div>
            <div className="card">
              <h2>Armazenamento</h2>
              <table>
                <tbody>
                  <tr>
                    <th>banco</th>
                    <td>
                      <code>{s.storage.database}</code>
                    </td>
                  </tr>
                  <tr>
                    <th>relatórios</th>
                    <td>
                      <code>{s.storage.reportsDir}</code>
                    </td>
                  </tr>
                  <tr>
                    <th>cenários</th>
                    <td>{s.storage.scenarios}</td>
                  </tr>
                  <tr>
                    <th>execuções</th>
                    <td>
                      {Object.entries(s.storage.runs)
                        .map(([k, v]) => `${k}: ${v}`)
                        .join(" · ") || "nenhuma"}
                    </td>
                  </tr>
                  <tr>
                    <th>baselines</th>
                    <td>{s.storage.baselines}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="card">
              <h2>Aparência</h2>
              <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="sr-only">Tema</legend>
                {(["system", "light", "dark"] as ThemePref[]).map((t) => (
                  <label key={t} className="row" style={{ gap: 8 }}>
                    <input
                      type="radio"
                      name="theme"
                      checked={pref === t}
                      onChange={() => setPref(t)}
                    />
                    {t === "system" ? "seguir o sistema" : t === "light" ? "claro" : "escuro"}
                  </label>
                ))}
              </fieldset>
            </div>
            <div className="card">
              <h2>Integrações</h2>
              <p style={{ marginTop: 0 }}>
                Métricas Prometheus: <a href="/metrics">/metrics</a> (só em 127.0.0.1).
              </p>
              <p className="muted" style={{ marginBottom: 0 }}>
                API: <code>/api/scenarios</code>, <code>/api/runs</code>, <code>/api/compare</code>,
                eventos em <code>/api/events</code> (SSE).
              </p>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
