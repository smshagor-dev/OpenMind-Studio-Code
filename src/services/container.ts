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
import type { RuntimeStatus } from "./ipc";
import { RunArgumentsService } from "./runArgumentsService";
import { describeRuntimeChange, runtimeFingerprint, TerminalRefreshService } from "./terminalRefreshService";
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
import { launchJsonOpener, watchLaunchFiles, wireNotebooks } from "./workflowWiring";
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
import { followIconTheme } from "../components/iconThemes";
import { AutoSaveService } from "./autoSaveService";
import { ProfileService } from "./profiles/profileService";
import { wireFormatting } from "./formatting/formattingWiring";
import { registerMenuFillCommands } from "./menuFillCommands";
import { wireLanguage } from "./language/languageWiring";
import { registerHelpCommands } from "./helpCommands";
import { registerShellIntegrationCommands } from "./shellIntegrationCommands";
import { registerPythonPackagesCommands } from "./pythonPackagesCommands";
import { offerEnglish } from "./languageOffer";
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
import { wireExtensionApis } from "./extensionApiWiring";
import { wireTasks } from "./taskWiring";
import { ExtensionFormatterRegistry } from "./extensionFormatters";
import { languageForPath } from "../editor/languageForPath";
import { createContributionBinding, registerHostProvider } from "../editor/extensionMonaco";
import * as monaco from "monaco-editor";
import { i18n, t } from "../i18n";
import { tauriBrokerIpc } from "./network/brokerIpc";
import { wireNetwork } from "./network/networkWiring";
import { wireWorkloads } from "./workloads/workloadsWiring";
import { wireLanguageTools } from "./languageTools/languageToolsWiring";
import { DependenciesService } from "./deps/dependenciesService";
import { tauriDepsIpc } from "./deps/depsIpc";
import { wireDeps } from "./deps/depsWiring";

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
  markers,
);
// A shell keeps the PATH it started with: when the active runtimes change (Node.js installed, a version switched or
// removed), idle terminals are started again in their folder so `node`/`npm`/`npx` work at once; busy ones wait.
const terminalRefresh = new TerminalRefreshService({
  terminal,
  isBusy: (id) => tauriIpcClient.terminalBusy(id),
  note: (change, folder) => t("terminal.refresh.note", { change, folder }),
  waiting: (titles) => {
    events.emit("appNotice", { message: t("terminal.refresh.waiting", { titles: titles.join(", ") }) });
  },
});
let refreshedRuntimes: RuntimeStatus[] | null = null;
runtime.subscribe(() => {
  const { loaded, runtimes } = runtime.getState();
  if (!loaded) return;
  if (refreshedRuntimes === null) {
    terminalRefresh.start(runtimeFingerprint(runtimes));
  } else if (runtimeFingerprint(runtimes) !== runtimeFingerprint(refreshedRuntimes)) {
    const change = describeRuntimeChange(refreshedRuntimes, runtimes, (name) =>
      t("terminal.refresh.removed", { name }),
    );
    void terminalRefresh.runtimesChanged(runtimeFingerprint(runtimes), change);
  }
  refreshedRuntimes = runtimes;
});
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
const debugConfigs = new DebugConfigurationService(tauriIpcClient);
watchLaunchFiles(events, debugConfigs, () => activeFile()?.path ?? null);
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
    saveAll: () => workspace.saveAll(),
  },
);

/** Starts debugging support once the app is up: saved breakpoints, editor gutter, live state. Nothing runs by itself. */
async function startDebugTools(): Promise<void> {
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

/** A file preview is read-only: Save and Save As only apply to a text tab (they never pretend to save a preview). */
const activeTabIsText = () => {
  const state = workspace.getState();
  const tab = state.tabs.find((candidate) => candidate.id === state.activeId);
  return tab !== undefined && tab.kind !== "filePreview";
};
const notTextReason = () =>
  hasActiveTab() && !activeTabIsText()
    ? t("editor.previewNothingToSave")
    : undefined;

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
  { enabled: activeTabIsText, disabledReason: notTextReason },
);

commands.register(
  "file.saveAs",
  async () => {
    const { activeId } = workspace.getState();
    if (activeId) {
      await workspace.saveAs(activeId);
    }
  },
  { enabled: activeTabIsText, disabledReason: notTextReason },
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
// Command-line arguments per file, remembered across restarts; every run of that file (Output or terminal) gets them.
const runArguments = new RunArgumentsService(tauriIpcClient);
runCode.setArgumentsSource((path) => runArguments.get(path));
runArguments.subscribe(() => {
  void runCode.refresh();
});
registerRunCommands({
  commands,
  events,
  runCode,
  configs: runConfigs,
  arguments: {
    store: runArguments,
    ask: (file, current) =>
      extensions.prompts.inputBox({
        extension: t("run.interactive.source"),
        title: t("run.arguments.title"),
        prompt: t("run.arguments.prompt", { file: file.split(/[/\\]/).pop() ?? file }),
        placeHolder: t("run.arguments.placeholder"),
        value: current,
        password: false,
      }),
  },
});
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
registerDebugCommands({
  commands,
  debug,
  breakpoints,
  editor,
  events,
  activeFile,
  showDebugView: () => {
    void layout.showView("debug");
  },
  hasFolder: () => workspace.getActiveWorkspace() !== null,
  openLaunchJson: launchJsonOpener({
    ipc: tauriIpcClient,
    folder: () => workspace.getActiveWorkspace()?.path ?? null,
    openPath: (path) => workspace.openPath(path),
    events,
  }),
});
registerPhpCommands(commands, php, tauriIpcClient);
registerGitCommands(commands, layout, gitClone, gitBlame);
commands.register("help.welcome", () => {
  welcome.open();
});
registerHelpCommands({
  commands,
  events,
  ipc: tauriIpcClient,
  openFile: (path) => workspace.openPath(path),
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
/** Network: the proxy of processes OpenMind starts and of its own requests, offline packages, the network-failure card. */
const network = wireNetwork({
  ipc: tauriIpcClient,
  brokerIpc: tauriBrokerIpc,
  events,
  commands,
  settings,
  output,
  terminal,
  installVsix: async (path) => {
    await layout.showView("extensions");
    await extensions.service.inspect(path);
  },
  runtime,
  editor,
  confirm: (request) => extensions.prompts.confirm(request),
  run: (id) => {
    run(id);
  },
});
/** Runtime Manager > Workloads and the first-run page (installs through the RuntimeService). */
const workloads = wireWorkloads({ events, commands, runtime, lsp });
/** Language tools: Missing / Install on the Runtime Manager cards and the editor's one-click install card. */
const languageTools = wireLanguageTools({ events, lsp, runtime });
languageTools.start();
/** Python: Install Bundled Packages (the offline Python bundle, into the active portable Python). */
registerPythonPackagesCommands({ commands, events, ipc: tauriIpcClient, editor });
/** PATH / File Explorer integration on request (portable copies; the installer offers the same as check boxes). */
registerShellIntegrationCommands({
  commands,
  events,
  ipc: tauriIpcClient,
  editor,
  confirm: (request) => extensions.prompts.confirm(request),
});
/** The dependency helper: missing modules/commands in Run Code's Output and terminals, installs only after a preview. */
const depsWiring = wireDeps({
  events,
  output,
  terminal,
  confirm: (request) => extensions.prompts.confirm(request),
  openFile: (path) => void workspace.openPath(path),
  run: (id) => {
    run(id);
  },
  activeFilePath: () => runCode.activeEditor()?.path ?? null,
  workspaceRoot: () => workspace.getActiveWorkspace()?.path ?? null,
  pythonGui: {
    addable: () => {
      const found = runtime.addableAddon("python", "tcltk");
      return found === null
        ? null
        : {
            version: found.version,
            label: found.status.label,
            downloadBytes: found.status.downloadBytes,
            license: found.status.license?.name ?? null,
          };
    },
    add: async (version) =>
      (await runtime.installAddon("python", version, "tcltk"))
        ? null
        : (runtime.getState().errors.python ?? t("runtimes.addon.busy", { name: "Python" })),
    refresh: () => runtime.refresh(),
  },
});
const deps = depsWiring.helper;
// The Dependencies view (Milestone 22.6): same runner as the missing-package card.
const dependencies = new DependenciesService({
  ipc: tauriDepsIpc,
  actions: depsWiring.actions,
  events,
  onChanged: depsWiring.onChanged,
  settingsGet: (key) => tauriIpcClient.settingsGet(key),
  settingsSet: (key, value) => tauriIpcClient.settingsSet(key, value),
});
// Run Code's Output can't type into a program: a file that reads the keyboard is offered the terminal.
runCode.setInteractiveHost({
  text: (docId) => {
    try {
      return documents.contentOf(docId);
    } catch {
      return null;
    }
  },
  choose: async (file) => {
    const terminalLabel = t("run.interactive.terminal");
    const answer = await extensions.prompts.confirm({
      extension: t("run.interactive.source"),
      title: t("run.interactive.title"),
      details: [{ label: t("run.interactive.file"), value: file }],
      notes: [t("run.interactive.note")],
      buttons: [terminalLabel, t("run.interactive.anyway")],
    });
    if (answer === null) return null;
    return answer === terminalLabel ? "terminal" : "output";
  },
});
// Removing a downloaded language server always asks first, naming what is deleted.
lsp.setRemoveConfirmation(async (server) => {
  const button = t("lsp.removeConfirm.button");
  const answer = await extensions.prompts.confirm({
    extension: t("runtimes.tab.tools"),
    title: t("lsp.removeConfirm.title", { name: server.name }),
    details: [{ label: t("lsp.removeConfirm.removes"), value: server.contents }],
    notes: [t("lsp.removeConfirm.note")],
    buttons: [button],
  });
  return answer === button;
});
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
/** Formatters extensions register (Milestone 18): one more choice for Format Document, never ahead of the others. */
const extensionFormatters = new ExtensionFormatterRegistry();
/** Format Document: built-in / project / bundled / runtime formatters and the language server, run on the editor's text. */
const formatting = wireFormatting({
  extensionFormatters,
  ipc: tauriIpcClient,
  events,
  commands,
  workspace,
  documents,
  editor,
  lsp,
  settings,
  log: log("Formatting"),
}).service;
/** Extension API v2: terminals, tasks, documents, custom schemes, webview views, file events (Milestone 18). */
const extensionApis = wireExtensionApis({
  extensions,
  ipc: tauriIpcClient,
  events,
  commands,
  terminal,
  panel,
  workspace,
  documents,
  layout,
  output,
  formatters: extensionFormatters,
  settings,
  languageOf: (name) => languageForPath(name),
});
const notebooks = wireNotebooks({
  ipc: tauriIpcClient,
  prompts: extensions.prompts,
  events,
  settings,
  filePreviews,
  log: log("Notebook"),
});
/** tasks.json tasks (and the extensions' tasks): Terminal > Run Task... and friends. Nothing runs by itself. */
const workspaceTasks = wireTasks({
  ipc: tauriIpcClient,
  events,
  commands,
  terminal,
  prompts: extensions.prompts,
  markers,
  extensionTasks: extensionApis.tasks,
  activeFile: () => activeFile()?.path ?? null,
  workspaceFolder: () => workspace.getActiveWorkspace()?.path ?? null,
  openPath: (path) => workspace.openPath(path),
  log: log("Tasks"),
});
editor.setFormatActions([
  { command: "edit.formatDocument", label: "Format Document", inContextMenu: true },
  { command: "edit.formatDocumentWith", label: "Format Document With...", inContextMenu: true },
]);
/** The Explorer's icons follow `workbench.iconTheme` (built-in, or an enabled extension's icon theme). */
followIconTheme(settings);
commands.register("preferences.fileIconTheme", () => {
  preferencesPage.open("settings", { query: "Icon Theme" });
});
/** Profiles: named sets of settings, kept in settings/profiles next to the app. */
const profiles = new ProfileService(tauriIpcClient, events, () => settings.reload());
commands.register("profiles.manage", () => profiles.openWindow());
commands.register("profiles.export", async () => {
  await profiles.exportProfile();
});
commands.register("profiles.import", async () => {
  await profiles.importProfile();
});
/** Files > Auto Save (afterDelay / onFocusChange / onWindowChange). Only files that already have a path are saved. */
const autoSave = new AutoSaveService({
  events,
  settings,
  documents,
  save: (id, format) => workspace.save(id, { format }),
  activeDocId: () => {
    const id = workspace.getState().activeId;
    return id !== null && documents.has(id) ? id : null;
  },
  onActiveChanged: (handler) => workspace.subscribe(handler),
  onWindowBlur: (handler) => {
    window.addEventListener("blur", handler);
    return () => {
      window.removeEventListener("blur", handler);
    };
  },
});
registerMenuFillCommands({
  commands,
  events,
  ipc: tauriIpcClient,
  workspace,
  groups: editorGroups,
  editor,
  terminal,
  panel,
  layout,
  window: windowService,
  autoSave,
  run: (id) => {
    run(id);
  },
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

/** Writes the start-up timings (phase names and milliseconds only) to the app log; a failure is not worth a message. */
function reportStartup(phases: [string, number][], usableMs: number): void {
  void tauriIpcClient.startupReport(phases, usableMs).catch(() => undefined);
}

/** Loads the formatter choices the user made and looks up the formatter of the file in front (no formatter runs). */
async function startFormatting(): Promise<void> {
  autoSave.start();
  // The proxy settings and the offline cache list: local reads, no network request.
  await network.load();
  await profiles.load();
  await formatting.initialize();
  await formatting.refreshStatus();
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
  runArguments,
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
  extensionApis,
  workspaceTasks,
  notebooks,
  ai,
  startAi,
  language,
  toolchains,
  startLanguage,
  formatting,
  profiles,
  network,
  deps,
  dependencies,
  workloads,
  languageTools,
  reportStartup,
  startFormatting,
  startExtensions: extensions.start,
  finishExtensionsStartup: extensions.finishStartup,
  /** Start-up, main window: offers English when the UI came up in another language (asked once per language). */
  offerEnglish: () =>
    offerEnglish({
      language: () => i18n.language,
      ipc: tauriIpcClient,
      confirm: (request) => extensions.prompts.confirm(request),
      switchToEnglish: async () => (await settings.set("user", "workbench.language", "en")).ok,
    }),
};
