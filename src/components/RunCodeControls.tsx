import { useCallback, useState, useSyncExternalStore } from "react";

import { container } from "../services/container";
import { buildRunMenu } from "../services/runMenu";
import { ChevronDownSmallIcon, PlayIcon, StopIcon } from "./icons";
import { MenuPopup } from "./MenuPopup";
import { useDismissOnOutside } from "./useDismissOnOutside";

/** Re-renders when the run state or the active editor changes (the button reads both). */
function useRunView() {
  useSyncExternalStore(
    (listener) => container.runCode.subscribe(listener),
    () => container.runCode.getState(),
  );
  useSyncExternalStore(
    (listener) => container.workspace.subscribe(listener),
    () => container.workspace.getState(),
  );
  return container.runCode.buttonView();
}

/**
 * The ▶ button: runs the active file, turns into ■ while it runs (click stops
 * it), and says in its tooltip exactly why it is disabled when it is.
 */
export function RunCodeButton() {
  const view = useRunView();
  const running = view.state === "running";
  return (
    <button
      type="button"
      className={`run-button run-button--${view.state}`}
      title={view.tooltip}
      aria-label={running ? "Stop Running Code" : "Run Code"}
      aria-disabled={!view.enabled}
      disabled={!view.enabled}
      onClick={() => {
        container.run(running ? "run.stop" : "run.code");
      }}
    >
      {running ? <StopIcon /> : <PlayIcon />}
    </button>
  );
}

/** The ˅ beside the button: Run in Terminal, Show Output, Configure, Select Runtime, Stop. */
export function RunCodeDropdown() {
  useRunView();
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const close = useCallback(() => {
    setAnchor(null);
  }, []);
  useDismissOnOutside(anchor !== null, close);

  return (
    <>
      <button
        type="button"
        className="run-dropdown"
        title="Run Code options"
        aria-label="Run Code options"
        aria-haspopup="menu"
        onMouseDown={(event) => {
          event.stopPropagation();
          setAnchor(anchor ? null : event.currentTarget.getBoundingClientRect());
        }}
      >
        <ChevronDownSmallIcon />
      </button>
      {anchor ? (
        <MenuPopup
          items={buildRunMenu({
            runCode: container.runCode,
            configs: container.runConfigs,
            run: container.run,
          })}
          x={Math.max(0, anchor.right - 250)}
          y={anchor.bottom + 2}
          ariaLabel="Run Code options"
          onClose={close}
        />
      ) : null}
    </>
  );
}

/** A small result next to the button: Running…, or how the last run of this file ended. */
export function RunStatusIndicator() {
  const view = useRunView();
  const state = container.runCode.getState();
  const path = container.runCode.activeEditor()?.path ?? null;
  if (view.state === "running") {
    return (
      <span className="run-status run-status--running" role="status">
        Running…
      </span>
    );
  }
  const last = state.lastRun;
  if (last === null || path === null || last.path !== path) {
    return null;
  }
  const seconds = (last.durationMs / 1000).toFixed(2);
  if (last.stopped) {
    return (
      <span className="run-status" role="status" title={`Stopped after ${seconds}s`}>
        Stopped
      </span>
    );
  }
  const ok = last.code === 0;
  return (
    <span
      className={ok ? "run-status run-status--ok" : "run-status run-status--failed"}
      role="status"
      title={`Exited with code ${last.code === null ? "unknown" : String(last.code)} after ${seconds}s`}
    >
      {ok ? "✓ Done" : `✗ Exit ${last.code === null ? "?" : String(last.code)}`}
    </span>
  );
}
