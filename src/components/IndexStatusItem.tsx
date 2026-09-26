import { useSyncExternalStore } from "react";

import { container } from "../services/container";

/** The search index in the status bar: building (with progress), ready, off or in error. Click for the Files search. */
export function IndexStatusItem() {
  useSyncExternalStore(
    (listener) => container.workspaceIndex.subscribe(listener),
    () => container.workspaceIndex.getState(),
  );
  const index = container.workspaceIndex;
  const label = index.label();
  if (label === "") return null;
  return (
    <button
      type="button"
      className="statusbar__item"
      title={`${index.detail()} — open the Search view`}
      onClick={() => {
        container.run("search.showFiles");
      }}
    >
      {label}
    </button>
  );
}
