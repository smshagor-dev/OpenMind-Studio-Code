import { useEffect, useRef, useSyncExternalStore } from "react";

import { container } from "../services/container";
import { BrowserView } from "./BrowserView";
import { CloseIcon } from "./icons";
import { shortcutFor } from "./shortcutLabel";
import { t } from "../i18n";

/**
 * VS Code's Secondary Side Bar: a card on the far side of the editor showing
 * an Output channel beside the code. Run Code opens it at half width on the
 * run's channel (the bottom panel's Output shows the same lines), or on the
 * built-in browser for an HTML page. Its sash sits on the edge facing the
 * editor. UI only — `SecondarySideBarService` and `BrowserPreviewService`
 * hold the state.
 */
export function SecondarySideBar({ onLeft }: { onLeft: boolean }) {
  const runKey = shortcutFor("run.code");
  const state = useSyncExternalStore(
    (listener) => container.secondarySideBar.subscribe(listener),
    () => container.secondarySideBar.getState(),
  );
  const output = useSyncExternalStore(
    (listener) => container.output.subscribe(listener),
    () => container.output.getState(),
  );
  const lines = useSyncExternalStore(
    (listener) => container.output.subscribe(listener),
    () => container.output.getLines(state.channel),
  );
  const browser = useSyncExternalStore(
    (listener) => container.browser.subscribe(listener),
    () => container.browser.getState(),
  );
  const showBrowser = state.view === "browser" && browser.target !== null;
  const asideRef = useRef<HTMLElement | null>(null);
  const bodyRef = useRef<HTMLPreElement | null>(null);
  const drag = useRef<{ x: number; width: number } | null>(null);

  useEffect(() => {
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [lines]);

  const channels = output.channels.includes(state.channel)
    ? output.channels
    : [...output.channels, state.channel];

  return (
    <aside
      ref={asideRef}
      className={onLeft ? "secondary-sidebar secondary-sidebar--left" : "secondary-sidebar"}
      style={state.half ? { flex: "1 1 0" } : { flex: `0 0 ${String(state.width)}px` }}
      aria-label={t("secondary.bar")}
    >
      <div
        className="secondary-sidebar__sash"
        role="separator"
        aria-orientation="vertical"
        aria-label={t("secondary.resize")}
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = {
            x: event.clientX,
            width: asideRef.current?.getBoundingClientRect().width ?? state.width,
          };
        }}
        onPointerMove={(event) => {
          const current = drag.current;
          if (!current) return;
          const delta = event.clientX - current.x;
          container.secondarySideBar.previewWidth(current.width + (onLeft ? delta : -delta));
        }}
        onPointerUp={(event) => {
          if (!drag.current) return;
          event.currentTarget.releasePointerCapture(event.pointerId);
          drag.current = null;
          void container.secondarySideBar.commitWidth();
        }}
      />
      <header className="secondary-sidebar__title">
        {browser.target === null ? (
          <h2 className="secondary-sidebar__label">{t("secondary.output")}</h2>
        ) : (
          <div className="secondary-sidebar__tabs" role="tablist" aria-label={t("secondary.bar")}>
            {(["output", "browser"] as const).map((view) => {
              const selected = view === "browser" ? showBrowser : !showBrowser;
              return (
                <button
                  key={view}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  className={
                    selected
                      ? "secondary-sidebar__tab secondary-sidebar__tab--active"
                      : "secondary-sidebar__tab"
                  }
                  onClick={() => void container.secondarySideBar.setView(view)}
                >
                  {view === "browser" ? t("secondary.browser") : t("secondary.output")}
                </button>
              );
            })}
          </div>
        )}
        {showBrowser ? null : (
          <>
            <select
              className="panel-select"
              aria-label={t("secondary.channel")}
              value={state.channel}
              onChange={(event) => void container.secondarySideBar.setChannel(event.target.value)}
            >
              {channels.map((channel) => (
                <option key={channel} value={channel}>
                  {channel}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="secondary-sidebar__action"
              title={t("secondary.clear")}
              aria-label={t("secondary.clearLabel")}
              disabled={lines.length === 0}
              onClick={() => {
                container.output.clear(state.channel);
              }}
            >
              ⌫
            </button>
          </>
        )}
        <button
          type="button"
          className="secondary-sidebar__action"
          title={t("secondary.hideTitle")}
          aria-label={t("secondary.hide")}
          onClick={() => void container.secondarySideBar.hide()}
        >
          <CloseIcon />
        </button>
      </header>
      {/* Kept mounted (only hidden) while Output is shown, so the page keeps what was typed into it. */}
      {browser.target !== null && <BrowserView hidden={!showBrowser} />}
      {showBrowser ? null : lines.length === 0 ? (
        <p className="secondary-sidebar__empty">
          No output in “{state.channel}” yet. Run a file{runKey ? ` (${runKey})` : ""} to see its
          output here and in the panel below.
        </p>
      ) : (
        <pre className="output-lines secondary-sidebar__lines" ref={bodyRef}>
          {lines.join("\n")}
        </pre>
      )}
    </aside>
  );
}
