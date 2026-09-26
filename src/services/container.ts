import { BufferManager } from "./bufferManager";
import { CommandRegistry } from "./commandRegistry";
import { DocumentService } from "./documentService";
import { EditorAssociationService } from "./editorAssociationService";
import { registerEditorCommands } from "./editorCommands";
import { EditorGroupService } from "./editorGroupService";
import { EditorService } from "./editorService";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import { ExplorerService } from "./explorerService";
import { FilePreviewService } from "./filePreviewService";
import { FileSystemService } from "./fileSystemService";
import { tauriIpcClient } from "./ipc";
import { KeybindingService } from "./keybindings";
import { LayoutService } from "./layoutService";
import { MarkdownPreviewService } from "./markdownPreviewService";
import { MarkerService } from "./markerService";
import { OpenEditorsService } from "./openEditorsService";
import { OutputService, stamped } from "./outputService";
import { PanelService } from "./panelService";
import { PhpServerService } from "./phpServerService";
import { registerPhpCommands } from "./phpCommands";
import { PortsService } from "./portsService";
import { registerPreviewCommands } from "./previewCommands";
import { PreviewEditorService } from "./previewEditorService";
import { RunConfigurationService } from "./runConfigurationService";
import { RunCodeService } from "./runCodeService";
import { registerRunCommands } from "./runCommands";
import { RuntimeService } from "./runtimeService";
import { SearchService } from "./searchService";
import { SettingsService } from "./settingsService";
import { wirePreferences } from "./preferencesWiring";
import { TerminalService } from "./terminalService";
import { ThemeService } from "./themeService";
import { tauriWindowApi, WindowService } from "./windowService";
import { registerRuntimeCommands } from "./runtimeCommands";
import { DiagnosticsService } from "./diagnosticsService";
import { registerLspCommands } from "./lspCommands";
import { BreakpointService } from "./breakpointService";
import { CallStackService } from "./callStackService";
import { DebugConfigurationService } from "./debugConfigurationService";
import { DebugConsoleService } from "./debugConsoleService";
import { registerDebugCommands } from "./debugCommands";
import { registerDebugEditorBinding } from "./debugEditorBinding";
import { parseEvaluate } from "./debugModel";
import { DebugService } from "./debugService";
import { VariablesService } from "./variablesService";
import { WatchService } from "./watchService";
import { disableBuiltinLanguageServices, freeReferencesShortcut } from "./monacoBuiltins";
import { registerIndexSymbolProvider } from "../editor/indexSymbolProvider";
import { indexSettingsFrom, WorkspaceIndexService } from "./workspaceIndexService";
import { wireSearch } from "./searchWiring";
import { wireAi } from "./ai/aiWiring";
import { wireLanguage } from "./language/languageWiring";
import { ToolchainService } from "./toolchains/toolchainService";
import { LspService } from "./lspService";
import { registerLspProviders } from "./lspProviders";
import { ComposerService } from "./composerService";
import { FileSyncService } from "./fileSyncService";
import { GitBlameService } from "./gitBlameService";
import { GitCloneService } from "./gitCloneService";
import { registerGitCommands } from "./gitCommands";
import { GitHistoryService } from "./gitHistoryService";
import { GitService } from "./gitService";
import { GitStashService } from "./gitStashService";
import { SourceControlService } from "./sourceControlService";
import { ControlPanelService } from "./controlPanelService";
import { MariaDbService } from "./mariaDbService";
import { PhpMyAdminService } from "./phpMyAdminService";
import { PhpRuntimeService } from "./phpRuntimeService";
import { registerTerminalCommands } from "./terminalCommands";
import { registerViewCommands } from "./viewCommands";
import { registerWorkbenchCommands } from "./workbenchCommands";
import { EditorWindowService } from "./editorWindowService";
import { SecondarySideBarService } from "./secondarySideBarService";
import { WelcomeService } from "./welcomeService";
import { WorkspaceService } from "./workspaceService";
import type { ExtensionContributionService } from "./extensionContributionService";
import { wireExtensions } from "./extensionsWiring";
import { languageForPath } from "../editor/languageForPath";
import { createContributionBinding, registerHostProvider } from "../editor/extensionMonaco";
import * as monaco from "monaco-editor";

// Monaco's own language services must be off before the first model exists (see monacoBuiltins.ts).
disableBuiltinLanguageServices();
freeReferencesShortcut();

const events = new EventBus<AppEvents>();
const buffers = new BufferManager();
const documents = new DocumentService(tauriIpcClient, buffers, events);
const output = new OutputService();
const log = (channel: string) => (line: string) => {
  output.append(channel, stamped(line));
};
const panel = new PanelService(tauriIpcClient);
const editorGroups = new EditorGroupService();
const associations = new EditorAssociationService(tauriIpcClient);
const previews = new PreviewEditorService(tauriIpcClient);
const filePreviews = new FilePreviewService(tauriIpcClient);
const workspace = new WorkspaceService(documents, tauriIpcClient, events, {
  groups: editorGroups,
  associations,
  previews,
  filePreviews,
});
const openEditors = new OpenEditorsService(workspace);
const markdown = new MarkdownPreviewService(workspace, editorGroups, tauriIpcClient, events);
const ports = new PortsService(tauriIpcClient, events);
const fileSystem = new FileSystemService(tauriIpcClient);
const explorer = new ExplorerService(fileSystem, tauriIpcClient, events);
const settings = new SettingsService(tauriIpcClient, events);
const theme = new ThemeService(settings, events);
const commands = new CommandRegistry();
const editor = new EditorService(tauriIpcClient, settings);
const layout = new LayoutService(tauriIpcClient);
const windowService = new WindowService(tauriWindowApi, tauriIpcClient);
const keybindings = new KeybindingService(commands);
const markers = new MarkerService();
const runtime = new RuntimeService(tauriIpcClient, events, log("Runtime Manager"));
const terminal = new TerminalService(
  tauriIpcClient,
  events,
  () => workspace.getActiveWorkspace()?.path ?? null,
  panel,
  log("Terminal"),
);
const workspaceIndex = new WorkspaceIndexService(
  tauriIpcClient,
  events,
  () => workspace.getActiveWorkspace()?.path ?? null,
  () => indexSettingsFrom(settings),
);
const search = new SearchService(
  tauriIpcClient,
  events,
  output,
  () => workspace.getActiveWorkspace()?.path ?? null,
  workspace,
  workspaceIndex,
);

const php = new PhpServerService(tauriIpcClient, events, output, runtime, ports, panel, () =>
  settings.number("php.server.defaultPort", 8000),
);
const mariaDb = new MariaDbService(tauriIpcClient, events, output, runtime, ports, panel);
const phpMyAdmin = new PhpMyAdminService(
  tauriIpcClient,
  events,
  output,
  runtime,
  ports,
  panel,
  php,
  mariaDb,
);
const composer = new ComposerService(tauriIpcClient, events, output, runtime, panel);
const phpRuntime = new PhpRuntimeService(runtime, php, { mariadb: mariaDb, pma: phpMyAdmin });
const controlPanel = new ControlPanelService(
  tauriIpcClient,
  events,
  output,
  php,
  mariaDb,
  phpMyAdmin,
  () => windowService.close(),
);
const gitService = new GitService(tauriIpcClient, output);
const sourceControl = new SourceControlService(
  gitService,
  events,
  (path) => workspace.openPath(path),
  () => {
    events.emit("showRuntimeManager", undefined);
  },
  (listener) => runtime.subscribe(listener),
  (): Promise<unknown> => fileSync.afterGitOperation(),
  () => settings.bool("git.autoRefresh", true),
);
const fileSync = new FileSyncService(tauriIpcClient, events, documents, explorer, {
  workspacePath: () => workspace.getActiveWorkspace()?.path ?? null,
  workingTreeChanged: (): Promise<void> =>
    settings.bool("git.autoRefresh", true) ? sourceControl.refresh() : Promise.resolve(),
  loadedFolders: () => explorer.loadedFolders(),
});
const gitClone = new GitCloneService(
  gitService,
  events,
  (path) => workspace.openFolder(path),
  () => sourceControl.runtime(),
);
const gitHistory = new GitHistoryService(gitService, events, (hash, file) =>
  sourceControl.openCommitDiff(hash, file),
);
const gitStash = new GitStashService(
  gitService,
  events,
  async (): Promise<void> => {
    await sourceControl.refresh();
    await fileSync.afterGitOperation();
  },
  () => {
    const changes = sourceControl.status()?.changes ?? [];
    const untracked = changes.filter((change) => change.worktree === "untracked").length;
    return { tracked: changes.length - untracked, untracked };
  },
);
const gitBlame = new GitBlameService(
  gitService,
  () => {
    const tab = editorGroups.activeTab();
    return tab ? workspace.docPath(tab.docId) : null;
  },
  () => sourceControl.repository(),
);
events.on("workspaceFolderChanged", () => {
  gitHistory.reset();
  gitStash.reset();
  gitBlame.close();
});
const runConfigs = new RunConfigurationService(tauriIpcClient);
const secondarySideBar = new SecondarySideBarService(tauriIpcClient);
const runCode = new RunCodeService(
  tauriIpcClient,
  events,
  output,
  workspace,
  runConfigs,
  terminal,
  panel,
  (channel) => void secondarySideBar.showOutput(channel),
  {
    saveBeforeRun: () => settings.bool("run.saveBeforeRun", true),
    clearOutputBeforeRun: () => settings.bool("run.clearOutputBeforeRun", true),
  },
);
// An interpreter appearing or going (install / delete / switch) changes what can run.
runtime.subscribe(() => {
  runCode.noteRuntimesChanged(
    runtime
      .getState()
      .runtimes.map(
        (r) =>
          `${r.id}:${r.activeVersion ?? "-"}:${String(r.installed.filter((v) => v.healthy).length)}`,
      )
      .join(","),
  );
});

const lsp = new LspService(tauriIpcClient, events, documents, {
  log: log("LSP"),
  activeDocId: () => {
    const id = workspace.getState().activeId;
    return id !== null && documents.has(id) ? id : null;
  },
  enabled: () => settings.bool("lsp.enabled", true),
});
const diagnostics = new DiagnosticsService(events, documents);
const welcome = new WelcomeService(tauriIpcClient, settings);

// Debugging: breakpoints, the paused program's stack/variables/watches, the console and the session.
const activeFile = (): { path: string; docId: string } | null => {
  const id = workspace.getState().activeId;
  if (id === null || !documents.has(id)) return null;
  const path = documents.snapshot(id).path;
  return path === null ? null : { path, docId: id };
};
const breakpoints = new BreakpointService(tauriIpcClient, (): boolean => debug.isDebugging());
const debugConfigs = new DebugConfigurationService();
const callStack = new CallStackService(tauriIpcClient, events, (path, line, column) => {
  void workspace.openPathAt(path, { line, column, length: 0 });
});
const variables = new VariablesService(tauriIpcClient, events);
const watches = new WatchService(tauriIpcClient, events);
const debugConsole: DebugConsoleService = new DebugConsoleService(
  async (expression) =>
    parseEvaluate(await debug.evaluate(expression, callStack.selected()?.id ?? null)),
  (): string | null => debug.evaluateUnavailable(),
);
const debug: DebugService = new DebugService(
  tauriIpcClient,
  events,
  breakpoints,
  debugConfigs,
  debugConsole,
  {
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
    log: log("Debug"),
  },
);

/** Starts debugging support once the app is up: saved breakpoints, editor gutter, live state. Nothing runs by itself. */
async function startDebugTools(): Promise<void> {
  callStack.initialize();
  variables.initialize();
  registerDebugEditorBinding({ documents, breakpoints, callStack });
  await Promise.all([breakpoints.initialize(), watches.initialize(), debug.initialize()]);
}

/**
 * Starts language support once the app is up: diagnostics become editor markers and
 * the providers (hover, completion, definition, ...) ask the language servers.
 */
async function startLanguageTools(): Promise<void> {
  diagnostics.initialize();
  registerLspProviders({ ipc: tauriIpcClient, documents, workspace, lsp });
  registerIndexSymbolProvider({
    textSymbols: (language, text) => tauriIpcClient.searchSymbolsOfText(language, text),
    languageServerHandles: (uri) => {
      const id = documents.idForModelUri(uri);
      return id !== undefined && lsp.available("documentSymbol", id).enabled;
    },
  });
  await lsp.initialize();
}

// Problems are labelled with the document each marker belongs to; search results reveal in the editor.
markers.setResourceResolver((uri) => {
  const id = documents.idForModelUri(uri);
  if (id === undefined) return null;
  const snapshot = documents.snapshot(id);
  return { title: snapshot.title, path: snapshot.path };
});
workspace.setRevealer((uri, target) => {
  editor.reveal({ uri, ...target });
});

// The app's own log: caught errors and workspace changes.
const appLog = log("OpenMind Studio");
appLog("OpenMind Studio started.");
events.on("appError", ({ message }) => {
  appLog(`Error: ${message}`);
});
events.on("workspaceFolderChanged", ({ workspace: opened }) => {
  appLog(opened ? `Opened folder ${opened.path}` : "Closed the folder.");
});

// Keep the explorer tree in sync with whichever folder is currently open.
workspace.subscribeWorkspace(() => {
  const info = workspace.getActiveWorkspace();
  if (info) {
    void explorer.setRoot(info.path, info.name);
  } else {
    explorer.clear();
  }
});

const hasActiveTab = () => workspace.getState().activeId !== null;

commands.register("file.new", () => {
  workspace.createUntitled();
});

commands.register("file.open", async () => {
  const path = await tauriIpcClient.openDocumentDialog();
  if (path) {
    await workspace.openPath(path);
  }
});

commands.register("file.openFolder", async () => {
  const path = await tauriIpcClient.openFolderDialog();
  if (path) {
    await workspace.openFolder(path);
  }
});

commands.register(
  "file.closeFolder",
  async () => {
    await workspace.closeFolder();
  },
  { enabled: () => workspace.getActiveWorkspace() !== null },
);

commands.register(
  "file.save",
  async () => {
    const { activeId } = workspace.getState();
    if (activeId) {
      await workspace.save(activeId);
    }
  },
  { enabled: hasActiveTab },
);

commands.register(
  "file.saveAs",
  async () => {
    const { activeId } = workspace.getState();
    if (activeId) {
      await workspace.saveAs(activeId);
    }
  },
  { enabled: hasActiveTab },
);

commands.register(
  "file.closeActiveTab",
  async () => {
    const { activeId } = workspace.getState();
    if (activeId) {
      await workspace.close(activeId);
    }
  },
  { enabled: hasActiveTab },
);

commands.register("view.toggleTheme", async () => {
  // Toggles between the dark and light themes (from High Contrast it goes to dark).
  await theme.setMode(theme.getTheme() === "dark" ? "light" : "dark");
});

commands.register("explorer.newFile", async () => {
  const root = explorer.getSnapshot().rootPath;
  if (root) {
    await explorer.createFile(root);
  }
});

commands.register("explorer.newFolder", async () => {
  const root = explorer.getSnapshot().rootPath;
  if (root) {
    await explorer.createFolder(root);
  }
});

commands.register("explorer.refresh", async () => {
  await explorer.refresh();
});

commands.register("explorer.collapseAll", async () => {
  await explorer.collapseAll();
});

commands.register("explorer.revealActiveFile", async () => {
  const { activeId } = workspace.getState();
  if (!activeId) {
    return;
  }
  const path = documents.snapshot(activeId).path;
  if (path) {
    await explorer.revealPath(path);
  }
});

registerTerminalCommands(commands, terminal);
registerViewCommands({ commands, events, layout, panel, output, search });
registerRunCommands({ commands, events, runCode, configs: runConfigs });
registerEditorCommands({
  commands,
  workspace,
  groups: editorGroups,
  openEditors,
  previews,
  associations,
  markdown,
});
registerPreviewCommands({
  commands,
  workspace,
  groups: editorGroups,
  markdown,
  filePreviews,
});
const searchWiring = wireSearch({
  ipc: tauriIpcClient,
  events,
  commands,
  settings,
  workspace,
  editor,
  lsp,
  layout,
  search,
  index: workspaceIndex,
});
void workspaceIndex.listen();
registerRuntimeCommands(commands, events);
registerLspCommands({ commands, editor, lsp, events, output, panel });
registerDebugCommands({ commands, debug, breakpoints, editor, events, activeFile });
registerPhpCommands(commands, php, tauriIpcClient);
registerGitCommands(commands, layout, gitClone, gitBlame);
commands.register("help.welcome", () => {
  welcome.open();
});
commands.register("workbench.newWindow", async () => {
  await tauriIpcClient.windowNew();
});
const editorWindows = new EditorWindowService(tauriIpcClient, workspace, events);
commands.register(
  "workbench.moveEditorToNewWindow",
  async () => {
    await editorWindows.moveActiveToNewWindow();
  },
  { enabled: hasActiveTab },
);
commands.register("view.toggleSecondarySidebar", () => secondarySideBar.toggle(), {
  checked: () => secondarySideBar.getState().visible,
});

registerWorkbenchCommands({
  commands,
  events,
  ipc: tauriIpcClient,
  documents,
  workspace,
  editor,
  layout,
  window: windowService,
});

// Set once the extension services exist (they need the keybinding manager built just below).
let contributionsRef: ExtensionContributionService | null = null;

const {
  page: preferencesPage,
  keybindingsManager,
  startSettings,
} = wirePreferences({
  ipc: tauriIpcClient,
  events,
  commands,
  settings,
  theme,
  keybindings,
  documents,
  editor,
  search,
  lsp,
  php,
  openFile: (path) => workspace.openPath(path),
  extraKeybindings: () => contributionsRef?.keybindings() ?? [],
  extraCommands: () => contributionsRef?.commandInfos() ?? [],
});

const extensions = wireExtensions({
  ipc: tauriIpcClient,
  events,
  commands,
  settings,
  theme,
  keybindingsManager,
  documents,
  editor,
  output,
  run: (id, ...args) => {
    run(id, ...args);
  },
  workspacePath: () => workspace.getActiveWorkspace()?.path ?? null,
  showOutput: (channel) => void secondarySideBar.showOutput(channel),
  binding: createContributionBinding(editor),
  registerProvider: (registration, invoke, pathOfModel) =>
    registerHostProvider(registration, invoke, (model) => pathOfModel(model.uri.toString())),
  languageIds: () => monaco.languages.getLanguages().map((language) => language.id),
  languageForPath,
  activeTabId: () => workspace.getState().activeId,
  hasTextTab: (docId) =>
    workspace
      .getState()
      .groups.some((group) => group.tabs.some((tab) => tab.docId === docId && tab.kind === "text")),
});
contributionsRef = extensions.contributions;
const ai = wireAi({
  ipc: tauriIpcClient,
  events,
  commands,
  settings,
  extensions: extensions.registry,
  layout,
  editor,
  terminal,
  workspace,
  previews: filePreviews,
});

const language = wireLanguage({
  ipc: tauriIpcClient,
  events,
  commands,
  workspace,
  documents,
  terminal,
  showTerminal: () => panel.show("terminal"),
});
/** The bundled app-local tools: choosing another active version makes the language support look again. */
const toolchains = new ToolchainService(tauriIpcClient, () => {
  void language.support.refresh();
});
// Extensions' languages win; then the registry's grammar for languages the editor's own table doesn't know (Go, Rust ...).
documents.setLanguageResolver(
  (path) =>
    extensions.contributions.languageForPath(path) ?? language.support.editorLanguageFor(path),
);

/** Loads the language table (static data) and looks at the open folder: file names and manifests only. */
async function startLanguage(): Promise<void> {
  await language.support.initialize();
  await language.support.refresh();
}

/** Reads the configured AI providers (a local file) and starts listening; nothing is sent anywhere. */
async function startAi(): Promise<void> {
  await extensions.registry.ensureLoaded();
  await Promise.all([ai.providers.initialize(), ai.chat.initialize()]);
}

/**
 * Fire-and-forget command execution for UI event handlers: a failing command
 * surfaces as an `appError` toast instead of an unhandled rejection.
 */
function run(id: string, ...args: unknown[]): void {
  commands.execute(id, ...args).catch((error: unknown) => {
    events.emit("appError", { message: `Command "${id}" failed: ${String(error)}` });
  });
}

/** The app's single composition root: one instance of each service, wired together. */
export const container = {
  events,
  buffers,
  documents,
  workspace,
  fileSystem,
  explorer,
  theme,
  settings,
  preferencesPage,
  keybindingsManager,
  startSettings,
  commands,
  keybindings,
  run,
  markers,
  editor,
  layout,
  window: windowService,
  terminal,
  runtime,
  panel,
  output,
  runCode,
  runConfigs,
  ports,
  php,
  phpRuntime,
  mariaDb,
  phpMyAdmin,
  composer,
  controlPanel,
  git: gitService,
  sourceControl,
  fileSync,
  lsp,
  welcome,
  secondarySideBar,
  editorWindows,
  startLanguageTools,
  breakpoints,
  debug,
  debugConfigs,
  debugConsole,
  callStack,
  variables,
  watches,
  startDebugTools,
  gitClone,
  gitHistory,
  gitStash,
  gitBlame,
  search,
  editorGroups,
  openEditors,
  previews,
  associations,
  markdown,
  filePreviews,
  workspaceIndex,
  searchPanel: searchWiring.panel,
  fileSearch: searchWiring.fileSearch,
  symbolSearch: searchWiring.symbolSearch,
  references: searchWiring.references,
  quickOpen: searchWiring.quickOpen,
  ipc: tauriIpcClient,
  extensions,
  ai,
  startAi,
  language,
  toolchains,
  startLanguage,
  startExtensions: extensions.start,
  finishExtensionsStartup: extensions.finishStartup,
};
