import { useMemo, useState, useSyncExternalStore } from "react";

import { container } from "../../services/container";
import { ResultGroups, type ResultGroupsController } from "./ResultGroups";
import { RESULT_PAGE } from "../../services/searchService";

/**
 * References found by text: every whole-word occurrence of the name, from the workspace index. This is **not** semantic
 * (comments, strings and unrelated symbols with the same name are included); when a language server is running for the
 * file, Find References uses it and shows its answer in the editor instead.
 */
export function ReferencesSection() {
  const state = useSyncExternalStore(
    (listener) => container.references.subscribe(listener),
    () => container.references.getState(),
  );
  const [collapsed, setCollapsed] = useState<readonly string[]>([]);
  const [visibleFiles, setVisibleFiles] = useState(RESULT_PAGE);
  const [expanded, setExpanded] = useState<readonly string[]>([]);
  const controller = useMemo<ResultGroupsController>(
    () => ({
      collapsed,
      visibleFiles,
      expandedFiles: expanded,
      toggle: (path) => {
        setCollapsed((now) =>
          now.includes(path) ? now.filter((p) => p !== path) : [...now, path],
        );
      },
      showMore: () => {
        setVisibleFiles((now) => now + RESULT_PAGE);
      },
      expand: (path) => {
        setExpanded((now) => (now.includes(path) ? now : [...now, path]));
      },
      open: (file, match) => {
        void container.references.open(file, match);
      },
    }),
    [collapsed, visibleFiles, expanded],
  );

  if (state.status === "idle") {
    return (
      <p className="search-view__summary">
        Put the cursor on a name in the editor and choose Go to References (Shift+F12). With a
        language server the editor shows its references; otherwise the matches of the name are
        listed here.
      </p>
    );
  }
  const count = state.outcome?.totalMatches ?? 0;
  return (
    <>
      <p className="search-view__summary" role="note">
        <strong>Text-based references</strong> for <code>{state.word}</code> — matches of the name,
        not semantic references (comments and strings included).
      </p>
      {state.status === "searching" ? (
        <p className="search-view__summary" role="status">
          Searching…
        </p>
      ) : null}
      {state.status === "error" ? (
        <p className="search-view__summary search-view__summary--error" role="alert">
          {state.error}
        </p>
      ) : null}
      {state.status === "done" ? (
        <p className="search-view__summary" role="status">
          {count === 0
            ? "No references found."
            : `${String(count)} match${count === 1 ? "" : "es"} in ${String(state.outcome?.files.length ?? 0)} file${state.outcome?.files.length === 1 ? "" : "s"}${state.source === "index" ? " · from the index" : " · read from disk (no index yet)"}${state.outcome?.truncated === true ? " (limit reached)" : ""}`}
        </p>
      ) : null}
      <ResultGroups
        files={state.outcome?.files ?? []}
        controller={controller}
        label="Reference results"
      />
    </>
  );
}
