import { useEffect, useRef, type ReactNode } from "react";
import type { RunRow } from "../api";

export function Status({
  kind,
  children,
}: {
  kind: "ok" | "fail" | "warn" | "run";
  children: ReactNode;
}) {
  const icon = { ok: "✓", fail: "✗", warn: "!", run: "●" }[kind];
  return (
    <span className={`status ${kind}`}>
      <span aria-hidden="true">{icon}</span>
      {children}
    </span>
  );
}

/** Estado de uma execução com ícone + texto (cor nunca sozinha). */
export function RunStatus({
  run,
}: {
  run: Pick<RunRow, "status" | "invalid" | "thresholdsPassed" | "thresholdsTotal">;
}) {
  if (run.status === "running") return <Status kind="run">em andamento</Status>;
  if (run.status === "failed") return <Status kind="fail">falhou</Status>;
  if (run.status === "interrupted") return <Status kind="warn">interrompida</Status>;
  if (run.invalid) return <Status kind="fail">inválida</Status>;
  if (run.thresholdsTotal && (run.thresholdsPassed ?? 0) < run.thresholdsTotal)
    return <Status kind="fail">reprovada</Status>;
  return <Status kind="ok">aprovada</Status>;
}

export function Alert({
  kind,
  children,
}: {
  kind: "error" | "warn" | "info";
  children: ReactNode;
}) {
  return (
    <div className={`alert ${kind}`} role={kind === "error" ? "alert" : "status"}>
      <span className="icon" aria-hidden="true">
        {kind === "info" ? "i" : kind === "warn" ? "!" : "✗"}
      </span>
      <div>{children}</div>
    </div>
  );
}

export function Tile({
  label,
  value,
  note,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
}) {
  return (
    <div className="tile">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {note ? <div className="note">{note}</div> : null}
    </div>
  );
}

export function Loading({ what = "carregando" }: { what?: string }) {
  return (
    <div className="skeleton" role="status" aria-live="polite">
      {what}…
    </div>
  );
}

/** Diálogo modal acessível baseado em <dialog> (foco preso, Esc fecha). */
export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby="modal-title">
      <div className="body">
        <h2 id="modal-title">{title}</h2>
        {children}
      </div>
      <div className="foot">{footer}</div>
    </dialog>
  );
}
