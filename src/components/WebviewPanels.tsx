import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";

import { container } from "../services/container";
import { prepareWebviewHtml } from "../services/webviewHtml";
import { MAX_MESSAGE_BYTES, type WebviewPanelView } from "../services/webviewService";
import "../styles/webview.css";
import { CloseIcon } from "./icons";

function newToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Messages that arrive before the page has loaded wait here, up to this many bytes. */
const MAX_PENDING_BYTES = MAX_MESSAGE_BYTES;

/**
 * One extension page in a sandboxed frame: `sandbox` without `allow-same-origin` (so the page has an opaque
 * origin: no access to this app, its storage, cookies or the disk), `allow-scripts` only when the extension asked
 * for scripts, `allow=""` (no device or clipboard features), the HTML prepared by `prepareWebviewHtml` (CSP
 * first), no referrer. Messages go through `postMessage` only: from the page only when the sender is this very
 * frame and carries this frame's token.
 */
function WebviewFrame({
  panel,
  visible,
  focusSeq,
}: {
  panel: WebviewPanelView;
  visible: boolean;
  focusSeq: number;
}) {
  const { webviews } = container.extensions;
  const frame = useRef<HTMLIFrameElement | null>(null);
  const [token] = useState(() => newToken());
  const [srcDoc, setSrcDoc] = useState<string | null>(null);
  const ready = useRef(false);
  const pending = useRef<string[]>([]);
  const focused = useRef(focusSeq);

  useEffect(() => {
    let cancelled = false;
    ready.current = false;
    void prepareWebviewHtml(panel.html, {
      enableScripts: panel.enableScripts,
      token,
      state: panel.state,
      readResource: (uri) => webviews.readResource(panel.id, uri),
    }).then((prepared) => {
      if (cancelled) return;
      setSrcDoc(prepared.html);
      webviews.recordBlocked(panel.id, prepared.blocked);
    });
    return () => {
      cancelled = true;
    };
    // The page state is only for the first draw: `setState` must not redraw the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel.id, panel.html, panel.enableScripts, panel.roots, token, webviews]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source === null || event.source !== frame.current?.contentWindow) return;
      const data: unknown = event.data;
      if (typeof data !== "object" || data === null) return;
      const message = data as Record<string, unknown>;
      if (message.omWebview !== token) return;
      if (message.type === "message" && typeof message.message === "string") {
        webviews.receive(panel.id, message.message);
      } else if (message.type === "state" && typeof message.state === "string") {
        webviews.setPageState(panel.id, message.state);
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
    };
  }, [panel.id, token, webviews]);

  useEffect(
    () =>
      webviews.onMessageToPage((id, json) => {
        if (id !== panel.id) return;
        if (ready.current) {
          frame.current?.contentWindow?.postMessage(JSON.parse(json), "*");
          return;
        }
        const size = pending.current.reduce((sum, item) => sum + item.length, json.length);
        if (size <= MAX_PENDING_BYTES) pending.current.push(json);
      }),
    [panel.id, webviews],
  );

  // A panel that was just opened, revealed or chosen takes the keyboard, so the page can be used at once.
  useEffect(() => {
    if (visible && focusSeq !== focused.current) frame.current?.focus();
    focused.current = focusSeq;
  }, [visible, focusSeq]);

  return (
    <iframe
      ref={frame}
      className="webview-frame"
      title={panel.title}
      sandbox={panel.enableScripts ? "allow-scripts" : ""}
      allow=""
      referrerPolicy="no-referrer"
      srcDoc={srcDoc ?? ""}
      hidden={!visible}
      onLoad={() => {
        ready.current = true;
        for (const json of pending.current.splice(0)) {
          frame.current?.contentWindow?.postMessage(JSON.parse(json), "*");
        }
        if (visible && focusSeq !== 0) frame.current?.focus();
      }}
    />
  );
}

function onTabKey(
  event: KeyboardEvent<HTMLDivElement>,
  index: number,
  ids: string[],
  select: (id: string) => void,
  close: (id: string) => void,
) {
  const id = ids[index];
  if (id === undefined) return;
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    select(id);
  } else if (event.key === "Delete") {
    event.preventDefault();
    close(id);
  } else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
    event.preventDefault();
    const next = ids[(index + (event.key === "ArrowRight" ? 1 : ids.length - 1)) % ids.length];
    if (next !== undefined) select(next);
  }
}

/**
 * The extensions' webview panels over the editor area, with their own tab strip. "Editors" hides them without
 * closing anything (a small "Webviews (n)" button brings them back); closing a tab disposes the panel. The frames
 * live in one place in the tree, so a panel with `retainContextWhenHidden` keeps running (and keeps its page
 * state) while hidden; any other panel is taken out of the page when it is not shown and drawn again — with
 * the state its page saved by `setState` — when it comes back.
 */
export function WebviewPanels() {
  const { webviews } = container.extensions;
  const state = useSyncExternalStore(
    (listener) => webviews.subscribe(listener),
    () => webviews.getState(),
  );
  if (state.panels.length === 0) return null;
  const active = state.panels.find((panel) => panel.id === state.activeId) ?? state.panels[0];
  const ids = state.panels.map((panel) => panel.id);
  return (
    <>
      {state.overlay ? null : (
        <button
          type="button"
          className="webview-reopen"
          title="Show the extension webview panels"
          onClick={() => {
            webviews.showOverlay();
          }}
        >
          Webviews ({state.panels.length})
        </button>
      )}
      <section className="webview-host" aria-label="Extension webviews" hidden={!state.overlay}>
        <div className="webview-host__tabbar" role="tablist" aria-label="Webview panels">
          <button
            type="button"
            className="webview-host__editors"
            title="Back to the editors (the panels stay open)"
            onClick={() => {
              webviews.hideOverlay();
            }}
          >
            Editors
          </button>
          {state.panels.map((panel, index) => {
            const isActive = panel.id === active?.id;
            return (
              <div
                key={panel.id}
                role="tab"
                tabIndex={isActive ? 0 : -1}
                aria-selected={isActive}
                className={isActive ? "tab tab--active" : "tab"}
                title={`${panel.title} (${panel.extension})`}
                onClick={() => {
                  webviews.setActive(panel.id);
                }}
                onKeyDown={(event) => {
                  onTabKey(
                    event,
                    index,
                    ids,
                    (id) => {
                      webviews.setActive(id);
                    },
                    (id) => {
                      webviews.close(id);
                    },
                  );
                }}
              >
                <span className="tab__label">{panel.title || panel.viewType}</span>
                <button
                  type="button"
                  className="tab__close webview-host__close"
                  aria-label={`Close ${panel.title}`}
                  tabIndex={-1}
                  onClick={(event) => {
                    event.stopPropagation();
                    webviews.close(panel.id);
                  }}
                >
                  <CloseIcon />
                </button>
              </div>
            );
          })}
        </div>
        {active && active.blocked.length > 0 ? (
          <div className="webview-host__blocked" role="status">
            <strong>Some content was blocked.</strong> Remote content and files outside the panel's
            local resource roots are never loaded.
            <ul>
              {active.blocked.slice(0, 5).map((line) => (
                <li key={line}>{line}</li>
              ))}
              {active.blocked.length > 5 ? (
                <li>…and {active.blocked.length - 5} more (see the Extension Host output).</li>
              ) : null}
            </ul>
          </div>
        ) : null}
        <div className="webview-host__body">
          {state.panels.map((panel) => {
            const shown = state.overlay && panel.id === active?.id;
            return shown || panel.retain ? (
              <WebviewFrame
                key={panel.id}
                panel={panel}
                visible={shown}
                focusSeq={state.focusSeq}
              />
            ) : null;
          })}
        </div>
      </section>
    </>
  );
}
