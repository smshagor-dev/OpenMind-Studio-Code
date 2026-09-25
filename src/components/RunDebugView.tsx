import { useState, useSyncExternalStore } from "react";

import { container } from "../services/container";
import { runSummary } from "../services/debugModel";
import "../styles/debug.css";
import { BreakpointsPane, CallStackPane, VariablesPane, WatchPane } from "./DebugPanes";
import { PaneSection } from "./PaneSection";
import { withShortcut } from "./shortcutLabel";

/** The Run and Debug side bar: start controls with the reason when they can't, then the debugger's panes. */
export function RunDebugView() {
  useSyncExternalStore(
    (listener) => container.debug.subscribe(listener),
    () => container.debug.getState(),
  );
  useSyncExternalStore(
    (listener) => container.workspace.subscribe(listener),
    () => container.workspace.getState(),
  );
  const debug = container.debug;
  const run = debug.getState().run;
  const active = debug.isDebugging();
  const availability = debug.startState();
  const configs = container.debugConfigs.configsFor(
    activePath(),
    container.workspace.getActiveWorkspace()?.path ?? null,
  );
  const [open, setOpen] = useState({
    variables: true,
    watch: true,
    stack: true,
    breakpoints: true,
  });
  const toggle = (key: keyof typeof open) => {
    setOpen((previous) => ({ ...previous, [key]: !previous[key] }));
  };

  return (
    <div className="debug-view">
      <div className="debug-view__start">
        {active && run ? (
          <p className="debug-status" role="status">
            <strong>{run.configName}</strong> — {runSummary(run)}
          </p>
        ) : (
          <>
            {configs.length > 0 ? (
              <select
                className="debug-config"
                aria-label="Launch configuration"
                onChange={(event) => {
                  container.debugConfigs.choose(event.target.value);
                }}
              >
                {configs.map((config) => (
                  <option key={config.name} value={config.name}>
                    {config.name}
                  </option>
                ))}
              </select>
            ) : null}
            <div className="debug-view__buttons">
              <button
                type="button"
                className="debug-start"
                disabled={!availability.enabled}
                title={
                  availability.enabled
                    ? withShortcut("Start Debugging", "debug.start")
                    : availability.reason
                }
                onClick={() => {
                  void debug.start();
                }}
              >
                ▶ Start Debugging
              </button>
              <button
                type="button"
                disabled={!container.commands.isEnabled("debug.runWithoutDebugging")}
                title={
                  container.commands.isEnabled("debug.runWithoutDebugging")
                    ? withShortcut("Run Code without the debugger", "run.code")
                    : container.commands.reasonFor("debug.runWithoutDebugging")
                }
                onClick={() => {
                  container.run("debug.runWithoutDebugging");
                }}
              >
                Run Without Debugging
              </button>
            </div>
            {!availability.enabled && availability.reason ? (
              <p className="debug-reason" role="status">
                {availability.reason}
              </p>
            ) : null}
            {availability.installKind ? (
              <button
                type="button"
                className="debug-install"
                title="Download and install the debugger with the Runtime Manager"
                onClick={() => {
                  const kind = availability.installKind;
                  if (kind) void container.runtime.install(kind, null);
                }}
              >
                Install Debugger
              </button>
            ) : null}
            {run?.state === "terminated" && run.error ? (
              <p className="debug-reason">{run.error}</p>
            ) : null}
          </>
        )}
      </div>
      <PaneSection
        title="Variables"
        expanded={open.variables}
        onToggle={() => {
          toggle("variables");
        }}
      >
        <VariablesPane />
      </PaneSection>
      <PaneSection
        title="Watch"
        expanded={open.watch}
        onToggle={() => {
          toggle("watch");
        }}
      >
        <WatchPane />
      </PaneSection>
      <PaneSection
        title="Call Stack"
        expanded={open.stack}
        onToggle={() => {
          toggle("stack");
        }}
      >
        <CallStackPane />
      </PaneSection>
      <PaneSection
        title="Breakpoints"
        expanded={open.breakpoints}
        onToggle={() => {
          toggle("breakpoints");
        }}
      >
        <BreakpointsPane />
      </PaneSection>
    </div>
  );
}

function activePath(): string | null {
  const id = container.workspace.getState().activeId;
  if (id === null || !container.documents.has(id)) return null;
  return container.documents.snapshot(id).path;
}
