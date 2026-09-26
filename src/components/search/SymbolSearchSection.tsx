import { useEffect, useRef, useSyncExternalStore } from "react";

import { container } from "../../services/container";
import { SYMBOL_KINDS } from "../../services/symbolSearchService";
import type { SymbolHit } from "../../services/searchIpc";
import { FileTypeIcon } from "../fileIcons";

export function SymbolHitRow({ hit, onOpen }: { hit: SymbolHit; onOpen: () => void }) {
  return (
    <button
      type="button"
      className="search-hit"
      title={`${hit.path}:${String(hit.line)}:${String(hit.column)}`}
      onClick={onOpen}
    >
      <FileTypeIcon name={hit.relativePath} />
      <span className="search-hit__name">{hit.name}</span>
      <span className="search-hit__kind">{hit.kind}</span>
      <span className="search-hit__dir">
        {hit.container === null ? "" : `${hit.container} · `}
        {`${hit.relativePath}:${String(hit.line)}`}
      </span>
    </button>
  );
}

/**
 * Symbols of the whole workspace (functions, classes, methods, headings…). They come from the workspace index and are
 * read with simple line-based patterns, so the list is a good guide, not a guarantee.
 */
export function SymbolSearchSection() {
  const state = useSyncExternalStore(
    (listener) => container.symbolSearch.subscribe(listener),
    () => container.symbolSearch.getState(),
  );
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    input.current?.focus();
    void container.symbolSearch.run();
    return container.events.on("focusSearch", () => {
      input.current?.focus();
    });
  }, []);
  return (
    <>
      <div className="search-view__query">
        <input
          ref={input}
          className="search-view__input"
          type="text"
          placeholder="Symbol name (e.g. startServer, UserController)"
          aria-label="Search symbols"
          value={state.query}
          onChange={(event) => {
            container.symbolSearch.setQuery(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") void container.symbolSearch.run();
            if (event.key === "Escape") container.symbolSearch.clear();
          }}
        />
        <select
          className="search-view__select"
          aria-label="Symbol kind"
          value={state.kind ?? ""}
          onChange={(event) => {
            container.symbolSearch.setKind(event.target.value === "" ? null : event.target.value);
          }}
        >
          <option value="">All kinds</option>
          {SYMBOL_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </select>
      </div>
      {state.status === "error" ? (
        <p className="search-view__summary search-view__summary--error" role="alert">
          {state.error}
        </p>
      ) : state.status === "searching" ? (
        <p className="search-view__summary" role="status">
          Searching…
        </p>
      ) : state.status === "done" ? (
        <p className="search-view__summary" role="status">
          {state.results.length === 0
            ? "No symbols found."
            : `${String(state.results.length)} symbol${state.results.length === 1 ? "" : "s"}`}
        </p>
      ) : null}
      <ul className="search-results" aria-label="Symbol results">
        {state.results.map((hit) => (
          <li key={`${hit.path}:${String(hit.line)}:${String(hit.column)}:${hit.name}`}>
            <SymbolHitRow
              hit={hit}
              onOpen={() => {
                void container.symbolSearch.open(hit);
              }}
            />
          </li>
        ))}
      </ul>
    </>
  );
}
