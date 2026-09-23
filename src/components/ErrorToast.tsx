export interface ToastMessage {
  id: number;
  message: string;
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
        <div key={toast.id} className="error-toast">
          <span className="error-toast__message">{toast.message}</span>
          <button
            type="button"
            className="error-toast__dismiss"
            aria-label="Dismiss"
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
