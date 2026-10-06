import { useEffect, useState } from "react";
import {
  ApiError,
  api,
  dur,
  type ActiveRun,
  type TargetConfirmation,
  type ValidateResult,
} from "../api";
import { go } from "../router";
import { Alert, Modal } from "./ui";

/**
 * Confirma e inicia uma execução. Alvos fora da allowlist exigem declarar autorização e digitar o
 * host — o mesmo contrato do CLI (--i-own-this-target + confirmação).
 */
export function RunDialog({
  open,
  scenarioId,
  summary,
  onClose,
}: {
  open: boolean;
  scenarioId: string;
  summary: ValidateResult["summary"] | null;
  onClose: () => void;
}) {
  const [workers, setWorkers] = useState("auto");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<TargetConfirmation | null>(null);
  const [owner, setOwner] = useState(false);
  const [typed, setTyped] = useState("");

  useEffect(() => {
    if (open) {
      setError(null);
      setConfirm(null);
      setOwner(false);
      setTyped("");
    }
  }, [open]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const run = await api<ActiveRun>("/api/runs", {
        body: {
          scenarioId,
          workers: workers === "auto" ? "auto" : Number(workers),
          ...(confirm ? { iOwnThisTarget: owner, confirmTarget: typed } : {}),
        },
      });
      onClose();
      go(`/ao-vivo/${encodeURIComponent(run.id)}`);
    } catch (e) {
      if (e instanceof ApiError && e.body.code === "target_confirmation_required") {
        setConfirm(e.body as unknown as TargetConfirmation);
        if (e.body.needs === "mismatch") setError("O host digitado não confere.");
      } else if (e instanceof ApiError && e.body.code === "invalid_scenario") {
        setError("O cenário salvo tem erros de validação. Corrija e salve antes de executar.");
      } else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const needsConfirm = !!confirm;
  const canStart = !busy && (!needsConfirm || (owner && typed.trim().length > 0));

  return (
    <Modal
      open={open}
      title="Executar cenário"
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className="primary" disabled={!canStart} onClick={start}>
            {busy ? "Iniciando…" : needsConfirm ? "Confirmar e executar" : "Executar"}
          </button>
        </>
      }
    >
      {summary ? (
        <table style={{ marginBottom: 12 }}>
          <tbody>
            <tr>
              <th>alvo</th>
              <td>
                <code>{summary.baseUrl}</code>
              </td>
            </tr>
            <tr>
              <th>modelo</th>
              <td>
                {summary.model === "open"
                  ? "aberto (taxa de chegada)"
                  : "fechado (usuários virtuais)"}
              </td>
            </tr>
            <tr>
              <th>carga</th>
              <td>
                {summary.model === "open"
                  ? `pico de ${summary.peakRps} rps`
                  : `até ${summary.peakVus} VUs`}{" "}
                por {dur(summary.durationMs)}
              </td>
            </tr>
            <tr>
              <th>thresholds</th>
              <td>{summary.thresholds.length ? summary.thresholds.join(" · ") : "nenhum"}</td>
            </tr>
          </tbody>
        </table>
      ) : (
        <Alert kind="warn">Não foi possível resumir o cenário (há erros de validação?).</Alert>
      )}
      <label className="field">
        Threads geradoras (workers)
        <select value={workers} onChange={(e) => setWorkers(e.target.value)}>
          <option value="auto">automático (pela carga)</option>
          {[1, 2, 4, 8].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      {confirm ? (
        <div className="stack" style={{ marginTop: 14 }}>
          <Alert kind="warn">
            <strong>Alvo fora da allowlist:</strong> {confirm.target.host} (
            {confirm.target.addresses.join(", ") || "sem IP"}).
            <br />
            {confirm.notice}
          </Alert>
          <label className="row" style={{ gap: 8 }}>
            <input type="checkbox" checked={owner} onChange={(e) => setOwner(e.target.checked)} />
            Sou dono deste sistema ou tenho autorização por escrito para testá-lo.
          </label>
          <label className="field">
            Digite o host para confirmar: <strong>{confirm.target.host}</strong>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        </div>
      ) : null}
      {error ? (
        <div style={{ marginTop: 12 }}>
          <Alert kind="error">{error}</Alert>
        </div>
      ) : null}
    </Modal>
  );
}
