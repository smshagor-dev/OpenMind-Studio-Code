import { useEffect, useRef, useSyncExternalStore } from "react";

import "../../styles/agent.css";

import type { Todo } from "../../services/agent/agentIpc";
import { agent } from "../../services/agent";
import { container } from "../../services/container";
import { useT } from "../../i18n";
import { AgentPermission } from "./AgentPermission";
import { AgentPrompt } from "./AgentPrompt";
import { AgentSetup } from "./AgentSetup";
import { AgentSpinner } from "./AgentSpinner";
import { AgentTranscript, AgentWelcome } from "./AgentTranscript";

function useAgent() {
  return useSyncExternalStore(
    (listener) => agent.subscribe(listener),
    () => agent.getState(),
  );
}

function useFolder(): string | null {
  return useSyncExternalStore(
    (listener) => container.workspace.subscribe(listener),
    () => container.workspace.getActiveWorkspace()?.path ?? null,
  );
}

function Todos({ items }: { items: Todo[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="agent-todos agent-enter">
      {items.map((item, index) => (
        <li key={index} className={`agent-todo agent-todo--${item.status}`}>
          <span className="agent-todo__box" aria-hidden="true">
            {item.status === "completed" ? "☒" : "☐"}
          </span>
          <span className="agent-todo__text">{item.content}</span>
        </li>
      ))}
    </ul>
  );
}

function Header() {
  const t = useT();
  const state = useAgent();
  const model = state.overview?.models.find((m) => m.id === state.modelId);
  const { transcript } = state;
  return (
    <div className="agent-header">
      <button
        type="button"
        className="agent-model-chip"
        title={t("agent.header.models")}
        onClick={() => { agent.openSetup(!state.showSetup); }}
      >
        <span className="agent-model-chip__star" aria-hidden="true">
          ✻
        </span>
        <span className="agent-model-chip__name">{model ? `${model.name} · ${model.quant}` : t("agent.header.noModel")}</span>
        <span aria-hidden="true">▾</span>
      </button>
      <div className="agent-header__actions">
        {transcript.canUndo && !transcript.busy ? (
          <button type="button" className="agent-icon-button" title={t("agent.header.undo")} onClick={() => void agent.undo()}>
            ↶
          </button>
        ) : null}
        <button
          type="button"
          className="agent-icon-button"
          title={t("agent.header.newChat")}
          disabled={transcript.entries.length === 0}
          onClick={() => void agent.newChat()}
        >
          ＋
        </button>
      </div>
    </div>
  );
}

/** The OpenMindAI Agent side bar view: setup until a model is ready, then the conversation (Claude Code's layout). */
export function AgentView() {
  const t = useT();
  const state = useAgent();
  const folder = useFolder();
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    void agent.start();
  }, []);
  const { transcript } = state;
  useEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [transcript]);

  if (!state.overview) {
    return (
      <div className="agent-view agent-view--empty">
        {state.overviewError ? (
          <div className="agent-notice agent-notice--error">{state.overviewError}</div>
        ) : (
          <div className="agent-view__loading">{t("agent.loading")}</div>
        )}
      </div>
    );
  }
  const ready = agent.ready();
  if (!ready || state.showSetup) {
    return (
      <div className="agent-view">
        {ready ? <Header /> : null}
        <div className="agent-view__scroll">
          <AgentSetup
            overview={state.overview}
            downloads={state.downloads}
            modelId={state.modelId}
            installing={state.installingEngine}
            canClose={ready}
          />
        </div>
      </div>
    );
  }
  const share =
    transcript.contextTokens > 0 ? Math.round((transcript.promptTokens / transcript.contextTokens) * 100) : null;
  return (
    <div
      className="agent-view"
      onKeyDown={(event) => {
        // Esc anywhere in the panel interrupts the agent, as in Claude Code.
        if (event.key === "Escape" && transcript.busy && !transcript.permission) void agent.stop();
      }}
    >
      <Header />
      <div
        ref={scroller}
        className="agent-view__scroll"
        onScroll={(event) => {
          const el = event.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {transcript.entries.length === 0 ? <AgentWelcome folder={folder} /> : null}
        <AgentTranscript entries={transcript.entries} busy={transcript.busy} />
        {transcript.busy && !transcript.permission ? (
          <AgentSpinner phase={transcript.phase} startedAt={transcript.startedAt} tokens={transcript.outputTokens} />
        ) : null}
      </div>
      <div className="agent-view__bottom">
        <Todos items={transcript.todos} />
        {transcript.permission ? (
          <AgentPermission request={transcript.permission} onAnswer={(decision) => void agent.answer(decision)} />
        ) : (
          <AgentPrompt
            mode={state.mode}
            busy={transcript.busy}
            disabledReason={folder ? null : t("agent.blocker.noFolder")}
            contextShare={share}
          />
        )}
      </div>
    </div>
  );
}
