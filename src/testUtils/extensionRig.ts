import { vi } from "vitest";

import { CommandRegistry } from "../services/commandRegistry";
import { EventBus } from "../services/eventBus";
import type { AppEvents } from "../services/events";
import { HostBridge } from "../services/extensionHostBridge";
import type { HostDocumentSync } from "../services/extensionHostSync";
import { ExtensionHostService } from "../services/extensionHostService";
import { ExtensionContributionService } from "../services/extensionContributionService";
import { createFakeMarketplaceApi } from "./fakeMarketplaceApi";
import { ExtensionMarketplaceService } from "../services/extensionMarketplaceService";
import { ExtensionPromptService } from "../services/extensionPromptService";
import { ExtensionRegistryService } from "../services/extensionRegistryService";
import { ExtensionService } from "../services/extensionService";
import type { ExtensionsSnapshot, InstalledExtension } from "../services/extensionsIpc";
import type { IpcClient } from "../services/ipc";
import { OutputService } from "../services/outputService";
import { SettingsService } from "../services/settingsService";
import { createFakeExtensionsIpc, emptyExtensionsSnapshot, testExtension } from "./fakeExtensionsIpc";
import { createFakeIpc } from "./fakeIpcClient";

export const command = testExtension({
  manifest: {
    ...testExtension().manifest,
    contributes: {
      ...testExtension().manifest.contributes,
      commands: [{ command: "sampleCommand.hello", title: "Say Hello", category: "Sample" }],
      keybindings: [{ command: "sampleCommand.hello", key: "Ctrl+Alt+H", when: null }],
      menus: {
        "editor/context": [{ command: "sampleCommand.hello", when: null, group: null }],
        "explorer/context": [{ command: "sampleCommand.hello", when: null, group: "z" }],
      },
    },
  },
  activationEvents: ["onCommand:sampleCommand.hello"],
});

export interface Rig {
  ipc: IpcClient;
  events: EventBus<AppEvents>;
  registry: ExtensionRegistryService;
  host: ExtensionHostService;
  service: ExtensionService;
  marketplace: ExtensionMarketplaceService;
  contributions: ExtensionContributionService;
  commands: CommandRegistry;
  prompts: ExtensionPromptService;
  output: OutputService;
  bridge: HostBridge;
  errors: string[];
  logs: string[];
  editorActions: unknown[];
  snapshot: { current: ExtensionsSnapshot };
}

export function rig(extensions: InstalledExtension[] = [], overrides: Partial<ExtensionsSnapshot> = {}): Rig {
  const snapshot = { current: emptyExtensionsSnapshot({ extensions, ...overrides }) };
  const ipc = createFakeIpc({
    ...createFakeExtensionsIpc(),
    extList: vi.fn().mockImplementation(() => Promise.resolve(snapshot.current)),
  });
  const events = new EventBus<AppEvents>();
  const errors: string[] = [];
  const logs: string[] = [];
  events.on("appError", ({ message }) => errors.push(message));
  const registry = new ExtensionRegistryService(ipc, events);
  const prompts = new ExtensionPromptService();
  const output = new OutputService();
  const commands = new CommandRegistry();
  const sync = {
    initial: () => ({ documents: [], activeEditor: null }),
    start: vi.fn(),
    stop: vi.fn(),
    flush: vi.fn(),
  } as unknown as HostDocumentSync;
  const bridge = new HostBridge({
    prompts,
    output,
    hostRequest: (method, params) => ipc.extHostRequest(method, params),
    showOutput: vi.fn(),
    openExternal: vi.fn().mockResolvedValue(undefined),
    readDocument: vi.fn().mockResolvedValue(null),
    languageIds: () => ["plaintext"],
    updateConfiguration: vi.fn().mockResolvedValue(undefined),
    registerProvider: () => () => undefined,
    setDiagnostics: vi.fn(),
    runCommand: vi.fn().mockResolvedValue(null),
    knownCommands: () => [],
    onHostCommandsChanged: () => undefined,
  });
  const host = new ExtensionHostService({
    ipc,
    events,
    registry,
    bridge,
    sync,
    settingsValues: () => ({ "sampleConfig.greeting": "Hello" }),
    workspaceFolders: () => [{ path: "C:/My Site", name: "My Site" }],
    log: (line) => logs.push(line),
    restartDelayMs: 0,
  });
  const settings = new SettingsService(ipc, events);
  vi.spyOn(settings, "reload").mockResolvedValue(undefined);
  const service = new ExtensionService(ipc, events, registry, host, settings, (line) => logs.push(line));
  const editorActions: unknown[] = [];
  const contributions = new ExtensionContributionService({
    ipc,
    events,
    registry,
    host,
    commands,
    binding: {
      registerLanguage: vi.fn(),
      registerSnippets: vi.fn().mockReturnValue(() => undefined),
      setEditorActions: (actions) => editorActions.splice(0, editorActions.length, ...actions),
    },
    languageOf: () => "plaintext",
  });
  return { ipc, events, registry, host, service, marketplace: new ExtensionMarketplaceService(createFakeMarketplaceApi(), { install: (path) => service.inspect(path), onError: (message) => errors.push(message) }), contributions, commands, prompts, output, bridge, errors, logs, editorActions, snapshot };
}

export async function started(extensions: InstalledExtension[], overrides: Partial<ExtensionsSnapshot> = {}) {
  const r = rig(extensions, overrides);
  await r.registry.initialize();
  r.contributions.initialize();
  return r;
}

