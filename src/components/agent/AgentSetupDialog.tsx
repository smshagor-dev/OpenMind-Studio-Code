import { useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { agent } from "../../services/agent";
import { useT } from "../../i18n";
import { AgentSettings } from "./AgentSettings";
import { AgentSetup } from "./AgentSetup";
import "../../styles/agent.css";

/** Mounted in the editor column even when the Agent sidebar is hidden. */
export function AgentSetupDialog() {
  const t = useT();
  const state = useSyncExternalStore((listener) => agent.subscribe(listener), () => agent.getState());
  const open = state.showSetup || state.showSettings;
  const close = () => { agent.openSetup(false); agent.openSettings(false); };
  const anchor = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const dialog = panel.current;
    const editor = anchor.current?.parentElement;
    const previous = document.activeElement;
    const position = () => {
      const rect = editor?.getBoundingClientRect();
      if (!dialog || !rect || rect.width === 0) return;
      dialog.style.left = `${rect.left + rect.width / 2}px`;
      dialog.style.top = `${rect.top + rect.height / 2}px`;
      dialog.style.maxHeight = `${Math.max(160, rect.height - 32)}px`;
      dialog.style.width = `${Math.min(600, Math.max(240, rect.width - 32))}px`;
    };
    position();
    dialog?.focus();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(position);
    if (editor) observer?.observe(editor);
    window.addEventListener("resize", position);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", position);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [open]);
  return (
    <>
      <span ref={anchor} hidden />
      {open ? createPortal(
        <div className="modal-overlay agent-setup-overlay" onClick={() => { close(); }}>
          <div ref={panel} className="agent-setup-dialog" role="dialog" aria-modal="true" aria-labelledby="agent-setup-title" tabIndex={-1}
            onClick={(event) => { event.stopPropagation(); }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                close();
              }
              if (event.key !== "Tab") return;
              const buttons = panel.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]");
              const first = buttons?.[0];
              const last = buttons?.[buttons.length - 1];
              if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
                event.preventDefault(); last?.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault(); first?.focus();
              }
            }}>
            <div className="agent-setup-dialog__header">
              <h2 id="agent-setup-title"><span className="agent-welcome__star" aria-hidden="true">✻</span> OpenMindAI Agent</h2>
              <button type="button" className="agent-icon-button" aria-label={t("agent.setup.close")} onClick={() => { close(); }}>✕</button>
            </div>
            {state.setupError ? <p className="agent-notice agent-notice--error" role="alert">{state.setupError}</p> : null}
            {state.overview && state.overviewError ? <p className="agent-notice agent-notice--error" role="alert">{state.overviewError}</p> : null}
            {state.showSettings ? <AgentSettings /> : state.overview ? <AgentSetup overview={state.overview} downloads={state.downloads} modelId={state.modelId} installing={state.installingEngine} /> : (
              <div className="agent-view__loading">
                {state.overviewError ? t("agent.ui.operationFailed") : t("agent.loading")}
                <button type="button" className="button button--secondary" onClick={() => void agent.refresh()}>{t("agent.ui.retry")}</button>
              </div>
            )}
            <div className="agent-setup-dialog__footer">
              <span role="status">{agent.ready() ? t(`agent.ui.${state.engineState}`) : t("agent.ui.notConfigured")}</span>
              {agent.ready() && state.engineState !== "ready" && state.engineState !== "loading" ? (
                <button type="button" className="button button--secondary" onClick={() => void agent.activate()}>{t("agent.ui.retry")}</button>
              ) : null}
              <button type="button" className="button button--primary" onClick={() => { close(); }}>{t("agent.ui.done")}</button>
            </div>
          </div>
        </div>, document.body,
      ) : null}
    </>
  );
}
