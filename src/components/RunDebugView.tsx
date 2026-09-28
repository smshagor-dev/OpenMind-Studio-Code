import { useEffect, useState, useSyncExternalStore } from "react";

import { container } from "../services/container";
import { runSummary } from "../services/debugModel";
import "../styles/debug.css";
import { BreakpointsPane, CallStackPane, VariablesPane, WatchPane } from "./DebugPanes";
import { LoadedItemsPane } from "./LoadedItemsPane";
import { PaneSection } from "./PaneSection";
import { withShortcut } from "./shortcutLabel";
import { t } from "../i18n";

function activePath(): string | null {
  const id = container.workspace.getState().activeId;
  if (id === null || !container.documents.has(id)) return null;
  return container.documents.snapshot(id).path;
}

/** The configuration picker: built-in and launch.json configurations, what can't run named with its reason. */
function ConfigPicker() {
  const configs = container.debugConfigs;
  const state = useSyncExternalStore(
    (listener) => configs.subscribe(listener),
    () => configs.getState(),
  );
  const path = activePath();
  const workspace = container.workspace.getActiveWorkspace()?.path ?? null;
  const entries = configs.entries(path, workspace);
  const current = configs.currentEntry(path, workspace);
  const debuggers = configs.extensionDebuggers();
  const notes = current?.notes ?? [];
  return (
    <>
      {entries.length > 0 ? (
        <select
          className="debug-config"
          aria-label={t("debug.launchConfiguration")}
          value={current?.id ?? ""}
          onFocus={() => {
            void configs.refresh(activePath());
          }}
          onChange={(event) => {
            configs.choose(event.target.value);
          }}
        >
          {entries.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.problem ? "⚠ " : ""}
              {entry.name} — {entry.sourceLabel}
            </option>
          ))}
        </select>
      ) : (
        <p className="debug-empty">
          {t("debug.nothingToDebug")}
        </p>
      )}
      {notes.length > 0 ? (
        <details className="debug-notes">
          <summary>
            {t("debug.unusedSettings", { count: notes.length })}
          </summary>
          <ul>
            {notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {state.fileErrors.map((error) => (
        <p key={error} className="debug-reason" role="alert">
          {error}
        </p>
      ))}
      {debuggers.length > 0 ? (
        <p className="debug-note">
          {t("debug.extensionDebuggers", {
            list: debuggers.map((d) => `${d.label ?? d.kind} (${d.extension})`).join(", "),
          })}
        </p>
      ) : null}
    </>
  );
}

function StartControls() {
  const debug = container.debug;
  const run = debug.getState().run;
  const availability = debug.startState();
  const configurable = container.commands.isEnabled("debug.openConfigurations");
  return (
    <>
      <ConfigPicker />
      <div className="debug-view__buttons">
        <button
          type="button"
          className="debug-start"
          disabled={!availability.enabled}
          title={
            availability.enabled
              ? withShortcut(t("debug.start"), "debug.start")
              : availability.reason
          }
          onClick={() => {
            void debug.start();
          }}
        >
          ▶ {t("debug.start")}
        </button>
        <button
          type="button"
          disabled={!container.commands.isEnabled("debug.runWithoutDebugging")}
          title={
            container.commands.isEnabled("debug.runWithoutDebugging")
              ? withShortcut(t("debug.runWithoutTitle"), "run.code")
              : container.commands.reasonFor("debug.runWithoutDebugging")
          }
          onClick={() => {
            container.run("debug.runWithoutDebugging");
          }}
        >
          {t("debug.runWithout")}
        </button>
        <button
          type="button"
          disabled={!configurable}
          title={
            configurable
              ? t("debug.openLaunchJson")
              : container.commands.reasonFor("debug.openConfigurations")
          }
          onClick={() => {
            container.run("debug.openConfigurations");
          }}
        >
          launch.json
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
          title={t("debug.installTitle")}
          onClick={() => {
            const kind = availability.installKind;
            if (kind) void container.runtime.install(kind, null);
          }}
        >
          {t("debug.install")}
        </button>
      ) : null}
      {run?.state === "terminated" && run.error ? (
        <p className="debug-reason">{run.error}</p>
      ) : null}
    </>
  );
}

type PaneKey = "variables" | "watch" | "stack" | "breakpoints" | "loaded";

/** The Run and Debug side bar: configuration and start controls (with the reason when they can't), then the panes. */
export function RunDebugView() {
  useSyncExternalStore(
    (listener) => container.debug.subscribe(listener),
    () => container.debug.getState(),
  );
  useSyncExternalStore(
    (listener) => container.workspace.subscribe(listener),
    () => container.workspace.getState(),
  );
  // The start controls follow the chosen configuration (its readiness or why it can't run).
  useSyncExternalStore(
    (listener) => container.debugConfigs.subscribe(listener),
    () => container.debugConfigs.getState(),
  );
  useEffect(() => {
    void container.debugConfigs.refresh(activePath());
  }, []);
  const debug = container.debug;
  const run = debug.getState().run;
  const [open, setOpen] = useState<Record<PaneKey, boolean>>({
    variables: true,
    watch: true,
    stack: true,
    breakpoints: true,
    loaded: false,
  });
  const toggler = (key: PaneKey) => () => {
    setOpen((previous) => ({ ...previous, [key]: !previous[key] }));
  };
  const abilities = run?.capabilities;
  const canList =
    debug.isDebugging() && (abilities?.loadedSources === true || abilities?.modules === true);
  return (
    <div className="debug-view">
      <div className="debug-view__start">
        {debug.isDebugging() && run ? (
          <p className="debug-status" role="status">
            <strong>{run.configName}</strong> — {runSummary(run)}
          </p>
        ) : (
          <StartControls />
        )}
      </div>
      <PaneSection title={t("debug.pane.variables")} expanded={open.variables} onToggle={toggler("variables")}>
        <VariablesPane />
      </PaneSection>
      <PaneSection title={t("debug.pane.watch")} expanded={open.watch} onToggle={toggler("watch")}>
        <WatchPane />
      </PaneSection>
      <PaneSection title={t("debug.pane.callStack")} expanded={open.stack} onToggle={toggler("stack")}>
        <CallStackPane />
      </PaneSection>
      <PaneSection
        title={t("debug.pane.breakpoints")}
        expanded={open.breakpoints}
        onToggle={toggler("breakpoints")}
      >
        <BreakpointsPane />
      </PaneSection>
      {canList ? (
        <PaneSection
          title={abilities.loadedSources ? t("debug.pane.loadedScripts") : t("debug.pane.modules")}
          expanded={open.loaded}
          onToggle={toggler("loaded")}
        >
          <LoadedItemsPane />
        </PaneSection>
      ) : null}
    </div>
  );
}
