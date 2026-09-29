import { useSyncExternalStore } from "react";

import { container } from "../services/container";
import type { TerminalSession } from "../services/terminalService";
import { CloseIcon } from "./icons";
import { StaleTerminalBanner } from "./network/NetworkDialog";
import { XtermHost } from "./XtermHost";

interface TerminalViewProps {
  themeKind: string;
  /** Whether the Terminal tab is the one showing; the sessions stay mounted either way so scrollback survives switching tabs. */
  visible: boolean;
}

/** The Terminal tab's content: a strip of session tabs and one xterm view per session. */
export function TerminalView({ themeKind, visible }: TerminalViewProps) {
  const state = useSyncExternalStore(
    (listener) => container.terminal.subscribe(listener),
    () => container.terminal.getState(),
  );
  return (
    <div
      className={visible ? "terminal-view" : "terminal-view terminal-view--hidden"}
      aria-label="Terminal"
      role="tabpanel"
    >
      {state.sessions.length > 0 ? (
        <div className="terminal-view__tabs" role="tablist" aria-label="Terminals">
          {state.sessions.map((session) => (
            <TerminalTab
              key={session.id}
              session={session}
              active={session.id === state.activeId}
            />
          ))}
        </div>
      ) : null}
      <StaleTerminalBanner />
      <div className="terminal-view__body">
        {state.sessions.length === 0 ? (
          <div className="terminal-panel__empty">
            <button
              type="button"
              className="button button--primary"
              onClick={() => {
                container.run("terminal.new");
              }}
            >
              New Terminal
            </button>
          </div>
        ) : null}
        {state.sessions.map((session) => (
          <XtermHost
            key={session.id}
            id={session.id}
            active={session.id === state.activeId}
            themeKind={themeKind}
          />
        ))}
      </div>
    </div>
  );
}

function TerminalTab({ session, active }: { session: TerminalSession; active: boolean }) {
  const status = session.exited
    ? ` — exited${session.exitCode === null ? "" : ` (code ${String(session.exitCode)})`}`
    : "";
  return (
    <div
      className={active ? "terminal-tab terminal-tab--active" : "terminal-tab"}
      role="tab"
      aria-selected={active}
      title={`${session.cwd}${status}`}
      onClick={() => {
        container.terminal.setActive(session.id);
      }}
    >
      <span
        className={
          session.exited ? "terminal-tab__dot terminal-tab__dot--exited" : "terminal-tab__dot"
        }
        aria-hidden="true"
      />
      <span className="terminal-tab__title">{session.title}</span>
      {session.exited ? <span className="terminal-tab__status">exited</span> : null}
      <button
        type="button"
        className="terminal-tab__close"
        title="Kill Terminal"
        aria-label={`Close ${session.title}`}
        onClick={(event) => {
          event.stopPropagation();
          void container.terminal.closeTerminal(session.id);
        }}
      >
        <CloseIcon />
      </button>
    </div>
  );
}
