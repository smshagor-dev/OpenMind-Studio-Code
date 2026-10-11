import { useEffect, useRef } from "react";

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel: string;
  /** `danger` (default) for destructive actions like delete; `primary` for e.g. a drag-and-drop move. */
  tone?: "danger" | "primary";
  onConfirm: () => void;
  onCancel: () => void;
  /** The cancel button's text (callers with translated dialogs pass it). */
  cancelLabel?: string;
}

/** A blocking VS Code-style confirmation modal — shown before delete and drag-and-drop move. */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  tone = "danger",
  onConfirm,
  onCancel,
  cancelLabel = "Cancel",
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  return (
    <div
      className="modal-overlay"
      onClick={onCancel}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <div
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <h2 id="confirm-dialog-title">{title}</h2>
        <p>{message}</p>
        <div className="modal__actions">
          <button
            ref={confirmRef}
            type="button"
            className={tone === "danger" ? "modal__confirm--danger" : "modal__confirm--primary"}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
          <button type="button" onClick={onCancel}>
            {cancelLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
