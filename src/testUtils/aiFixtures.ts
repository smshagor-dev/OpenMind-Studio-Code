import { vi } from "vitest";

import { AiChatService } from "../services/ai/aiChatService";
import type { AiChunk, AiProviderConfig, AiProviderInfo } from "../services/ai/aiIpc";
import { AiProviderService, providerIdFor } from "../services/ai/aiProviderService";
import { EventBus } from "../services/eventBus";
import type { AppEvents } from "../services/events";
import type { InstalledExtension } from "../services/extensionsIpc";
import { createFakeIpc } from "./fakeIpcClient";
import { testExtension } from "./fakeExtensionsIpc";

export function providerInfo(overrides: Partial<AiProviderInfo> = {}): AiProviderInfo {
  return {
    id: "p1",
    name: "Mock AI",
    kind: "openai-compatible",
    baseUrl: "https://api.example.com/v1",
    model: "m1",
    models: ["m1", "m2"],
    enabled: true,
    source: null,
    capabilities: ["chat", "streaming"],
    hasKey: true,
    needsKey: true,
    local: false,
    host: "api.example.com",
    ...overrides,
  };
}

/** An installed extension that contributes AI providers (data only). */
export function aiExtension(
  options: { enabled?: boolean; id?: string; providers?: { id: string; name: string }[] } = {},
): InstalledExtension {
  const providers = options.providers ?? [{ id: "acme", name: "Acme AI" }];
  const extension = testExtension({
    enabled: options.enabled ?? true,
    manifest: {
      name: options.id ?? "sample-ai",
      displayName: "Sample AI Provider",
      description: null,
      version: "1.0.0",
      publisher: "openmind-samples",
      enginesVscode: "^1.85.0",
      categories: [],
      icon: null,
      main: null,
      browser: null,
      extensionDependencies: [],
      extensionPack: [],
      requestedPermissions: [],
      contributes: {
        commands: [],
        menus: {},
        unsupportedMenus: [],
        keybindings: [],
        configuration: [],
        unsupportedProperties: [],
        configurationDefaults: {},
        languages: [],
        grammars: [],
        snippets: [],
        themes: [],
        iconThemes: [],
        debuggers: [],
        problemMatchers: [],
        views: { containers: [], elsewhere: 0, otherContainers: 0 },
        aiProviders: providers.map((p) => ({
          id: p.id,
          name: p.name,
          type: "openai-compatible",
          capabilities: ["chat", "streaming"],
          defaultModel: "acme-1",
          models: ["acme-1", "acme-2"],
          baseUrl: "https://api.acme.test/v1",
          description: null,
        })),
        unsupportedAiProviders: [],
        unsupported: {},
      },
    },
  });
  return { ...extension, runtimeRequirement: null };
}

export function extProviderId(extension: InstalledExtension, contributionId = "acme"): string {
  return providerIdFor(extension.id, contributionId);
}

export interface AiRigOptions {
  providers?: AiProviderInfo[];
  extensions?: InstalledExtension[];
  settings?: Record<string, string | boolean>;
  ipc?: Parameters<typeof createFakeIpc>[0];
}

/**
 * The AI services over a fake backend: a provider list held in memory (save/enable/delete/key behave like the real
 * commands, and never hand a key back), a settings stub and an extension list a test can change.
 */
export function aiRig(options: AiRigOptions = {}) {
  const store: AiProviderInfo[] = [...(options.providers ?? [])];
  const values: Record<string, string | boolean> = {
    "ai.enabled": true,
    "ai.confirmBeforeOnlineRequest": true,
    "ai.saveConversationHistory": true,
    "ai.defaultProvider": "",
    "ai.defaultModel": "",
    ...options.settings,
  };
  const extensions = { list: [...(options.extensions ?? [])] };
  const changeHandlers: (() => void)[] = [];
  const settings = {
    bool: (id: string, fallback: boolean) => {
      const value = values[id];
      return typeof value === "boolean" ? value : fallback;
    },
    string: (id: string, fallback: string) => {
      const value = values[id];
      return typeof value === "string" ? value : fallback;
    },
    set: vi.fn((_scope: "user", id: string, value: string | boolean) => {
      values[id] = value;
      for (const handler of changeHandlers) handler();
      return Promise.resolve();
    }),
    onChange: (_ids: string[], handler: () => void) => {
      changeHandlers.push(handler);
      return () => undefined;
    },
  };
  const chunkListeners: ((chunk: AiChunk) => void)[] = [];
  const toInfo = (config: AiProviderConfig, hasKey: boolean): AiProviderInfo => {
    const local = config.baseUrl.includes("127.0.0.1") || config.baseUrl.includes("localhost");
    return {
      ...config,
      hasKey,
      needsKey: !local,
      local,
      host: config.baseUrl.replace(/^https?:\/\//, "").split(/[/:]/)[0] ?? "",
    };
  };
  const ipc = createFakeIpc({
    aiProvidersList: vi.fn(() => Promise.resolve([...store])),
    aiProviderSave: vi.fn((config: AiProviderConfig) => {
      const existing = store.find((p) => p.id === config.id);
      const info = toInfo(config, existing?.hasKey ?? false);
      if (existing) store[store.indexOf(existing)] = info;
      else store.push(info);
      return Promise.resolve(info);
    }),
    aiProviderSetEnabled: vi.fn((id: string, enabled: boolean) => {
      const existing = store.find((p) => p.id === id);
      if (!existing) return Promise.reject(new Error("That AI provider does not exist."));
      const updated = { ...existing, enabled };
      store[store.indexOf(existing)] = updated;
      return Promise.resolve(updated);
    }),
    aiProviderDelete: vi.fn((id: string) => {
      const at = store.findIndex((p) => p.id === id);
      if (at >= 0) store.splice(at, 1);
      return Promise.resolve();
    }),
    aiProviderSetKey: vi.fn((id: string) => {
      const existing = store.find((p) => p.id === id);
      if (existing) store[store.indexOf(existing)] = { ...existing, hasKey: true };
      return Promise.resolve();
    }),
    aiProviderClearKey: vi.fn((id: string) => {
      const existing = store.find((p) => p.id === id);
      if (existing) store[store.indexOf(existing)] = { ...existing, hasKey: false };
      return Promise.resolve();
    }),
    aiProviderTest: vi.fn().mockResolvedValue([
      { id: "m1", chat: true, embedding: false },
      { id: "m2", chat: true, embedding: false },
    ]),
    onAiChunk: vi.fn((listener: (chunk: AiChunk) => void) => {
      chunkListeners.push(listener);
      return Promise.resolve(() => undefined);
    }),
    ...options.ipc,
  });
  const events = new EventBus<AppEvents>();
  const providers = new AiProviderService(ipc, events, settings, {
    all: () => extensions.list,
  });
  const clock = { now: 1_000 };
  const chat = new AiChatService(ipc, events, providers, settings, () => {
    clock.now += 1;
    return clock.now;
  });
  return {
    ipc,
    events,
    store,
    values,
    settings,
    extensions,
    providers,
    chat,
    /** Pushes an answer piece as the backend would. */
    pushChunk: (chunk: AiChunk) => {
      for (const listener of chunkListeners) listener(chunk);
    },
    /** Changes the installed extensions and tells the app, like `ext:changed` does. */
    setExtensions: (list: InstalledExtension[]) => {
      extensions.list = list;
      events.emit("extensionsChanged", undefined);
    },
  };
}
