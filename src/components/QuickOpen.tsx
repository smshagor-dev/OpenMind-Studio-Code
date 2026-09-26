import { useEffect, useRef, useSyncExternalStore } from "react";

import { container } from "../services/container";
import "../styles/search.css";
import { Highlighted } from "./search/FileSearchSection";
import { FileTypeIcon } from "./fileIcons";

/**
 * Go to File (Ctrl+P) and Go to Symbol in Workspace (Ctrl+T): one query box, the matches below, arrow keys and Enter.
 * All searching is done by the file and symbol search services; this only draws the picker.
 */
export function QuickOpen() {
  const { quickOpen } = container;
  const state = useSyncExternalStore(
    (listener) => quickOpen.subscribe(listener),
    () => quickOpen.getState(),
  );
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (state.open) input.current?.focus();
  }, [state.open, state.mode]);
  if (!state.open) return null;

  const items = quickOpen.items();
  const empty = quickOpen.emptyMessage();
  const title = state.mode === "files" ? "Go to File" : "Go to Symbol in Workspace";
  return (
    <div
      className="quick-open__scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) quickOpen.close();
      }}
    >
      <div className="quick-open" role="dialog" aria-label={title}>
        <input
          ref={input}
          className="quick-open__input"
          type="text"
          role="combobox"
          aria-expanded
          aria-controls="quick-open-list"
          aria-label={title}
          placeholder={
            state.mode === "files"
              ? "Go to file by name or path (e.g. app.ts, routes, *.php)"
              : "Go to symbol in workspace (e.g. startServer, UserController)"
          }
          value={quickOpen.query()}
          onChange={(event) => {
            quickOpen.setQuery(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              quickOpen.move(1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              quickOpen.move(-1);
            } else if (event.key === "Enter") {
              event.preventDefault();
              void quickOpen.accept();
            } else if (event.key === "Escape") {
              event.preventDefault();
              quickOpen.close();
            }
          }}
        />
        {empty !== null ? (
          <p className="quick-open__empty" role="status">
            {empty}
          </p>
        ) : (
          <ul
            id="quick-open-list"
            className="quick-open__list"
            role="listbox"
            aria-label={`${title} results`}
          >
            {items.map((item, index) => (
              <li
                key={item.key}
                role="option"
                aria-selected={index === state.selected}
                className={
                  index === state.selected
                    ? "quick-open__row quick-open__row--selected"
                    : "quick-open__row"
                }
                onMouseMove={() => {
                  quickOpen.select(index);
                }}
                onClick={() => {
                  void quickOpen.accept(index);
                }}
              >
                <FileTypeIcon name={item.iconName} />
                <span className="quick-open__label">
                  <Highlighted
                    text={item.label}
                    ranges={item.highlights}
                    offset={item.description === "" ? 0 : item.description.length + 1}
                  />
                </span>
                {item.kind === null ? null : <span className="quick-open__kind">{item.kind}</span>}
                <span className="quick-open__description">{item.description}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
