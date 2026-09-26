import type { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import type { InstalledExtension } from "../extensionsIpc";
import type {
  AiCapability,
  AiIpc,
  AiProviderConfig,
  AiProviderInfo,
  AiProviderKind,
} from "./aiIpc";

export const AI_SETTING_IDS = [
  "ai.enabled",
  "ai.defaultProvider",
  "ai.defaultModel",
  "ai.confirmBeforeOnlineRequest",
  "ai.saveConversationHistory",
];

/** The slice of `SettingsService` the AI services read and write. */
export interface AiSettingsSource {
  bool: (id: string, fallback: boolean) => boolean;
  string: (id: string, fallback: string) => string;
  set: (scope: "user", id: string, value: string | boolean) => Promise<unknown>;
  onChange: (ids: string[], handler: () => void) => () => void;
}

/** The slice of `ExtensionRegistryService` the AI services read. */
export interface AiExtensionsSource {
  all: () => InstalledExtension[];
}

/** A provider as the UI shows it: its stored configuration plus whether it can be used right now, and why not. */
export interface AiProviderView extends AiProviderInfo {
  /** Enabled, and (for an extension's provider) its extension is installed and enabled. */
  available: boolean;
  unavailableReason: string | null;
  /** The name of the extension that provides it, if any. */
  sourceName: string | null;
  /** It came from an extension that is no longer installed (nothing will bring it back, so it can be deleted). */
  sourceMissing: boolean;
}

export type AiTestStatus = "idle" | "testing" | "ok" | "failed";

export interface AiTestState {
  status: AiTestStatus;
  message: string | null;
}

export interface AiProvidersState {
  loaded: boolean;
  providers: AiProviderInfo[];
  /** The provider picked in the AI panel (falls back to the default, then the first usable one). */
  selectedId: string | null;
  tests: Record<string, AiTestState>;
  error: string | null;
}

/** What the provider form collects. */
export interface AiProviderDraft {
  /** Set when editing; new providers get an id. */
  id?: string;
  name: string;
  kind: AiProviderKind;
  baseUrl: string;
  model: string;
  enabled: boolean;
}

export const PROVIDER_KIND_LABELS: Record<AiProviderKind, string> = {
  claude: "Claude (Anthropic)",
  "openai-compatible": "OpenAI / OpenAI-compatible",
  gemini: "Gemini (Google)",
  local: "Local server (on this computer)",
};

export const DEFAULT_BASE_URLS: Record<AiProviderKind, string> = {
  claude: "https://api.anthropic.com",
  "openai-compatible": "https://api.openai.com/v1",
  gemini: "https://generativelanguage.googleapis.com",
  local: "http://127.0.0.1:11434/v1",
};

const CAPABILITIES: Record<string, AiCapability> = {
  chat: "chat",
  streaming: "streaming",
  embeddings: "embeddings",
  vision: "vision",
  toolcalling: "toolCalling",
  localoffline: "localOffline",
  local: "localOffline",
  offline: "localOffline",
  codeassistance: "codeAssistance",
  code: "codeAssistance",
};

function toCapability(text: string): AiCapability | null {
  return CAPABILITIES[text.toLowerCase().replace(/[-_/]/g, "")] ?? null;
}

function isKind(text: string): text is AiProviderKind {
  return text === "claude" || text === "openai-compatible" || text === "gemini" || text === "local";
}

let idCounter = 0;
function newId(name: string): string {
  idCounter += 1;
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 30) || "provider";
  return `user.${slug}-${Date.now().toString(36)}${idCounter.toString(36)}`;
}

let requestCounter = 0;
export function newRequestId(prefix: string): string {
  requestCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${requestCounter.toString(36)}`;
}

export function providerIdFor(extensionId: string, contributionId: string): string {
  return `ext:${extensionId}/${contributionId}`;
}

export type SaveResult = { ok: true; provider: AiProviderInfo } | { ok: false; error: string };

/**
 * The AI providers: what is configured (the backend keeps the list; an API key is stored encrypted and never
 * comes back), and which of them can be used right now. A provider contributed by an extension is available only
 * while that extension is installed and enabled — disabling it removes the provider, and with it the AI panel
 * and commands, at once; enabling it brings them back. UI-free. Nothing here talks to a provider except an
 * explicit `test` (which the user asked for).
 */
export class AiProviderService {
  private state: AiProvidersState = {
    loaded: false,
    providers: [],
    selectedId: null,
    tests: {},
    error: null,
  };
  private readonly listeners = new Set<() => void>();
  private syncing: Promise<void> | null = null;
  private version = 0;
  private views: AiProviderView[] = [];

  constructor(
    private readonly ipc: AiIpc,
    private readonly events: EventBus<AppEvents>,
    private readonly settings: AiSettingsSource,
    private readonly extensions: AiExtensionsSource,
  ) {}

  getState(): AiProvidersState {
    return this.state;
  }

  /** Changes whenever what the UI derives from this service could differ (for `useSyncExternalStore`). */
  getVersion(): number {
    return this.version;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Follows the extension list and the AI settings. Reads a local file only. */
  async initialize(): Promise<void> {
    this.events.on("extensionsChanged", () => {
      void this.syncContributions();
      this.recompute();
    });
    this.settings.onChange(AI_SETTING_IDS, () => {
      this.recompute();
    });
    await this.refresh();
  }

  async refresh(): Promise<void> {
    try {
      const providers = await this.ipc.aiProvidersList();
      this.state = { ...this.state, loaded: true, providers, error: null };
    } catch (error) {
      this.state = {
        ...this.state,
        loaded: true,
        error: `The AI providers could not be read: ${String(error)}`,
      };
    }
    this.recompute();
    await this.syncContributions();
  }

  /** Enabled extensions' AI providers become configured providers (created once, then edited by the user). */
  async syncContributions(): Promise<void> {
    if (!this.state.loaded) return;
    if (this.syncing) {
      await this.syncing;
    }
    const run = this.createMissing();
    this.syncing = run;
    try {
      await run;
    } finally {
      this.syncing = null;
    }
  }

  private async createMissing(): Promise<void> {
    let created = false;
    for (const extension of this.extensions.all()) {
      if (!extension.enabled) continue;
      for (const contribution of extension.manifest.contributes.aiProviders) {
        const id = providerIdFor(extension.id, contribution.id);
        if (this.state.providers.some((provider) => provider.id === id)) continue;
        if (!isKind(contribution.type)) continue;
        const capabilities = contribution.capabilities
          .map(toCapability)
          .filter((c): c is AiCapability => c !== null);
        try {
          const saved = await this.ipc.aiProviderSave({
            id,
            name: contribution.name,
            kind: contribution.type,
            baseUrl: contribution.baseUrl ?? "",
            model: contribution.defaultModel ?? contribution.models[0] ?? "",
            models: contribution.models,
            enabled: true,
            source: extension.id,
            capabilities,
          });
          this.state = { ...this.state, providers: [...this.state.providers, saved] };
          created = true;
        } catch (error) {
          this.events.emit("appError", {
            message: `The AI provider "${contribution.name}" could not be added: ${String(error)}`,
          });
        }
      }
    }
    if (created) this.recompute();
  }

  // --- What is usable -------------------------------------------------------------------------------------

  private compute(): AiProviderView[] {
    return this.state.providers.map((provider) => {
      let reason: string | null = null;
      let sourceName: string | null = null;
      let sourceMissing = false;
      if (provider.source !== null) {
        const extension = this.extensions.all().find((e) => e.id === provider.source);
        sourceName = extension?.manifest.displayName ?? extension?.manifest.name ?? provider.source;
        const offered =
          extension?.manifest.contributes.aiProviders.some(
            (c) => providerIdFor(extension.id, c.id) === provider.id,
          ) === true;
        if (!extension) {
          sourceMissing = true;
          reason = `The extension ${provider.source} is not installed.`;
        } else if (!extension.enabled) {
          reason = `The extension ${sourceName} is disabled.`;
        } else if (!offered) {
          reason = `The extension ${sourceName} no longer offers this provider.`;
        }
      }
      if (reason === null && !provider.enabled) reason = "This provider is turned off.";
      return {
        ...provider,
        available: reason === null,
        unavailableReason: reason,
        sourceName,
        sourceMissing,
      };
    });
  }

  private recompute(): void {
    this.views = this.compute();
    const usable = this.views.filter((view) => view.available);
    if (this.state.selectedId !== null && !usable.some((v) => v.id === this.state.selectedId)) {
      this.state = { ...this.state, selectedId: null };
    }
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  /** Every configured provider with its availability. */
  all(): AiProviderView[] {
    return this.views;
  }

  /** The providers that can be used now (empty when AI is turned off in settings). */
  usable(): AiProviderView[] {
    return this.settings.bool("ai.enabled", true) ? this.views.filter((v) => v.available) : [];
  }

  /** The AI panel, its activity bar icon and the AI commands exist only while this is true. */
  panelVisible(): boolean {
    return this.usable().length > 0;
  }

  find(id: string): AiProviderView | undefined {
    return this.views.find((view) => view.id === id);
  }

  /** The provider chosen in the panel, else the default one, else the first usable one. */
  selected(): AiProviderView | null {
    const usable = this.usable();
    const chosen = usable.find((v) => v.id === this.state.selectedId);
    if (chosen) return chosen;
    const preferred = this.settings.string("ai.defaultProvider", "");
    return usable.find((v) => v.id === preferred) ?? usable[0] ?? null;
  }

  select(id: string): void {
    if (!this.usable().some((v) => v.id === id)) return;
    this.state = { ...this.state, selectedId: id };
    this.recompute();
  }

  /** The model to use for `view`: the one chosen for it, else the default model when it is the default provider. */
  modelOf(view: AiProviderView): string {
    if (view.model !== "") return view.model;
    const isDefault = this.settings.string("ai.defaultProvider", "") === view.id;
    return isDefault ? this.settings.string("ai.defaultModel", "") : "";
  }

  /** Why chatting with `view` can't start yet (a missing key or model), or null when it can. */
  configIssue(view: AiProviderView): string | null {
    if (view.needsKey && !view.hasKey) {
      return `Add an API key for ${view.name} in the provider settings.`;
    }
    if (this.modelOf(view) === "") return `Choose a model for ${view.name}.`;
    return null;
  }

  // --- Changing providers -----------------------------------------------------------------------------------

  async save(draft: AiProviderDraft, key?: string): Promise<SaveResult> {
    const existing = draft.id ? this.state.providers.find((p) => p.id === draft.id) : undefined;
    const config: AiProviderConfig = {
      id: existing?.id ?? newId(draft.name),
      name: draft.name,
      kind: draft.kind,
      baseUrl: draft.baseUrl.trim(),
      model: draft.model,
      models: existing?.models ?? [],
      enabled: draft.enabled,
      source: existing?.source ?? null,
      capabilities: existing?.capabilities ?? [],
    };
    try {
      let saved = await this.ipc.aiProviderSave(config);
      if (key !== undefined && key.trim() !== "") {
        await this.ipc.aiProviderSetKey(saved.id, key.trim());
        saved = { ...saved, hasKey: true };
      }
      this.upsert(saved);
      return { ok: true, provider: saved };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }

  private upsert(saved: AiProviderInfo): void {
    const has = this.state.providers.some((p) => p.id === saved.id);
    this.state = {
      ...this.state,
      providers: has
        ? this.state.providers.map((p) => (p.id === saved.id ? saved : p))
        : [...this.state.providers, saved],
    };
    this.recompute();
  }

  async remove(id: string): Promise<string | null> {
    try {
      await this.ipc.aiProviderDelete(id);
    } catch (error) {
      return String(error);
    }
    const tests = Object.fromEntries(
      Object.entries(this.state.tests).filter(([key]) => key !== id),
    );
    this.state = {
      ...this.state,
      providers: this.state.providers.filter((p) => p.id !== id),
      tests,
    };
    this.recompute();
    return null;
  }

  async setEnabled(id: string, enabled: boolean): Promise<string | null> {
    try {
      this.upsert(await this.ipc.aiProviderSetEnabled(id, enabled));
      return null;
    } catch (error) {
      return String(error);
    }
  }

  async setKey(id: string, key: string): Promise<string | null> {
    try {
      await this.ipc.aiProviderSetKey(id, key.trim());
    } catch (error) {
      return String(error);
    }
    this.patch(id, { hasKey: true });
    return null;
  }

  async clearKey(id: string): Promise<string | null> {
    try {
      await this.ipc.aiProviderClearKey(id);
    } catch (error) {
      return String(error);
    }
    this.patch(id, { hasKey: false });
    return null;
  }

  private patch(id: string, change: Partial<AiProviderInfo>): void {
    this.state = {
      ...this.state,
      providers: this.state.providers.map((p) => (p.id === id ? { ...p, ...change } : p)),
    };
    this.recompute();
  }

  /** Chooses the model for a provider (saved with it). */
  async setModel(id: string, model: string): Promise<string | null> {
    const provider = this.state.providers.find((p) => p.id === id);
    if (!provider) return "That provider does not exist.";
    const config: AiProviderConfig = {
      id: provider.id,
      name: provider.name,
      kind: provider.kind,
      baseUrl: provider.baseUrl,
      model,
      models: provider.models,
      enabled: provider.enabled,
      source: provider.source,
      capabilities: provider.capabilities,
    };
    try {
      this.upsert(await this.ipc.aiProviderSave(config));
      return null;
    } catch (error) {
      return String(error);
    }
  }

  /** Makes the provider (and its current model) the one the panel selects first. */
  async setDefault(id: string): Promise<void> {
    const view = this.find(id);
    if (!view) return;
    await this.settings.set("user", "ai.defaultProvider", id);
    await this.settings.set("user", "ai.defaultModel", this.modelOf(view));
    this.recompute();
  }

  /** Connection test: asks the provider for its models. The one request this service ever makes, and only on demand. */
  async test(id: string): Promise<AiTestState> {
    this.setTest(id, { status: "testing", message: null });
    try {
      const models = await this.ipc.aiProviderTest(id, newRequestId("test"));
      const chat = models.filter((m) => m.chat).length;
      const result: AiTestState = {
        status: "ok",
        message: `Connected. ${chat} model${chat === 1 ? "" : "s"} available.`,
      };
      this.setTest(id, result);
      await this.refresh();
      return result;
    } catch (error) {
      const failed: AiTestState = { status: "failed", message: String(error) };
      this.setTest(id, failed);
      return failed;
    }
  }

  private setTest(id: string, test: AiTestState): void {
    this.state = { ...this.state, tests: { ...this.state.tests, [id]: test } };
    this.recompute();
  }
}
