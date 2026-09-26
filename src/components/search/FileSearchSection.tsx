import { useEffect, useRef, useSyncExternalStore } from "react";

import { container } from "../../services/container";
import type { FileHit } from "../../services/searchIpc";
import { FileTypeIcon } from "../fileIcons";

/** Draws `text` with the character ranges `[start, end)` highlighted (offset shifts the ranges into `text`). */
export function Highlighted({
  text,
  ranges,
  offset = 0,
}: {
  text: string;
  ranges: [number, number][];
  offset?: number;
}) {
  const parts: React.ReactNode[] = [];
  let at = 0;
  const chars = Array.from(text);
  for (const [rawStart, rawEnd] of ranges) {
    const start = Math.max(rawStart - offset, at);
    const end = Math.min(rawEnd - offset, chars.length);
    if (end <= start) continue;
    if (start > at) parts.push(chars.slice(at, start).join(""));
    parts.push(<mark key={start}>{chars.slice(start, end).join("")}</mark>);
    at = end;
  }
  parts.push(chars.slice(at).join(""));
  return <>{parts}</>;
}

export function FileHitRow({ hit, onOpen }: { hit: FileHit; onOpen: () => void }) {
  const dirLength = Math.max(0, hit.relativePath.length - hit.name.length);
  const dir = hit.relativePath.slice(0, Math.max(0, dirLength - 1));
  return (
    <button type="button" className="search-hit" title={hit.path} onClick={onOpen}>
      <FileTypeIcon name={hit.name} />
      <span className="search-hit__name">
        <Highlighted text={hit.name} ranges={hit.highlights} offset={dirLength} />
      </span>
      <span className="search-hit__dir">
        <Highlighted text={dir} ranges={hit.highlights} />
      </span>
    </button>
  );
}

/** Find files by name or path: exact, prefix, substring, fuzzy letters, or a glob such as `*.php`. */
export function FileSearchSection() {
  const state = useSyncExternalStore(
    (listener) => container.fileSearch.subscribe(listener),
    () => container.fileSearch.getState(),
  );
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    input.current?.focus();
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
          placeholder="File name or path (e.g. app.ts, routes, *.php)"
          aria-label="Search files by name"
          value={state.query}
          onChange={(event) => {
            container.fileSearch.setQuery(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") void container.fileSearch.run();
            if (event.key === "Escape") container.fileSearch.clear();
          }}
        />
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
            ? "No files found."
            : `${String(state.results.length)} file${state.results.length === 1 ? "" : "s"}`}
        </p>
      ) : (
        <p className="search-view__summary">
          Type a file name and press Enter, or just start typing.
        </p>
      )}
      <ul className="search-results" aria-label="File results">
        {state.results.map((hit) => (
          <li key={hit.path}>
            <FileHitRow
              hit={hit}
              onOpen={() => {
                void container.fileSearch.open(hit);
              }}
            />
          </li>
        ))}
      </ul>
    </>
  );
}
