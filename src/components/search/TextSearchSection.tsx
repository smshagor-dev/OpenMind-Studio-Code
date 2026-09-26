import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { container } from "../../services/container";
import { ResultGroups, type ResultGroupsController } from "./ResultGroups";

const TOGGLES = [
  { name: "caseSensitive", label: "Match Case", glyph: "Aa" },
  { name: "wholeWord", label: "Match Whole Word", glyph: "ab" },
  { name: "useRegex", label: "Use Regular Expression", glyph: ".*" },
] as const;

/** Full-text search of the workspace: query, options, include/exclude patterns, and results grouped by file. */
export function TextSearchSection() {
  const state = useSyncExternalStore(
    (listener) => container.search.subscribe(listener),
    () => container.search.getState(),
  );
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    return container.events.on("focusSearch", () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, []);

  return (
    <>
      <div className="search-view__query">
        <input
          ref={inputRef}
          className="search-view__input"
          type="text"
          placeholder="Search"
          aria-label="Search"
          value={state.query}
          onChange={(event) => {
            container.search.setQuery(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") void container.search.run();
            if (event.key === "Escape") container.search.cancel();
          }}
        />
        <div className="search-view__toggles">
          {TOGGLES.map((toggle) => (
            <button
              key={toggle.name}
              type="button"
              className={
                state.options[toggle.name]
                  ? "search-view__toggle search-view__toggle--on"
                  : "search-view__toggle"
              }
              title={toggle.label}
              aria-label={toggle.label}
              aria-pressed={state.options[toggle.name]}
              onClick={() => {
                container.search.toggleOption(toggle.name);
              }}
            >
              {toggle.glyph}
            </button>
          ))}
        </div>
      </div>
      <label className="search-view__label">
        files to include
        <input
          className="search-view__input"
          type="text"
          placeholder="e.g. *.ts, src/**"
          aria-label="Files to include"
          value={state.include}
          onChange={(event) => {
            container.search.setInclude(event.target.value);
          }}
        />
      </label>
      <label className="search-view__label">
        files to exclude
        <input
          className="search-view__input"
          type="text"
          placeholder="e.g. *.min.js, docs"
          aria-label="Files to exclude"
          value={state.exclude}
          onChange={(event) => {
            container.search.setExclude(event.target.value);
          }}
        />
      </label>
      <SearchSummary />
      <SearchResults />
    </>
  );
}

function SearchSummary() {
  const state = useSyncExternalStore(
    (listener) => container.search.subscribe(listener),
    () => container.search.getState(),
  );
  const cancelable = state.status === "searching";
  let text: string | null = null;
  if (state.status === "searching") text = "Searching…";
  else if (state.status === "error") text = state.error;
  else if (state.status === "done" && state.outcome) {
    const { totalMatches, files, truncated } = {
      ...state.outcome,
      files: state.outcome.files.length,
    };
    const from =
      state.source === "index"
        ? " · from the index"
        : state.source === "disk"
          ? " · read from disk (no index yet)"
          : "";
    text =
      totalMatches === 0
        ? "No results found."
        : `${String(totalMatches)} result${totalMatches === 1 ? "" : "s"} in ${String(files)} file${files === 1 ? "" : "s"}${truncated ? " (limit reached — narrow the search)" : ""}${from}`;
  }
  if (text === null) return null;
  return (
    <p
      className={
        state.status === "error"
          ? "search-view__summary search-view__summary--error"
          : "search-view__summary"
      }
      role={state.status === "error" ? "alert" : "status"}
    >
      {text}
      {cancelable ? (
        <button
          type="button"
          className="search-more search-more--inline"
          onClick={() => {
            container.search.cancel();
          }}
        >
          Cancel
        </button>
      ) : null}
      {state.status === "done" || state.status === "error" ? (
        <button
          type="button"
          className="search-more search-more--inline"
          onClick={() => {
            container.search.clear();
          }}
        >
          Clear
        </button>
      ) : null}
    </p>
  );
}

function SearchResults() {
  const state = useSyncExternalStore(
    (listener) => container.search.subscribe(listener),
    () => container.search.getState(),
  );
  const controller = useMemo<ResultGroupsController>(
    () => ({
      collapsed: state.collapsed,
      visibleFiles: state.visibleFiles,
      expandedFiles: state.expandedFiles,
      toggle: (relativePath) => {
        container.search.toggleFile(relativePath);
      },
      showMore: () => {
        container.search.showMoreFiles();
      },
      expand: (relativePath) => {
        container.search.expandMatches(relativePath);
      },
      open: (file, match) => {
        void container.search.openMatch(file, match);
      },
    }),
    [state.collapsed, state.visibleFiles, state.expandedFiles],
  );
  const files = state.outcome?.files ?? [];
  return <ResultGroups files={files} controller={controller} label="Search results" />;
}
