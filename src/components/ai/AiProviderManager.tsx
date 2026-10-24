import { useEffect, useRef, useSyncExternalStore } from "react";

import "../../styles/ai.css";

import { container } from "../../services/container";
import { ProviderForm } from "./ProviderForm";
import { ProviderList } from "./ProviderList";
import { t } from "../../i18n";
import { CloseIcon } from "../icons";

/** The AI provider manager: add, edit, test, enable/disable, delete providers; clear the history. */
export function AiProviderManager() {
  const dialogRef = useRef<HTMLDivElement>(null);
  const ui = useSyncExternalStore(
    (listener) => container.ai.ui.subscribe(listener),
    () => container.ai.ui.getState(),
  );
  useEffect(() => {
    if (!ui.managerOpen) return;
    const previous = document.activeElement;
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      const dialogs = document.querySelectorAll(
        '[role="dialog"], [role="alertdialog"]',
      );
      const dialog = dialogRef.current;
      if (!dialog || dialogs[dialogs.length - 1] !== dialog) return;
      if (event.key === "Escape") container.ai.ui.closeManager();
      if (event.key !== "Tab") return;
      const controls = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex="0"]',
        ),
      ).filter((element) => element.getClientRects().length > 0);
      const first = controls[0],
        last = controls.at(-1);
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          document.activeElement === dialogRef.current)
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          document.activeElement === dialogRef.current)
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, [ui.managerOpen]);
  if (!ui.managerOpen) return null;
  return (
    <div
      className="modal-overlay"
      onClick={() => {
        container.ai.ui.closeManager();
      }}
    >
      <div
        className="modal modal--wide ai-manager"
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-manager-title"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <header className="ai-manager__header">
          <span className="ai-manager__mark" aria-hidden="true">
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path d="M7 18a5 5 0 0 1-1-9.9A6.5 6.5 0 0 1 18.5 9 4.5 4.5 0 0 1 18 18H7Z" />
              <path d="m10 11-2 3h4l-2 3m5-6v6" />
            </svg>
          </span>
          <div>
            <h2 id="ai-manager-title">{t("ai.providers")}</h2>
            <p>{t("ai.cloud.subtitle")}</p>
          </div>
          <button
            type="button"
            className="ai-manager__close"
            aria-label={t("common.close")}
            onClick={() => {
              container.ai.ui.closeManager();
            }}
          >
            <CloseIcon />
          </button>
        </header>
        <div className="ai-manager__body">
          {ui.editing === null ? (
            <ProviderList />
          ) : (
            <ProviderForm key={ui.editing} id={ui.editing} />
          )}
        </div>
      </div>
    </div>
  );
}
