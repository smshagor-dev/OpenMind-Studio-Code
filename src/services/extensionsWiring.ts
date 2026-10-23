import { nativeExtensionDialogs } from "./extensionDialogs";
import type { CommandRegistry } from "./commandRegistry";
import type { DocumentService } from "./documentService";
import type { EditorService } from "./editorService";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import {
  HostBridge,
  type HostDiagnostic,
  type ProviderInvoke,
  type ProviderRegistration,
} from "./extensionHostBridge";
import { ExtensionEditorService } from "./extensionEditorService";
import { ExtensionHostService } from "./extensionHostService";
import { HostDocumentSync } from "./extensionHostSync";
import {
  ExtensionContributionService,
  type ContributionBinding,
} from "./extensionContributionService";
import { ExtensionMarketplaceService } from "./extensionMarketplaceService";
import { ExtensionViewsService } from "./extensionViewsService";
import { type MarketplaceApi, tauriMarketplaceApi } from "./marketplaceIpc";
import { ExtensionPromptService } from "./extensionPromptService";
import { toMarkers, type MarkerInput } from "./extensionProviderConvert";
import { ExtensionRegistryService } from "./extensionRegistryService";
import { ExtensionService } from "./extensionService";
import type { IpcClient, SettingValue } from "./ipc";
import type { KeybindingsManager } from "./keybindingsManager";
import { type OutputService, stamped } from "./outputService";
import type { SettingsService } from "./settingsService";
import { StatusBarItemsService } from "./statusBarItemsService";
import { panelsOf, WebviewService } from "./webviewService";
import type { ThemeService } from "./themeService";
import { extensionWorkbench } from "./extensionWorkbench";

export interface ExtensionsWiringDeps {
  ipc: IpcClient;
  events: EventBus<AppEvents>;
  commands: CommandRegistry;
  settings: SettingsService;
  theme: ThemeService;
  keybindingsManager: KeybindingsManager;
  documents: DocumentService;
  editor: EditorService;
  output: OutputService;
  /** Runs a command from a UI event (errors become toasts). */
  run: (command: string, ...args: unknown[]) => void;
  /** The open folder of this window, if any. */
  workspacePath: () => string | null;
  /** Shows an Output channel to the user. */
  showOutput: (channel: string) => void;
  /** Open VSX (tests pass their own). */
  marketplaceApi?: MarketplaceApi;
  /** The Monaco parts (languages, snippets, editor actions, language features), injected. */
  binding: ContributionBinding;
  registerProvider: (
    registration: ProviderRegistration,
    invoke: ProviderInvoke,
    pathOfModel: (modelUri: string) => string | null,
  ) => () => void;
  languageIds: () => string[];
  languageForPath: (path: string) => string;
  /** Whether a text editor (not only a preview) shows this document. */
  hasTextTab: (docId: string) => boolean;
  /** The id of the active tab of the active editor group. */
  activeTabId: () => string | null;
  activeEditorGroup?: () => string | null;
}

/**
 * Builds the extension services and connects them to the rest of the app: the host's questions are
 * answered through the bridge, contributions reach the command registry, the keyboard shortcuts, the
 * editor, the settings and the theme. Called once by the composition root; nothing runs until `start()`.
 */
export function wireExtensions(deps: ExtensionsWiringDeps) {
  const { ipc, events, commands, settings, documents, keybindingsManager } = deps;
  // "Extensions" (install, enable, activation, host events) and "Extension Host" (what extensions print) always exist.
  const log = (line: string) => {
    deps.output.append("Extensions", stamped(line));
  };
  deps.output.ensureChannel("Extensions");
  deps.output.ensureChannel("Extension Host");
  const prompts = new ExtensionPromptService();
  const registry = new ExtensionRegistryService(events);
  // Install from the marketplace = a verified download handed to the same trust dialog as a .vsix.
  const marketplace = new ExtensionMarketplaceService(deps.marketplaceApi ?? tauriMarketplaceApi, {
    install: (path) => service.inspect(path),
    onError: (message) => {
      events.emit("appError", { message });
    },
    autoFetch: () => settings.bool("extensions.marketplace.autoFetch", true),
    installed: () =>
      registry.all().map((extension) => ({
        id: extension.id,
        publisher: extension.manifest.publisher,
        name: extension.manifest.name,
        version: extension.manifest.version,
      })),
    startupFinished: () => startupFinished,
  });
  // Problems an extension reported for files that aren't open yet are kept until they are.
  const pendingDiagnostics = new Map<string, Map<string, MarkerInput[]>>();

  const applyDiagnostics = (owner: string, path: string, markers: MarkerInput[]) => {
    const id = documents.idForHostPath(path);
    if (id !== null) documents.setMarkers(id, owner, markers);
  };
  const setDiagnostics = (collection: string, path: string, list: HostDiagnostic[]) => {
    const owner = `ext:${collection}`;
    const markers = toMarkers(list);
    const byPath = pendingDiagnostics.get(owner) ?? new Map<string, MarkerInput[]>();
    if (markers.length === 0) byPath.delete(path);
    else byPath.set(path, markers);
    pendingDiagnostics.set(owner, byPath);
    applyDiagnostics(owner, path, markers);
  };
  events.on("documentOpened", ({ id }) => {
    const path = documents.hostPath(id);
    for (const [owner, byPath] of pendingDiagnostics) {
      const markers = byPath.get(path);
      if (markers) documents.setMarkers(id, owner, markers);
    }
  });

  const sync = new HostDocumentSync({
    documents,
    events,
    notify: (method, params) => {
      if (host.isRunning()) void ipc.extHostNotify(method, params).catch(() => undefined);
    },
    visibleEditors: () => deps.editor.snapshotEditors().flatMap(value => {
      const docId = documents.idForModelUri(value.uri);
      if (!docId || !documents.has(docId)) return [];
      const path = documents.hostPath(docId);
      const activeGroup = deps.activeEditorGroup?.();
      return [{ ...value, path, active: activeGroup ? value.groupId === activeGroup : value.active }];
    }),
    editorState: (id) => {
      const uri = documents.modelUri(id);
      if (uri === null) return null;
      const selections = deps.editor.selectionsFor(uri);
      const options = deps.editor.optionsFor(uri);
      return selections === null || options === null ? null : { selections, ...options };
    },
    onSelectionChange: (listener) => deps.editor.subscribe(listener),
    currentActiveId: () => deps.activeTabId(),
    editorsCovered: () => {
      const state = webviews.getState();
      return state.overlay && panelsOf(state).length > 0;
    },
  });
  /** An app command, or one an extension registered in the host. */
  async function runAnyCommand(command: string, args: unknown[]): Promise<unknown> {
    if (commands.has(command)) {
      await commands.execute(command, ...args);
      return null;
    }
    if (bridge.registeredCommands().has(command)) return host.executeCommand(command, args);
    throw new Error(`command '${command}' not found`);
  }
  // Webview panels of extensions (sandboxed frames; see webviewHtml.ts).
  const webviews = new WebviewService({
    notifyHost: (method, params) => {
      if (host.isRunning()) void ipc.extHostNotify(method, params).catch(() => undefined);
    },
    readResource: (extension, path, roots) => ipc.extWebviewReadResource(extension, path, roots),
    log: (line) => {
      deps.output.append("Extension Host", stamped(line));
    },
    onError: (message) => {
      events.emit("appError", { message });
    },
  });
  // A webview panel covering the editors means there is no active text editor; the host is told when that changes.
  webviews.subscribe(() => {
    sync.refreshActive();
  });
  const editorApi = new ExtensionEditorService({
    documents,
    editor: deps.editor,
    sync,
    hasTextTab: deps.hasTextTab,
  });
  // Items extensions put in the status bar; they follow the host and the enabled extensions.
  const statusBar = new StatusBarItemsService({
    hasCommand: (command) => commands.has(command) || bridge.registeredCommands().has(command),
    runCommand: (command, args) => runAnyCommand(command, args),
    onError: (message) => {
      events.emit("appError", { message });
    },
  });

  const bridge: HostBridge = new HostBridge({
    dialogs: nativeExtensionDialogs(async () => {
      const selected = await prompts.quickPick({ extension: "File picker", items: [{ label: "Files" }, { label: "Folders" }], placeHolder: "Choose what to open", canPickMany: false });
      return selected === 0 ? "files" : selected === 1 ? "folders" : null;
    }),
    onWorkbenchEvent: (method, params) => { extensionWorkbench.handle(method, params); },
    prompts,
    output: deps.output,
    hostRequest: (method, params) => {
      sync.flush();
      return ipc.extHostRequest(method, params);
    },
    showOutput: deps.showOutput,
    openExternal: (url) => ipc.openExternalUrl(url),
    clipboard: {
      readText: async () => (await import("@tauri-apps/plugin-clipboard-manager")).readText(),
      writeText: async value => (await import("@tauri-apps/plugin-clipboard-manager")).writeText(value),
    },
    createUntitled: (content, language, named) => {
      const id = documents.createUntitled(content, language, named);
      const data = sync.describe(id);
      if (!data) throw new Error("The untitled document could not be created.");
      return data;
    },
    readDocument: async (path) => {
      const read = await ipc.documentRead(path);
      if (read.state !== "file") return null;
      return {
        path,
        languageId: deps.languageForPath(path),
        version: 1,
        text: read.content,
        isDirty: false,
      };
    },
    languageIds: deps.languageIds,
    updateConfiguration: async (key, value, target) => {
      const result =
        value === undefined
          ? await settings.reset(target, key)
          : await settings.set(target, key, value as SettingValue);
      if (!result.ok) throw new Error(result.error);
    },
    registerProvider: (registration, invoke) =>
      deps.registerProvider(registration, invoke, (modelUri) => {
        const id = documents.idForModelUri(modelUri);
        return id === undefined ? null : documents.hostPath(id);
      }),
    setDiagnostics,
    runCommand: (command, args) => runAnyCommand(command, args),
    knownCommands: () => [...new Set([...commands.list(), ...bridge.registeredCommands()])],
    onHostCommandsChanged: () => undefined,
    onViewEvent: (method, params) => {
      views.handleEvent(method, params);
    },
    editorApi,
    onStatusBarEvent: (method, params) => {
      statusBar.handleEvent(method, params);
    },
    onWebviewEvent: (method, params) => {
      webviews.handleEvent(method, params);
    },
  });
  registry.subscribe(() => {
    if (registry.getState().snapshot === null) return;
    const enabled = new Set(
      registry
        .all()
        .filter((e) => e.enabled)
        .map((e) => e.id),
    );
    statusBar.keepOnly(enabled);
    webviews.keepOnly(enabled);
  });

  const host: ExtensionHostService = new ExtensionHostService({
    ipc,
    events,
    registry,
    bridge,
    sync,
    settingsValues: () => settings.values(),
    colorTheme: () => deps.theme.getTheme(),
    onRestarted: () => {
      if (startupFinished) contributions.started(deps.workspacePath());
    },
    log,
    workspaceFolders: () => {
      const path = deps.workspacePath();
      return path === null ? [] : [{ path, name: path.split(/[\\/]/).pop() ?? path }];
    },
  });

  events.on("themeChanged", ({ theme }) => {
    if (host.isRunning()) void ipc.extHostNotify("host/configurationChanged", { colorTheme: theme }).catch(() => undefined);
  });

  // Activity bar icons and tree views contributed by extensions.
  const views: ExtensionViewsService = new ExtensionViewsService({
    ipc,
    registry,
    host,
    run: (command) => {
      deps.run(command);
    },
    onError: (message) => {
      events.emit("appError", { message });
    },
    context: () => {
      const folder = deps.workspacePath();
      return {
        workbenchState: folder === null ? "empty" : "folder",
        workspaceFolderCount: folder === null ? 0 : 1,
      };
    },
  });

  const service = new ExtensionService(ipc, events, registry, host, settings, log);
  const contributions = new ExtensionContributionService({
    ipc,
    events,
    registry,
    host,
    commands,
    binding: deps.binding,
    languageOf: (id) => documents.languageOf(id),
  });
  deps.theme.setExtensionThemeSource(contributions);
  documents.setLanguageResolver((path) => contributions.languageForPath(path));
  deps.editor.setActionRunner((command) => {
    deps.run(command);
  });

  let startupFinished = false;

  extensionWorkbench.connect(async (params) => {
    if (!(await host.start())) throw new Error("The extension host could not start. Configure a Node.js runtime in Extensions.");
    return ipc.extHostRequest("host/workbench", params);
  });
  commands.register("extensions.workbench", async () => { await extensionWorkbench.show(); });

  /** Loads the installed extensions and starts following them. Nothing with code runs yet. */
  async function start(isMainWindow: boolean): Promise<void> {
    await registry.initialize();
    // The host, and what extensions ask of the user, live in the main window.
    if (!isMainWindow) return;
    await host.initialize();
    contributions.initialize();
    events.on("extensionsChanged", () => {
      keybindingsManager.refresh();
    });
    keybindingsManager.refresh();
    for (const id of documents.fileBackedIds())
      contributions.languageOpened(documents.languageOf(id));
    events.on("workspaceFolderChanged", ({ workspace }) => {
      if (startupFinished && workspace !== null) contributions.workspaceOpened(workspace.path);
    });
  }

  /** The window is up and the session restored: extensions that asked to start with the app ("*", onStartupFinished) may run now, not before. */
  function finishStartup(): void {
    startupFinished = true;
    contributions.started(deps.workspacePath());
  }

  /**
   * A runtime was installed: when the host couldn't start for lack of Node.js, the extensions that run at start-up
   * (`*`, `onStartupFinished`, `workspaceContains:`) are woken again now instead of at the next launch. A host that is
   * running, stopped or crashed is left alone.
   */
  function retryAfterInstall(): void {
    if (!startupFinished || host.status().state !== "unavailable") return;
    contributions.started(deps.workspacePath());
  }

  return {
    prompts,
    registry,
    marketplace,
    host,
    bridge,
    service,
    contributions,
    views,
    statusBar,
    webviews,
    start,
    finishStartup,
    retryAfterInstall,
  };
}

