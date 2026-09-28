import { t } from "../i18n";
export interface ToastMessage {
  id: number;
  message: string;
  /** `info` = a plain notice (a file was reloaded); the default is an error. */
  kind?: "info";
}

interface ErrorToastProps {
  toasts: ToastMessage[];
  onDismiss: (id: number) => void;
}

/** Renders caught, non-fatal errors (see `services/safely.ts`) as dismissible toasts. */
export function ErrorToast({ toasts, onDismiss }: ErrorToastProps) {
  if (toasts.length === 0) {
    return null;
  }

  return (
    <div className="error-toast-stack" role="alert" aria-live="assertive">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={toast.kind === "info" ? "error-toast error-toast--info" : "error-toast"}
          role={toast.kind === "info" ? "status" : undefined}
        >
          <span className="error-toast__message">{toast.message}</span>
          <button
            type="button"
            className="error-toast__dismiss"
            aria-label={t("common.dismiss")}
            onClick={() => {
              onDismiss(toast.id);
            }}
          >
            &times;
          </button>
        </div>
      ))}
    </div>
  );
}
