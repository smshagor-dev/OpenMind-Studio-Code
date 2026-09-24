import { useEffect, useRef, useSyncExternalStore } from "react";

import { container } from "../services/container";
import type { SearchFileMatches, SearchLineMatch } from "../services/ipc";
import { FileTypeIcon } from "./fileIcons";
import { ChevronIcon } from "./icons";

const TOGGLES = [
  { name: "caseSensitive", label: "Match Case", glyph: "Aa" },
  { name: "wholeWord", label: "Match Whole Word", glyph: "ab" },
  { name: "useRegex", label: "Use Regular Expression", glyph: ".*" },
] as const;

/** The Search side bar view: query, options, include/exclude patterns, and results grouped by file. */
export function SearchView() {
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
    <div className="search-view">
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
    </div>
  );
}

function SearchSummary() {
  const state = useSyncExternalStore(
    (listener) => container.search.subscribe(listener),
    () => container.search.getState(),
  );
  let text: string | null = null;
  if (state.status === "searching") text = "Searching…";
  else if (state.status === "error") text = state.error;
  else if (state.status === "done" && state.outcome) {
    const { totalMatches, files, truncated } = {
      ...state.outcome,
      files: state.outcome.files.length,
    };
    text =
      totalMatches === 0
        ? "No results found."
        : `${String(totalMatches)} result${totalMatches === 1 ? "" : "s"} in ${String(files)} file${files === 1 ? "" : "s"}${truncated ? " (limit reached — narrow the search)" : ""}`;
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
    </p>
  );
}

function SearchResults() {
  const state = useSyncExternalStore(
    (listener) => container.search.subscribe(listener),
    () => container.search.getState(),
  );
  const files = state.outcome?.files ?? [];
  if (files.length === 0) return null;
  return (
    <ul className="search-results" aria-label="Search results">
      {files.map((file) => (
        <FileResult
          key={file.path}
          file={file}
          collapsed={state.collapsed.includes(file.relativePath)}
        />
      ))}
    </ul>
  );
}

function directoryOf(relativePath: string): string {
  const slash = relativePath.lastIndexOf("/");
  return slash === -1 ? "" : relativePath.slice(0, slash);
}

function FileResult({ file, collapsed }: { file: SearchFileMatches; collapsed: boolean }) {
  const name = file.relativePath.slice(file.relativePath.lastIndexOf("/") + 1);
  return (
    <li className="search-file">
      <button
        type="button"
        className="search-file__header"
        aria-expanded={!collapsed}
        title={file.path}
        onClick={() => {
          container.search.toggleFile(file.relativePath);
        }}
      >
        <ChevronIcon expanded={!collapsed} />
        <FileTypeIcon name={name} />
        <span className="search-file__name">{name}</span>
        <span className="search-file__dir">{directoryOf(file.relativePath)}</span>
        <span className="search-file__count">{file.matches.length}</span>
      </button>
      {collapsed ? null : (
        <ul>
          {file.matches.map((match, index) => (
            <li key={`${String(match.line)}:${String(match.column)}:${String(index)}`}>
              <MatchRow file={file} match={match} />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function MatchRow({ file, match }: { file: SearchFileMatches; match: SearchLineMatch }) {
  // Highlight offsets are UTF-16 units, exactly what string slicing uses.
  const before = match.preview.slice(0, match.previewStart);
  const hit = match.preview.slice(match.previewStart, match.previewEnd);
  const after = match.preview.slice(match.previewEnd);
  return (
    <button
      type="button"
      className="search-match"
      title={`Line ${String(match.line)}, column ${String(match.column)}`}
      onClick={() => {
        void container.search.openMatch(file, match);
      }}
    >
      <span className="search-match__text">
        {before}
        <mark>{hit}</mark>
        {after}
      </span>
    </button>
  );
}
