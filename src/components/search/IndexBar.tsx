import { useSyncExternalStore } from "react";

import { container } from "../../services/container";
import { t } from "../../i18n";

/** The index's state in the Search view, with the actions that work on it. Every button says why it is off. */
export function IndexBar() {
  const state = useSyncExternalStore(
    (listener) => container.workspaceIndex.subscribe(listener),
    () => container.workspaceIndex.getState(),
  );
  const index = container.workspaceIndex;
  const label = index.label();
  if (label === "") return null;
  const status = state.status;
  const indexing = status?.state === "indexing";
  const button = (
    text: string,
    action: "start" | "rebuild" | "clear" | "cancel",
    run: () => void,
  ) => {
    const reason = index.actionReason(action);
    return (
      <button
        type="button"
        className="search-more search-more--inline"
        disabled={reason !== null || state.busy}
        title={reason ?? text}
        onClick={run}
      >
        {text}
      </button>
    );
  };
  return (
    <div className="index-bar" role="group" aria-label={t("search.index")}>
      <span
        className={
          status?.state === "error"
            ? "index-bar__label index-bar__label--error"
            : "index-bar__label"
        }
        title={index.detail()}
        role="status"
      >
        {label}
      </span>
      {indexing && status.discovered > 0 ? (
        <progress
          className="index-bar__progress"
          max={status.discovered}
          value={status.processed}
          aria-label={t("search.indexProgress")}
        />
      ) : null}
      {indexing
        ? button(t("common.cancel"), "cancel", () => {
            void index.cancel();
          })
        : button(t("common.refresh"), "start", () => {
            void index.refresh();
          })}
      {button(t("search.rebuild"), "rebuild", () => {
        void index.rebuild();
      })}
      {button(t("search.clear"), "clear", () => {
        void index.clear();
      })}
      {status?.state === "error" && status.error ? (
        <p className="search-view__summary search-view__summary--error" role="alert">
          {status.error}
        </p>
      ) : null}
    </div>
  );
}
