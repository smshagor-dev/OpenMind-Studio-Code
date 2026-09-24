import { useSyncExternalStore } from "react";

import { statusBarText } from "../services/lspAvailability";
import { container } from "../services/container";

/** The status bar's language server indicator for the file in front (hidden for files no server handles). */
export function LspStatusItem() {
  useSyncExternalStore(
    (listener) => container.lsp.subscribe(listener),
    () => container.lsp.getState(),
  );
  const status = statusBarText(container.lsp.activeFileStatus());
  if (status === null) return null;
  return (
    <button
      type="button"
      className="statusbar__item"
      title={status.ok ? `${status.text} — Language Tools` : `${status.text} Open Language Tools.`}
      onClick={() => {
        container.run("lsp.manage");
      }}
    >
      {status.ok ? "✓ " : "⚠ "}
      {status.text}
    </button>
  );
}
