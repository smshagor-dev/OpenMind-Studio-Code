import { BreakpointService } from "./breakpointService";
import { CallStackService } from "./callStackService";
import { DebugConfigurationService } from "./debugConfigurationService";
import { DebugConsoleService } from "./debugConsoleService";
import { registerDebugEditorBinding } from "./debugEditorBinding";
import { parseEvaluate } from "./debugModel";
import { DebugService } from "./debugService";
import type { DocumentService } from "./documentService";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { IpcClient } from "./ipc";
import type { LayoutService } from "./layoutService";
import type { PanelService } from "./panelService";
import type { SettingsService } from "./settingsService";
import { VariablesService } from "./variablesService";
import { WatchService } from "./watchService";
import { watchLaunchFiles } from "./workflowWiring";
import type { WorkspaceService } from "./workspaceService";

export interface DebugWiringDeps {
  ipc: IpcClient;
  events: EventBus<AppEvents>;
  workspace: WorkspaceService;
  documents: DocumentService;
  layout: LayoutService;
  panel: PanelService;
  settings: SettingsService;
  log: (line: string) => void;
}

/** The file of the active text tab, when it has one on disk. */
export type ActiveFile = () => { path: string; docId: string } | null;

/** Debugging: breakpoints, the paused program's stack/variables/watches, the console and the session. */
export function wireDebug(deps: DebugWiringDeps) {
  const { ipc, events, workspace, documents, layout, panel, settings } = deps;
  const activeFile: ActiveFile = () => {
    const id = workspace.getState().activeId;
    if (id === null || !documents.has(id)) return null;
    const path = documents.snapshot(id).path;
    return path === null ? null : { path, docId: id };
  };
  const breakpoints = new BreakpointService(ipc, (): boolean => debug.isDebugging());
  const debugConfigs = new DebugConfigurationService(ipc);
  watchLaunchFiles(events, debugConfigs, () => activeFile()?.path ?? null);
  const callStack = new CallStackService(ipc, events, (path, line, column) => {
    void workspace.openPathAt(path, { line, column, length: 0 });
  });
  const variables = new VariablesService(ipc, events);
  const watches = new WatchService(ipc, events);
  const debugConsole: DebugConsoleService = new DebugConsoleService(
    async (expression) =>
      parseEvaluate(await debug.evaluate(expression, callStack.selected()?.id ?? null)),
    (): string | null => debug.evaluateUnavailable(),
  );
  const debug: DebugService = new DebugService(ipc, events, breakpoints, debugConfigs, debugConsole, {
    activeFile,
    saveIfDirty: async (id) => {
      if (!documents.isDirty(id)) return true;
      try {
        await documents.save(id);
        return true;
      } catch {
        return false;
      }
    },
    workspacePath: () => workspace.getActiveWorkspace()?.path ?? null,
    showConsole: () => {
      void layout.showView("debug");
      if (settings.bool("debug.openConsoleOnStart", false)) void panel.show("debugConsole");
    },
    stopOnEntry: () => settings.bool("debug.stopOnEntry", false),
    log: deps.log,
    saveAll: () => workspace.saveAll(),
  });

  /** Starts debugging support once the app is up: saved breakpoints, editor gutter, live state. Nothing runs by itself. */
  async function start(): Promise<void> {
    callStack.initialize();
    variables.initialize();
    registerDebugEditorBinding({ documents, breakpoints, callStack });
    await Promise.all([
      breakpoints.initialize(),
      watches.initialize(),
      debug.initialize(),
      debugConfigs.refresh(activeFile()?.path ?? null),
    ]);
  }

  return {
    activeFile,
    breakpoints,
    debugConfigs,
    callStack,
    variables,
    watches,
    debugConsole,
    debug,
    startDebugTools: start,
  };
}
