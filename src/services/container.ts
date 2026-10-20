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
import { registerPhpCommands } from "./phpCommands";
import { PortsService } from "./portsService";
import { registerPreviewCommands } from "./previewCommands";
import { PreviewEditorService } from "./previewEditorService";
import { RuntimeService } from "./runtimeService";
import { SearchService } from "./searchService";
import { SettingsService } from "./settingsService";
import { wirePreferences } from "./preferencesWiring";
import { TerminalService } from "./terminalService";
import { ThemeService } from "./themeService";
import { tauriWindowApi, WindowService } from "./windowService";
import { registerRuntimeCommands } from "./runtimeCommands";
import { missingRuntimeHost } from "./assembly/assemblyToolchain";
import { registerLspCommands } from "./lspCommands";
import { registerDebugCommands } from "./debugCommands";
import { launchJsonOpener, wireNotebooks } from "./workflowWiring";
import { disableBuiltinLanguageServices, freeReferencesShortcut } from "./monacoBuiltins";
import { indexSettingsFrom, WorkspaceIndexService } from "./workspaceIndexService";
import { wireSearch } from "./searchWiring";
import { wireAi } from "./ai/aiWiring";
import { followIconTheme } from "../components/iconThemes";
import { createWorkbenchAutoSave } from "./autoSaveService";
import { wireProfiles } from "./profiles/profilesWiring";
import { wireFormatting } from "./formatting/formattingWiring";
import { registerMenuFillCommands } from "./menuFillCommands";
import { connectEditorLanguages, wireLanguage } from "./language/languageWiring";
import { registerHelpCommands } from "./helpCommands";
import { registerShellIntegrationCommands } from "./shellIntegrationCommands";
import { registerPythonPackagesCommands } from "./pythonPackagesCommands";
import { offerEnglish } from "./languageOffer";
import { CanonicalStateService } from "./state/canonicalStateService";
import { tauriCanonicalIpc } from "./state/canonicalIpc";
import { wireLiveSync } from "./sync/liveSyncWiring";
import { FileSyncService } from "./fileSyncService";
import { registerGitCommands } from "./gitCommands";
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
import { databaseHost } from "./deps/databaseHost";
import { wireDeps } from "./deps/depsWiring";
import { wireCollab } from "./collab/collabWiring";
import { pythonGuiHost } from "./deps/pythonGuiHost";
import { wireDebug } from "./debugWiring";
import { wireLsp } from "./lspWiring";
import { connectWorkbench, registerWindowCommands } from "./workbenchGlue";
import { registerFileCommands } from "./fileCommands";
import { wireGit } from "./gitWiring";
import { wirePhpStack } from "./phpStackWiring";
import { wireRunCode } from "./runWiring";
import { wireTerminalRefresh } from "./terminalRefreshWiring";
import { wireToolchains } from "./toolchains/toolchainsWiring";

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
/**
 * The window's copy of the canonical, versioned system state (live sync, step 2): runtimes, tools, language servers,
 * extensions and the packages marker, the same in every window. Stores follow their domain through a feed.
 */
const canonical = new CanonicalStateService(tauriCanonicalIpc, log("OpenMind Studio"), (reason) => {
  events.emit("appError", { message: reason });
});
void canonical.start().catch(() => undefined);
const runtime = new RuntimeService(tauriIpcClient, events, log("Runtime Manager"));
runtime.useCanonical(canonical.feed("runtimes"));
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

const phpStack = wirePhpStack({
  ipc: tauriIpcClient,
  events,
  output,
  runtime,
  panel,
  defaultPort: () => settings.number("php.server.defaultPort", 8000),
  closeWindow: () => windowService.close(),
});
const git = wireGit({
  ipc: tauriIpcClient,
  output,
  events,
  workspace,
  editorGroups,
  afterGitOperation: (): Promise<unknown> => fileSync.afterGitOperation(),
});
const fileSync = new FileSyncService(tauriIpcClient, events, documents, explorer, {
  workspacePath: () => workspace.getActiveWorkspace()?.path ?? null,
  loadedFolders: () => explorer.loadedFolders(),
});
const secondarySideBar = new SecondarySideBarService(tauriIpcClient);
const {
  runCode,
  configs: runConfigs,
  runArguments,
  browser,
} = wireRunCode({
  ipc: tauriIpcClient,
  events,
  commands,
  output,
  workspace,
  documents,
  terminal,
  panel,
  settings,
  markers,
  showBeside: (channel) => void secondarySideBar.showOutput(channel),
  showBrowser: () => void secondarySideBar.showBrowser(),
  confirm: (request) => extensions.prompts.confirm(request),
  inputBox: (request) => extensions.prompts.inputBox(request),
});
const terminalRefresh = wireTerminalRefresh({
  ipc: tauriIpcClient,
  events,
  terminal,
  runtime,
  runtimesChanged: (fingerprint) => {
    runCode.noteRuntimesChanged(fingerprint);
  },
});

const { lsp, start: startLanguageTools } = wireLsp({
  ipc: tauriIpcClient,
  events,
  documents,
  workspace,
  settings,
  log: log("LSP"),
  confirm: (request) => extensions.prompts.confirm(request),
});
const welcome = new WelcomeService(tauriIpcClient, settings);

const debugging = wireDebug({
  ipc: tauriIpcClient,
  events,
  workspace,
  documents,
  layout,
  panel,
  settings,
  log: log("Debug"),
});

connectWorkbench({
  ipc: tauriIpcClient,
  events,
  workspace,
  documents,
  explorer,
  fileSync,
  editor,
  markers,
  appLog: log("OpenMind Studio"),
});

registerFileCommands({
  commands,
  ipc: tauriIpcClient,
  workspace,
  documents,
  explorer,
  layout,
  theme,
});

registerTerminalCommands(commands, terminal);
registerViewCommands({ commands, events, layout, panel, output, search });
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
// A missing toolchain met by Run Code: Install / Open Runtime Manager / Cancel (Assembly also gets asm-lsp).
const confirmMissing = (request: Parameters<typeof extensions.prompts.confirm>[0]) =>
  extensions.prompts.confirm(request);
runCode.setMissingRuntimeHost(
  missingRuntimeHost({ runtime, lsp, settings, confirm: confirmMissing, run }),
);
registerLspCommands({ commands, editor, lsp, events, output, panel });
registerDebugCommands({
  commands,
  debug: debugging.debug,
  breakpoints: debugging.breakpoints,
  editor,
  events,
  activeFile: debugging.activeFile,
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
registerPhpCommands(commands, phpStack.php, tauriIpcClient);
registerGitCommands(commands, layout, git.gitClone, git.gitBlame);
registerHelpCommands({
  commands,
  events,
  ipc: tauriIpcClient,
  openFile: (path) => workspace.openPath(path),
});
const editorWindows = new EditorWindowService(tauriIpcClient, workspace, events);
registerWindowCommands({
  commands,
  ipc: tauriIpcClient,
  workspace,
  welcome,
  editorWindows,
  secondarySideBar,
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
  php: phpStack.php,
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
const languageTools = wireLanguageTools({ events, lsp });
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
  run,
  activeFilePath: () => runCode.activeEditor()?.path ?? null,
  workspaceRoot: () => workspace.getActiveWorkspace()?.path ?? null,
  pythonGui: pythonGuiHost(runtime),
  database: databaseHost(phpStack.mySql, tauriIpcClient, run),
});
const deps = depsWiring.helper;
// The Dependencies view (Milestone 22.6): same runner as the missing-package card.
const dependencies = new DependenciesService({
  actions: depsWiring.actions,
  events,
  settingsGet: (key) => tauriIpcClient.settingsGet(key),
  settingsSet: (key, value) => tauriIpcClient.settingsSet(key, value),
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
  activeFile: () => debugging.activeFile()?.path ?? null,
  workspaceFolder: () => workspace.getActiveWorkspace()?.path ?? null,
  openPath: (path) => workspace.openPath(path),
  log: log("Tasks"),
});
/** The Explorer's icons follow `workbench.iconTheme` (built-in, or an enabled extension's icon theme). */
followIconTheme(settings);
const profiles = wireProfiles({ ipc: tauriIpcClient, events, commands, settings });
/** Files > Auto Save (afterDelay / onFocusChange / onWindowChange). Only files that already have a path are saved. */
const autoSave = createWorkbenchAutoSave({ events, settings, documents, workspace });
registerMenuFillCommands({
  commands,
  events,
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
/** Language Tools: the bundled app-local tools and their install routes. */
const { toolchains, toolInstall } = wireToolchains({
  ipc: tauriIpcClient,
  events,
  runtime,
  lsp,
  refreshLanguage: () => {
    void language.support.refresh();
  },
  confirm: (request) => extensions.prompts.confirm(request),
});
wireLiveSync({
  canonical,
  runtime,
  toolchains,
  lsp,
  extensions: extensions.registry,
  php: phpStack.php,
  mySql: phpStack.mySql,
  mariaDb: phpStack.mariaDb,
  phpMyAdmin: phpStack.phpMyAdmin,
  ports,
  sourceControl: git.sourceControl,
  dependencies,
  language: language.support,
  debug: debugging.debug,
  events,
  workloads,
  formatterStatus: () => formatting.refreshStatus(),
  runCodeStatus: () => runCode.refresh(),
  retryLanguageServers: () => lsp.retryUnready(),
  retryExtensions: () => {
    extensions.retryAfterInstall();
  },
  onPackageOperation: (listener) => depsWiring.onChanged(listener),
  toolsOnPath: (change) => terminalRefresh.environmentChanged(change),
  removedText: (name) => t("terminal.refresh.removed", { name }),
});
const startLanguage = connectEditorLanguages({
  documents,
  extensions: extensions.contributions,
  support: language.support,
});

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
  collab: wireCollab({ workspace, documents, filePreviews, events, canonical }),
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
  ...phpStack,
  ...git,
  fileSync,
  lsp,
  welcome,
  secondarySideBar,
  browser,
  editorWindows,
  startLanguageTools,
  ...debugging,
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
  toolInstall,
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
