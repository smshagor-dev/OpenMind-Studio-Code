import { useSyncExternalStore } from "react";

import { container } from "../../services/container";

/** The open folder's project in the status bar ("Tauri + React", "No project detected"); click for the full status. */
export function LanguageStatusItem() {
  useSyncExternalStore(
    (listener) => container.language.support.subscribe(listener),
    () => container.language.support.getState(),
  );
  const summary = container.language.support.summary();
  if (summary === null) return null;
  return (
    <button
      type="button"
      className="statusbar__item"
      title="Project & Language Status — detected project, tools, language servers and commands"
      onClick={() => {
        container.run("language.showStatus");
      }}
    >
      {summary}
    </button>
  );
}
