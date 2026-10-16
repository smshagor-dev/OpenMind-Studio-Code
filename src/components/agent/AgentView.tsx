import { useEffect, useRef, useSyncExternalStore } from "react";

import "../../styles/agent.css";
import "../../styles/agentMedia.css";
import "../../styles/agentChat.css";

import type { Todo } from "../../services/agent/agentIpc";
import { agent } from "../../services/agent";
import { container } from "../../services/container";
import { useT } from "../../i18n";
import agentLogo from "../../assets/openmindai-agent.png";
import { AgentHistoryView } from "./AgentHistoryView";
import { AgentCommandPanel } from "./AgentCommandPanel";
import { AgentQueue } from "./AgentQueue";
import { AgentPermission } from "./AgentPermission";
import { AgentPrompt } from "./AgentPrompt";
import { agentTier } from "../../services/agent/agentBrand";
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
    (listener) => container.workspace.subscribeWorkspace(listener),
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
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (
        agent.getState().engineState !== "loading" &&
        !agent.getState().transcript.busy
      )
        void agent.refresh();
    }, 15_000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);
  return (
    <div className="agent-header">
      <button
        type="button"
        className="agent-model-chip"
        title={t("agent.ui.configure")}
        onClick={() => {
          agent.openSetup(!state.showSetup);
        }}
      >
        <span
          className={
            state.engineState === "ready" && agent.ready()
              ? "agent-live agent-live--ready"
              : "agent-live"
          }
          role="status"
          aria-label={t(`agent.ui.${state.engineState}`)}
          title={t(`agent.ui.${state.engineState}`)}
        />
        <img className="agent-header__logo" src={agentLogo} alt="" />
        <span className="agent-model-chip__name">OpenMindAI Agent</span>
        {model && agent.ready() ? (
          <span className="agent-tier">{agentTier(model)}</span>
        ) : null}
      </button>
      <div className="agent-header__actions">
        <button
          type="button"
          className="agent-icon-button"
          title={t("agent.history.title")}
          onClick={() => void agent.showHistory(!state.showHistory)}
        >
          ◷
        </button>
        <button
          type="button"
          className="agent-icon-button"
          title={t("agent.settings.title")}
          onClick={() => {
            agent.openSettings(true);
          }}
        >
          ⚙
        </button>
        {transcript.canUndo && !transcript.busy ? (
          <button
            type="button"
            className="agent-icon-button"
            title={t("agent.header.undo")}
            onClick={() => void agent.undo()}
          >
            ↶
          </button>
        ) : null}
        <button
          type="button"
          className="agent-icon-button"
          title={t("agent.header.newChat")}
          disabled={
            transcript.entries.length === 0 && !state.taskState?.tasks.length
          }
          onClick={() => void agent.newChat()}
        >
          +
        </button>
      </div>
    </div>
  );
}

/** The OpenMindAI Agent side bar view: setup until a model is ready, then the branded conversation. */
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
    if (
      element &&
      !state.showHistory &&
      pinned.current &&
      state.options?.autoScroll !== false
    )
      element.scrollTop = element.scrollHeight;
  }, [transcript, state.options?.autoScroll, state.showHistory]);
  useEffect(() => {
    if (state.showHistory && scroller.current) scroller.current.scrollTop = 0;
  }, [state.showHistory]);

  if (!state.overview) {
    return (
      <div className="agent-view agent-view--empty">
        {state.overviewError ? (
          <div className="agent-notice agent-notice--error">
            {state.overviewError}
          </div>
        ) : (
          <div className="agent-view__loading">{t("agent.loading")}</div>
        )}
      </div>
    );
  }
  const ready = agent.ready();
  if (!ready) {
    return (
      <div className="agent-view">
        <Header />
        {state.showHistory ? (
          <AgentHistoryView items={state.history ?? []} />
        ) : null}
        <div className="agent-unconfigured">
          <span className="agent-welcome__star" aria-hidden="true">
            ✻
          </span>
          <div>{t("agent.ui.notConfigured")}</div>
          <button
            type="button"
            className="button button--primary"
            onClick={() => {
              agent.openSetup(true);
            }}
          >
            {t("agent.ui.configureNow")}
          </button>
        </div>
        <AgentPrompt
          mode={state.mode}
          busy={false}
          disabledReason={t("agent.ui.notConfigured")}
          contextShare={null}
        />
        {state.commandPanel ? (
          <AgentCommandPanel panel={state.commandPanel} />
        ) : null}
      </div>
    );
  }
  const share =
    transcript.contextTokens > 0
      ? Math.round((transcript.promptTokens / transcript.contextTokens) * 100)
      : null;
  return (
    <div
      className="agent-view"
      onKeyDown={(event) => {
        // Esc anywhere in the panel interrupts the agent, as in Claude Code.
        if (event.key === "Escape" && transcript.busy && !transcript.permission)
          void agent.stop();
      }}
    >
      <Header />
      <div className="agent-acceleration" role="status">
        {t("agent.gpu.status", {
          mode:
            state.overview.acceleration?.[1] != null
              ? state.overview.acceleration[1] > 0
                ? "GPU"
                : "CPU"
              : state.overview.acceleration?.[0] === false
                ? "CPU"
                : "Auto",
          layers: state.overview.acceleration?.[1] ?? "—",
          vram: (
            state.overview.hardware.gpus.reduce(
              (sum, gpu) => sum + gpu.vramBytes,
              0,
            ) /
            1024 ** 3
          ).toFixed(1),
        })}
      </div>
      <div
        ref={scroller}
        className={
          transcript.entries.length === 0 && !state.showHistory
            ? "agent-view__scroll agent-view__scroll--welcome"
            : "agent-view__scroll"
        }
        onScroll={(event) => {
          const el = event.currentTarget;
          pinned.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {state.showHistory ? (
          <AgentHistoryView items={state.history ?? []} />
        ) : (
          <>
            {transcript.entries.length === 0 ? (
              <AgentWelcome folder={folder} />
            ) : null}
            <AgentTranscript
              entries={transcript.entries}
              busy={transcript.busy}
              showReasoning={state.options?.showReasoning}
            />
            {transcript.busy && !transcript.permission ? (
              <AgentSpinner
                phase={transcript.phase}
                startedAt={transcript.startedAt}
                tokens={transcript.outputTokens}
              />
            ) : null}
          </>
        )}
      </div>
      <div className="agent-view__bottom">
        {state.goal ? (
          <div className="agent-goal" role="status">
            <span>
              Goal · {state.goal.state}: {state.goal.text}
            </span>
            {state.goal.state === "active" ? (
              <button
                type="button"
                onClick={() => void agent.runCommand("/goal pause")}
              >
                Pause goal
              </button>
            ) : state.goal.state === "paused" ? (
              <button
                type="button"
                onClick={() => void agent.runCommand("/goal resume")}
              >
                Resume goal
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void agent.runCommand("/goal clear")}
            >
              Clear goal
            </button>
          </div>
        ) : null}
        <Todos items={transcript.todos} />
        <AgentQueue state={state.taskState} />
        {transcript.permission ? (
          <AgentPermission
            request={transcript.permission}
            onAnswer={(decision) => void agent.answer(decision)}
          />
        ) : null}
        <AgentPrompt
          mode={state.mode}
          busy={transcript.busy || !!state.taskState?.activeId}
          disabledReason={null}
          contextShare={share}
        />
      </div>
      {state.commandPanel ? (
        <AgentCommandPanel panel={state.commandPanel} />
      ) : null}
    </div>
  );
}
