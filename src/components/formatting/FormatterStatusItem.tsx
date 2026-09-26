import { useSyncExternalStore } from "react";

import { container } from "../../services/container";
import { statusText } from "../../services/formatting/formattingService";

/**
 * The formatter of the file in front ("JSON — Built-in JSON formatter", "Python — Black missing, Ruff missing") in the
 * status bar. A lookup only: nothing runs until Format Document. Click for the list with each formatter's source and
 * reason.
 */
export function FormatterStatusItem() {
  const { status } = useSyncExternalStore(
    container.formatting.subscribe,
    container.formatting.getState,
  );
  if (status === null) return null;
  const text = statusText(status);
  const reason = status.selected === null && status.reason !== null ? ` ${status.reason}` : "";
  return (
    <button
      type="button"
      className="statusbar__item"
      title={`Formatter — ${text}.${reason} Click for the list.`}
      onClick={() => {
        container.run("format.showStatus");
      }}
    >
      {status.selected === null ? `⚠ ${text}` : text}
    </button>
  );
}
