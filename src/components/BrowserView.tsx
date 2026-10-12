import { useEffect, useRef, useSyncExternalStore } from "react";

import { container } from "../services/container";
import type { ConsoleLevel } from "../services/browserPreview/browserPreviewService";
import { t } from "../i18n";
import "../styles/browser.css";

const LEVEL_ICON: Record<ConsoleLevel, string> = {
  log: "",
  debug: "",
  info: "ⓘ",
  warn: "⚠",
  error: "⊗",
};

/**
 * The built-in browser inside the secondary side bar: an address bar (Reload, the page's address, Open in Browser,
 * Console), the page in a frame, and the page's console below it. UI only — `BrowserPreviewService` holds the state.
 *
 * The page is served from 127.0.0.1, another origin than the app, so it can't reach the app's DOM or its commands
 * (Tauri refuses calls from origins without a capability). `allow-same-origin` gives the page its *own* origin (its
 * storage, `fetch` of its own files); top navigation, popups and downloads stay blocked. Only messages from this
 * frame's window and the server's origin are read.
 */
export function BrowserView() {
  const state = useSyncExternalStore(
    (listener) => container.browser.subscribe(listener),
    () => container.browser.getState(),
  );
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const consoleRef = useRef<HTMLDivElement | null>(null);
  const target = state.target;

  useEffect(() => {
    if (target === null) return undefined;
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (frame === null || event.source !== frame.contentWindow || event.origin !== target.origin)
        return;
      container.browser.receive(event.data);
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
    };
  }, [target]);

  useEffect(() => {
    const list = consoleRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [state.entries]);

  if (target === null) {
    return <p className="secondary-sidebar__empty">{t("browser.empty")}</p>;
  }
  const { errors, warnings } = container.browser.counts();
  const address = state.address || target.path;
  return (
    <div className="browser-view">
      <div className="browser-view__bar">
        <button
          type="button"
          className="secondary-sidebar__action"
          title={t("browser.reload")}
          aria-label={t("browser.reload")}
          onClick={() => {
            container.browser.reload();
          }}
        >
          ⟳
        </button>
        <input
          className="browser-view__address"
          aria-label={t("browser.address")}
          title={target.origin + address}
          value={address}
          readOnly
          onFocus={(event) => {
            event.currentTarget.select();
          }}
        />
        <button
          type="button"
          className="secondary-sidebar__action"
          title={t("browser.openExternal")}
          aria-label={t("browser.openExternal")}
          onClick={() => void container.browser.openExternal()}
        >
          ↗
        </button>
        <button
          type="button"
          className={
            state.consoleOpen
              ? "secondary-sidebar__action browser-view__toggle--on"
              : "secondary-sidebar__action"
          }
          title={t("browser.console")}
          aria-label={t("browser.console")}
          aria-pressed={state.consoleOpen}
          onClick={() => {
            container.browser.toggleConsole();
          }}
        >
          ≡
        </button>
      </div>
      {state.loading ? <div className="browser-view__progress" role="progressbar" /> : null}
      <iframe
        key={state.loadToken}
        ref={frameRef}
        className="browser-view__frame"
        title={state.title || t("browser.title")}
        src={state.src || target.url}
        sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-pointer-lock"
        allow="fullscreen"
        referrerPolicy="no-referrer"
        onLoad={() => {
          container.browser.frameLoaded();
        }}
      />
      {state.consoleOpen ? (
        <section className="browser-view__console" aria-label={t("browser.console")}>
          <header className="browser-view__console-head">
            <span className="browser-view__console-title">{t("browser.console")}</span>
            {errors > 0 ? (
              <span className="browser-view__count browser-view__count--error">⊗ {errors}</span>
            ) : null}
            {warnings > 0 ? (
              <span className="browser-view__count browser-view__count--warn">⚠ {warnings}</span>
            ) : null}
            <button
              type="button"
              className="secondary-sidebar__action"
              title={t("browser.clearConsole")}
              aria-label={t("browser.clearConsole")}
              disabled={state.entries.length === 0}
              onClick={() => {
                container.browser.clearConsole();
              }}
            >
              ⌫
            </button>
          </header>
          <div className="browser-view__lines" ref={consoleRef} role="log">
            {state.entries.length === 0 ? (
              <p className="browser-view__hint">{t("browser.consoleEmpty")}</p>
            ) : (
              state.entries.map((entry) => (
                <div
                  key={entry.id}
                  className={`browser-view__line browser-view__line--${entry.level}`}
                >
                  <span className="browser-view__icon" aria-hidden="true">
                    {LEVEL_ICON[entry.level]}
                  </span>
                  <span className="browser-view__text">{entry.text}</span>
                </div>
              ))
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}
