import { useEffect, useSyncExternalStore } from "react";

import "../../styles/ai.css";

import { container } from "../../services/container";
import { ProviderForm } from "./ProviderForm";
import { ProviderList } from "./ProviderList";

/** The AI provider manager: add, edit, test, enable/disable, delete providers; clear the history. */
export function AiProviderManager() {
  const ui = useSyncExternalStore(
    (listener) => container.ai.ui.subscribe(listener),
    () => container.ai.ui.getState(),
  );
  useEffect(() => {
    if (!ui.managerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") container.ai.ui.closeManager();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
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
        className="modal modal--wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-manager-title"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <h2 id="ai-manager-title">AI Providers</h2>
        {ui.editing === null ? <ProviderList /> : <ProviderForm key={ui.editing} id={ui.editing} />}
      </div>
    </div>
  );
}
