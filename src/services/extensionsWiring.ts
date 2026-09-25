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
import { ExtensionHostService } from "./extensionHostService";
import { HostDocumentSync } from "./extensionHostSync";
import { ExtensionContributionService, type ContributionBinding } from "./extensionContributionService";
import { ExtensionMarketplaceService } from "./extensionMarketplaceService";
import { ExtensionPromptService } from "./extensionPromptService";
import { toMarkers, type MarkerInput } from "./extensionProviderConvert";
import { ExtensionRegistryService } from "./extensionRegistryService";
import { ExtensionService } from "./extensionService";
import type { IpcClient, SettingValue } from "./ipc";
import type { KeybindingsManager } from "./keybindingsManager";
import type { OutputService } from "./outputService";
import type { SettingsService } from "./settingsService";
import type { ThemeService } from "./themeService";

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
  /** The Monaco parts (languages, snippets, editor actions, language features), injected. */
  binding: ContributionBinding;
  registerProvider: (
    registration: ProviderRegistration,
    invoke: ProviderInvoke,
    pathOfModel: (modelUri: string) => string | null,
  ) => () => void;
  languageIds: () => string[];
  languageForPath: (path: string) => string;
}

/**
 * Builds the extension services and connects them to the rest of the app: the host's questions are
 * answered through the bridge, contributions reach the command registry, the keyboard shortcuts, the
 * editor, the settings and the theme. Called once by the composition root; nothing runs until `start()`.
 */
export function wireExtensions(deps: ExtensionsWiringDeps) {
  const { ipc, events, commands, settings, documents, keybindingsManager } = deps;
  const prompts = new ExtensionPromptService();
  const registry = new ExtensionRegistryService(ipc, events);
  const marketplace = new ExtensionMarketplaceService();
  // Problems an extension reported for files that aren't open yet are kept until they are.
  const pendingDiagnostics = new Map<string, Map<string, MarkerInput[]>>();

  const applyDiagnostics = (owner: string, path: string, markers: MarkerInput[]) => {
    const id = documents.idForPath(path);
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
    const path = documents.snapshot(id).path;
    if (path === null) return;
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
  });

  const bridge: HostBridge = new HostBridge({
    prompts,
    output: deps.output,
    hostRequest: (method, params) => {
      sync.flush();
      return ipc.extHostRequest(method, params);
    },
    showOutput: deps.showOutput,
    openExternal: (url) => ipc.openExternalUrl(url),
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
        return id === undefined ? null : documents.snapshot(id).path;
      }),
    setDiagnostics,
    runCommand: async (command, args) => {
      if (commands.has(command)) {
        await commands.execute(command, ...args);
        return null;
      }
      if (bridge.registeredCommands().has(command)) return host.executeCommand(command, args);
      throw new Error(`command '${command}' not found`);
    },
    knownCommands: () => [...new Set([...commands.list(), ...bridge.registeredCommands()])],
    onHostCommandsChanged: () => undefined,
  });

  const host: ExtensionHostService = new ExtensionHostService({
    ipc,
    events,
    registry,
    bridge,
    sync,
    settingsValues: () => settings.values(),
    workspaceFolders: () => {
      const path = deps.workspacePath();
      return path === null ? [] : [{ path, name: path.split(/[\\/]/).pop() ?? path }];
    },
  });

  const service = new ExtensionService(ipc, events, registry, host, settings);
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
    for (const id of documents.fileBackedIds()) contributions.languageOpened(documents.languageOf(id));
    contributions.started(deps.workspacePath());
    events.on("workspaceFolderChanged", ({ workspace }) => {
      if (workspace !== null) contributions.workspaceOpened(workspace.path);
    });
  }

  return { prompts, registry, marketplace, host, bridge, service, contributions, start };
}
