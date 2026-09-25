import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { container } from "../services/container";
import { prepareWebviewHtml } from "../services/webviewHtml";
import type { WebviewPanelView } from "../services/webviewService";
import "../styles/webview.css";
import { CloseIcon } from "./icons";

function newToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * One extension page in a sandboxed frame: `sandbox` without `allow-same-origin` (so the page has an opaque
 * origin: no access to this app, its storage, cookies or the disk), `allow-scripts` only when the extension asked
 * for scripts, the HTML prepared by `prepareWebviewHtml` (CSP first), no referrer. Messages go through
 * `postMessage` only: from the page only when the sender is this very frame and carries this frame's token.
 */
function WebviewFrame({ panel, visible }: { panel: WebviewPanelView; visible: boolean }) {
  const { webviews } = container.extensions;
  const frame = useRef<HTMLIFrameElement | null>(null);
  const [token] = useState(() => newToken());
  const [srcDoc, setSrcDoc] = useState<string | null>(null);
  const ready = useRef(false);
  const pending = useRef<string[]>([]);

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
        if (ready.current) frame.current?.contentWindow?.postMessage(JSON.parse(json), "*");
        else pending.current.push(json);
      }),
    [panel.id, webviews],
  );

  return (
    <iframe
      ref={frame}
      className="webview-frame"
      title={panel.title}
      sandbox={panel.enableScripts ? "allow-scripts" : ""}
      referrerPolicy="no-referrer"
      srcDoc={srcDoc ?? ""}
      style={visible ? undefined : { display: "none" }}
      onLoad={() => {
        ready.current = true;
        for (const json of pending.current.splice(0)) {
          frame.current?.contentWindow?.postMessage(JSON.parse(json), "*");
        }
      }}
    />
  );
}

/**
 * The extensions' webview panels over the editor area, with their own tab strip. "Editors" hides them without
 * closing anything (a small "Webviews" button brings them back); closing a tab disposes the panel.
 */
export function WebviewPanels() {
  const { webviews } = container.extensions;
  const state = useSyncExternalStore(
    (listener) => webviews.subscribe(listener),
    () => webviews.getState(),
  );
  if (state.panels.length === 0) return null;
  if (!state.overlay) {
    const retained = state.panels.filter((panel) => panel.retain);
    return (
      <>
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
        <div className="webview-retained" aria-hidden="true">
          {retained.map((panel) => (
            <WebviewFrame key={panel.id} panel={panel} visible={false} />
          ))}
        </div>
      </>
    );
  }
  const active = state.panels.find((panel) => panel.id === state.activeId) ?? state.panels[0];
  return (
    <section className="webview-host" aria-label="Extension webviews">
      <div className="webview-host__tabbar" role="tablist">
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
        {state.panels.map((panel) => (
          <div
            key={panel.id}
            role="tab"
            aria-selected={panel.id === active?.id}
            className={panel.id === active?.id ? "tab tab--active" : "tab"}
            title={`${panel.title} (${panel.extension})`}
            onClick={() => {
              webviews.setActive(panel.id);
            }}
          >
            <span className="tab__label">{panel.title || panel.viewType}</span>
            <button
              type="button"
              className="tab__close"
              aria-label={`Close ${panel.title}`}
              onClick={(event) => {
                event.stopPropagation();
                webviews.close(panel.id);
              }}
            >
              <CloseIcon />
            </button>
          </div>
        ))}
      </div>
      {active && active.blocked.length > 0 ? (
        <div className="webview-host__blocked" role="status">
          <strong>Some content was blocked.</strong> Remote content and files outside the panel's
          local resource roots are never loaded.
          <ul>
            {active.blocked.slice(0, 5).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="webview-host__body">
        {state.panels.map((panel) =>
          panel.id === active?.id || panel.retain ? (
            <WebviewFrame key={panel.id} panel={panel} visible={panel.id === active?.id} />
          ) : null,
        )}
      </div>
    </section>
  );
}
