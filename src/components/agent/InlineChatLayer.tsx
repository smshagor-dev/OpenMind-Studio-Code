import type * as monaco from "monaco-editor";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { MonacoDiffHost } from "../../editor/MonacoDiffHost";
import { MONACO_THEME_MAP } from "../../editor/monacoThemes";
import { t, useT } from "../../i18n";
import { inlineChat } from "../../services/editorMenu";
import type { InlineChatState } from "../../services/agent/inlineChat";
import "../../styles/gitViews.css";
import "../../styles/sourceControl.css";

/**
 * Reserves room under the selection (a view zone) and places a widget there (an overlay widget that follows the
 * zone), the way Monaco's own peek view does: a view zone's own node sits under the text layer and can't take input.
 */
function useZone(state: InlineChatState | null): HTMLElement | null {
  const editor = state?.editor as monaco.editor.IStandaloneCodeEditor | undefined;
  const afterLine = state?.range.endLineNumber ?? 0;
  // One host node per chat; React renders into it while the effect below places it in the editor.
  const widgetNode = useMemo(() => {
    if (!editor) return null;
    const node = document.createElement("div");
    node.className = "inline-chat-host";
    return node;
  }, [editor]);
  useEffect(() => {
    if (!editor || !widgetNode) return;
    const spacer = document.createElement("div");
    let zoneId = "";
    let height = 120;
    const zone: monaco.editor.IViewZone = {
      afterLineNumber: afterLine,
      heightInPx: height,
      domNode: spacer,
      onDomNodeTop: (top) => {
        const layout = editor.getLayoutInfo();
        widgetNode.style.top = `${String(top)}px`;
        widgetNode.style.left = `${String(layout.contentLeft)}px`;
        widgetNode.style.width = `${String(Math.max(200, layout.contentWidth - layout.verticalScrollbarWidth - 16))}px`;
      },
    };
    const widget: monaco.editor.IOverlayWidget = {
      getId: () => "openmind.inlineChat",
      getDomNode: () => widgetNode,
      getPosition: () => null,
    };
    editor.addOverlayWidget(widget);
    editor.changeViewZones((accessor) => {
      zoneId = accessor.addZone(zone);
    });
    const resize = new ResizeObserver(() => {
      const next = Math.ceil(widgetNode.getBoundingClientRect().height) + 4;
      if (next === height || next <= 4) return;
      height = next;
      zone.heightInPx = next;
      editor.changeViewZones((accessor) => {
        accessor.layoutZone(zoneId);
      });
    });
    resize.observe(widgetNode);
    editor.revealLineInCenterIfOutsideViewport(afterLine);
    // The input takes the keyboard once the widget is in the editor (the panel's own effect ran before that).
    const focus = requestAnimationFrame(() => {
      widgetNode.querySelector("input")?.focus();
    });
    return () => {
      cancelAnimationFrame(focus);
      resize.disconnect();
      editor.changeViewZones((accessor) => {
        accessor.removeZone(zoneId);
      });
      editor.removeOverlayWidget(widget);
    };
  }, [editor, afterLine, widgetNode]);
  return widgetNode;
}

function Actions({ proposed, working, disabled, onSend }: { proposed: boolean; working: boolean; disabled: boolean; onSend: () => void }) {
  if (working) {
    return (
      <button type="button" className="file-git-view__button" onClick={() => void inlineChat.cancel()}>
        {t("inlineChat.stop")}
      </button>
    );
  }
  return (
    <>
      <button type="button" className="file-git-view__button" disabled={disabled} onClick={onSend}>
        {t(proposed ? "inlineChat.refine" : "inlineChat.send")}
      </button>
      {proposed ? (
        <>
          <button type="button" className="file-git-view__button" onClick={() => { inlineChat.accept(); }}>
            {t("inlineChat.accept")}
          </button>
          <button type="button" className="file-git-view__button" onClick={() => { inlineChat.reject(); }}>
            {t("inlineChat.reject")}
          </button>
        </>
      ) : (
        <button
          type="button"
          className="file-git-view__close"
          aria-label={t("gitView.close")}
          title={t("gitView.close")}
          onClick={() => { inlineChat.reject(); }}
        >
          ×
        </button>
      )}
    </>
  );
}

function Panel({ state, themeKind }: { state: InlineChatState; themeKind: string }) {
  const [instruction, setInstruction] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, [state.status]);
  const working = state.status === "working";
  const proposed = state.proposal !== null;
  const send = () => {
    if (instruction.trim().length === 0) return;
    void inlineChat.submit(instruction);
    setInstruction("");
  };
  const model = state.editor.getModel();
  return (
    <div
      className="inline-chat"
      role="dialog"
      aria-label={t("inlineChat.label")}
      onKeyDown={(event) => {
        // Keys typed here belong to the panel, not to the editor or the app's shortcuts.
        event.stopPropagation();
        if (event.key === "Escape") {
          if (working) void inlineChat.cancel();
          else inlineChat.reject();
        }
      }}
    >
      <div className="inline-chat__row">
        <input
          ref={inputRef}
          className="inline-chat__input"
          value={instruction}
          disabled={working}
          placeholder={t(proposed ? "inlineChat.refinePlaceholder" : "inlineChat.placeholder")}
          aria-label={t("inlineChat.instruction")}
          onChange={(event) => {
            setInstruction(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey) return;
            event.preventDefault();
            if (event.ctrlKey && proposed) inlineChat.accept();
            else send();
          }}
        />
        <Actions proposed={proposed} working={working} disabled={instruction.trim() === ""} onSend={send} />
      </div>
      {working ? (
        <span className="inline-chat__status" role="status">
          {t("inlineChat.working")}
        </span>
      ) : null}
      {state.error ? (
        <span className="inline-chat__error" role="alert">
          {state.error}
        </span>
      ) : null}
      {proposed && model ? (
        <div className="inline-chat__diff">
          <MonacoDiffHost
            original={state.original}
            modified={state.proposal}
            path={model.uri.path}
            theme={MONACO_THEME_MAP[themeKind] ?? "openmind-dark"}
            inline
          />
        </div>
      ) : null}
    </div>
  );
}

/** Inline chat under the selection of the editor it was opened in (Ctrl+I). */
export function InlineChatLayer({ themeKind }: { themeKind: string }) {
  useT();
  const state = useSyncExternalStore(
    (listener) => inlineChat.subscribe(listener),
    () => inlineChat.getState(),
  );
  const node = useZone(state);
  if (state === null || node === null) return null;
  return createPortal(<Panel state={state} themeKind={themeKind} />, node);
}
