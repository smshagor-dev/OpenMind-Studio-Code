import { useCallback, useRef, useState, useSyncExternalStore } from "react";

import { container } from "../services/container";
import type { TerminalSession } from "../services/terminalService";
import { CloseIcon } from "./icons";
import { MenuPopup } from "./MenuPopup";
import { useDismissOnOutside } from "./useDismissOnOutside";
import { XtermHost } from "./XtermHost";

interface TerminalPanelProps {
  themeKind: string;
}

/** The bottom panel: tab list, "new terminal" with a shell selector, and one xterm view per session. */
export function TerminalPanel({ themeKind }: TerminalPanelProps) {
  const state = useSyncExternalStore(
    (listener) => container.terminal.subscribe(listener),
    () => container.terminal.getState(),
  );
  const [shellMenu, setShellMenu] = useState<DOMRect | null>(null);
  const closeShellMenu = useCallback(() => {
    setShellMenu(null);
  }, []);
  useDismissOnOutside(shellMenu !== null, closeShellMenu);
  const drag = useRef<{ y: number; height: number } | null>(null);

  // Sessions stay mounted while the panel is hidden so scrollback survives Ctrl+`.
  if (!state.panelVisible && state.sessions.length === 0) {
    return null;
  }

  return (
    <section
      className={state.panelVisible ? "terminal-panel" : "terminal-panel terminal-panel--hidden"}
      style={{ height: state.panelHeight }}
      aria-label="Terminal panel"
    >
      <div
        className="terminal-panel__sash"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize terminal panel"
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { y: event.clientY, height: state.panelHeight };
        }}
        onPointerMove={(event) => {
          if (drag.current) {
            container.terminal.previewPanelHeight(
              drag.current.height + (drag.current.y - event.clientY),
            );
          }
        }}
        onPointerUp={(event) => {
          if (!drag.current) return;
          event.currentTarget.releasePointerCapture(event.pointerId);
          drag.current = null;
          void container.terminal.commitPanelHeight();
        }}
      />
      <div className="terminal-panel__header">
        <div className="terminal-panel__tabs" role="tablist" aria-label="Terminals">
          {state.sessions.map((session) => (
            <TerminalTab
              key={session.id}
              session={session}
              active={session.id === state.activeId}
            />
          ))}
        </div>
        <div className="terminal-panel__actions">
          <button
            type="button"
            className="terminal-panel__action"
            title="New Terminal"
            aria-label="New Terminal"
            onClick={() => {
              container.run("terminal.new");
            }}
          >
            +
          </button>
          {state.shells.length > 1 ? (
            <button
              type="button"
              className="terminal-panel__action"
              title="Launch Profile..."
              aria-label="Select shell for new terminal"
              onMouseDown={(event) => {
                event.stopPropagation();
                setShellMenu(shellMenu ? null : event.currentTarget.getBoundingClientRect());
              }}
            >
              ▾
            </button>
          ) : null}
          <button
            type="button"
            className="terminal-panel__action"
            title="Clear Terminal"
            aria-label="Clear Terminal"
            disabled={state.activeId === null}
            onClick={() => {
              container.run("terminal.clear");
            }}
          >
            ⌫
          </button>
          <button
            type="button"
            className="terminal-panel__action"
            title="Hide Panel"
            aria-label="Hide Panel"
            onClick={() => {
              void container.terminal.hidePanel();
            }}
          >
            <CloseIcon />
          </button>
        </div>
      </div>
      <div className="terminal-panel__body">
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
      {shellMenu ? <ShellMenu anchor={shellMenu} onClose={closeShellMenu} /> : null}
    </section>
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

function ShellMenu({ anchor, onClose }: { anchor: DOMRect; onClose: () => void }) {
  const shells = container.terminal.getState().shells;
  return (
    <MenuPopup
      items={shells.map((shell) => ({
        kind: "item" as const,
        label: shell.label,
        enabled: true,
        onSelect: () => {
          container.run("terminal.new", shell.kind);
        },
      }))}
      x={anchor.left}
      y={anchor.top - shells.length * 26 - 8}
      ariaLabel="Shells"
      onClose={onClose}
      autoFocus
    />
  );
}
