import type { CommandRegistry } from "./commandRegistry";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import { commandBlockedReason, displayName } from "./extensionModel";
import type { ExtensionHostService } from "./extensionHostService";
import type { ExtensionRegistryService } from "./extensionRegistryService";
import type { InstalledExtension, ExtensionLanguageContribution } from "./extensionsIpc";
import { type ExtensionSnippet, parseSnippets } from "./extensionSnippets";
import { type LoadedExtensionTheme, parseExtensionTheme } from "./extensionTheme";
import type { IpcClient } from "./ipc";
import type { Keybinding } from "./keybindings";
import type { CommandInfo } from "./keybindingsModel";
import { EXTENSION_THEME_PREFIX, type ExtensionThemeSource } from "./themeService";

/** What the editor needs to know to offer an extension's command (palette and context menu). */
export interface ExtensionEditorAction {
  command: string;
  label: string;
  /** Also in the editor's right-click menu. */
  inContextMenu: boolean;
}

export interface ExtensionExplorerItem {
  command: string;
  label: string;
  group: string | null;
}

/** The Monaco side of the contributions, injected so this service stays UI-free. */
export interface ContributionBinding {
  /** Registers a language (Monaco can't unregister one; a second call for the same id is ignored). */
  registerLanguage: (language: ExtensionLanguageContribution) => void;
  /** Offers snippets as completions for a language; returns how to stop. */
  registerSnippets: (languageId: string, snippets: ExtensionSnippet[]) => () => void;
  /** The editor's actions for the palette and the context menu. */
  setEditorActions: (actions: ExtensionEditorAction[]) => void;
}

export interface ContributionDeps {
  ipc: IpcClient;
  events: EventBus<AppEvents>;
  registry: ExtensionRegistryService;
  host: ExtensionHostService;
  commands: CommandRegistry;
  binding: ContributionBinding;
  /** The Monaco language id of a document, for `onLanguage` activation. */
  languageOf: (docId: string) => string;
}

/**
 * What the enabled extensions add to the app: their commands (in the command registry, so menus, the
 * palette and shortcuts reach them — running one wakes its extension first), keybindings, menu items,
 * languages, snippets and colour themes. Everything is recomputed from the installed list, so enabling,
 * disabling and uninstalling take effect at once. UI-free.
 */
export class ExtensionContributionService implements ExtensionThemeSource {
  private readonly registered = new Set<string>();
  private snippetDisposers: (() => void)[] = [];
  private readonly languageTriggers = new Set<string>();
  private offs: (() => void)[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: ContributionDeps) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  initialize(): void {
    this.dispose();
    const { events } = this.deps;
    this.offs.push(
      events.on("extensionsChanged", () => {
        this.apply();
      }),
      events.on("documentOpened", ({ id }) => {
        this.languageOpened(this.deps.languageOf(id));
      }),
    );
    this.apply();
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off();
  }

  private enabled(): InstalledExtension[] {
    return this.deps.registry.enabled();
  }

  private label(extension: InstalledExtension, command: string): string | null {
    const contribution = extension.manifest.contributes.commands.find((c) => c.command === command);
    if (!contribution) return null;
    return contribution.category ? `${contribution.category}: ${contribution.title}` : contribution.title;
  }

  /** Commands hidden from the palette by a `commandPalette` menu entry whose `when` is `false`. */
  private hiddenFromPalette(extension: InstalledExtension): Set<string> {
    const entries = extension.manifest.contributes.menus.commandPalette ?? [];
    return new Set(entries.filter((entry) => entry.when?.trim() === "false").map((e) => e.command));
  }

  /** Recomputes and applies everything from the installed list. */
  apply(): void {
    this.syncCommands();
    this.deps.binding.setEditorActions(this.editorActions());
    for (const extension of this.enabled()) {
      for (const language of extension.manifest.contributes.languages) {
        this.deps.binding.registerLanguage(language);
      }
    }
    this.rebuildLanguageTriggers();
    void this.syncSnippets();
    for (const listener of this.listeners) listener();
  }

  // --- commands ---

  private syncCommands(): void {
    const wanted = new Map<string, InstalledExtension>();
    for (const extension of this.enabled()) {
      for (const contribution of extension.manifest.contributes.commands) {
        if (!wanted.has(contribution.command)) wanted.set(contribution.command, extension);
      }
    }
    for (const id of [...this.registered]) {
      if (!wanted.has(id)) {
        this.deps.commands.unregister(id);
        this.registered.delete(id);
      }
    }
    for (const id of wanted.keys()) {
      if (this.registered.has(id)) continue;
      if (this.deps.commands.has(id)) continue; // a built-in command keeps its id
      this.deps.commands.register(
        id,
        async (...args) => {
          await this.deps.host.executeCommand(id, args);
        },
        {
          enabled: () => this.blockedReason(id) === undefined,
          disabledReason: () => this.blockedReason(id),
        },
      );
      this.registered.add(id);
    }
  }

  /** Why a contributed command can't run right now (`undefined`: it can). */
  blockedReason(command: string): string | undefined {
    const owner = this.enabled().find((extension) =>
      extension.manifest.contributes.commands.some((c) => c.command === command),
    );
    const snapshot = this.deps.registry.getState().snapshot;
    if (owner === undefined || snapshot === null) return "The extension isn't available.";
    return commandBlockedReason(owner, this.deps.host.status(), snapshot.node);
  }

  /** The contributed commands with titles, for the shortcut list and the palette. */
  commandInfos(): CommandInfo[] {
    return this.enabled().flatMap((extension) =>
      extension.manifest.contributes.commands.map((command) => ({
        id: command.command,
        title: command.title,
        category: command.category ?? displayName(extension),
      })),
    );
  }

  /** The contributed keyboard shortcuts (owner `app`; a user's shortcut wins over them). */
  keybindings(): Keybinding[] {
    return this.enabled().flatMap((extension) =>
      extension.manifest.contributes.keybindings
        .filter((binding) =>
          extension.manifest.contributes.commands.some((c) => c.command === binding.command),
        )
        .map((binding) => ({
          key: binding.key,
          command: binding.command,
          owner: "app" as const,
          extension: extension.id,
        })),
    );
  }

  private editorActions(): ExtensionEditorAction[] {
    const actions: ExtensionEditorAction[] = [];
    // A command id contributed twice belongs to the first extension (the one that owns it in the registry).
    const seen = new Set<string>();
    for (const extension of this.enabled()) {
      const hidden = this.hiddenFromPalette(extension);
      const inContext = new Set(
        (extension.manifest.contributes.menus["editor/context"] ?? []).map((e) => e.command),
      );
      for (const contribution of extension.manifest.contributes.commands) {
        const label = this.label(extension, contribution.command);
        if (label === null || seen.has(contribution.command)) continue;
        seen.add(contribution.command);
        const inContextMenu = inContext.has(contribution.command);
        if (hidden.has(contribution.command) && !inContextMenu) continue;
        actions.push({ command: contribution.command, label, inContextMenu });
      }
    }
    return actions;
  }

  /** Items for the Explorer's right-click menu. */
  explorerItems(): ExtensionExplorerItem[] {
    return this.enabled().flatMap((extension) =>
      (extension.manifest.contributes.menus["explorer/context"] ?? []).flatMap((entry) => {
        const label = this.label(extension, entry.command);
        return label === null ? [] : [{ command: entry.command, label, group: entry.group }];
      }),
    );
  }

  // --- languages, activation on language ---

  /** The language an enabled extension contributes for this file name (by extension or exact file name). */
  languageForPath(path: string): string | null {
    const name = (path.split(/[/\\]/).pop() ?? path).toLowerCase();
    const dot = name.lastIndexOf(".");
    const extension = dot >= 0 ? name.slice(dot) : "";
    for (const ext of this.enabled()) {
      for (const language of ext.manifest.contributes.languages) {
        if (extension !== "" && language.extensions.some((e) => e.toLowerCase() === extension)) {
          return language.id;
        }
        if (language.filenames.some((file) => file.toLowerCase() === name)) return language.id;
      }
    }
    return null;
  }


  private rebuildLanguageTriggers(): void {
    this.languageTriggers.clear();
    for (const extension of this.enabled()) {
      for (const event of extension.activationEvents) {
        if (event.startsWith("onLanguage:")) this.languageTriggers.add(event.slice("onLanguage:".length));
      }
    }
  }

  /** A file of `language` opened: wake the extensions that asked for it. */
  languageOpened(language: string): void {
    if (this.languageTriggers.has(language)) {
      void this.deps.host.activateFor({ kind: "language", language });
    }
  }

  /** The app finished starting (and a folder may be open): wake what asked for that. */
  started(workspaceRoot: string | null): void {
    const events = this.enabled().flatMap((extension) => extension.activationEvents);
    if (events.some((event) => event === "*" || event === "onStartupFinished")) {
      void this.deps.host.activateFor({ kind: "startup" });
    }
    if (workspaceRoot !== null) this.workspaceOpened(workspaceRoot);
  }

  workspaceOpened(root: string): void {
    if (this.enabled().some((e) => e.activationEvents.some((v) => v.startsWith("workspaceContains:")))) {
      void this.deps.host.activateFor({ kind: "workspace", root });
    }
  }

  // --- snippets ---

  private async syncSnippets(): Promise<void> {
    for (const dispose of this.snippetDisposers.splice(0)) dispose();
    const byLanguage = new Map<string, ExtensionSnippet[]>();
    for (const extension of this.enabled()) {
      for (const contribution of extension.manifest.contributes.snippets) {
        try {
          const text = await this.deps.ipc.extReadFile(extension.id, contribution.path);
          const list = byLanguage.get(contribution.language) ?? [];
          byLanguage.set(contribution.language, [...list, ...parseSnippets(text)]);
        } catch (error) {
          this.deps.events.emit("appError", {
            message: `${displayName(extension)}: couldn't load ${contribution.path}: ${String(error)}`,
          });
        }
      }
    }
    for (const [language, snippets] of byLanguage) {
      this.snippetDisposers.push(this.deps.binding.registerSnippets(language, snippets));
    }
  }

  // --- themes ---

  /** The colour themes the enabled extensions offer, as `workbench.colorTheme` values. */
  themes(): { value: string; label: string; extension: string }[] {
    return this.enabled().flatMap((extension) =>
      extension.manifest.contributes.themes.map((theme) => ({
        value: `${EXTENSION_THEME_PREFIX}${extension.id}/${theme.label}`,
        label: theme.label,
        extension: displayName(extension),
      })),
    );
  }

  async load(value: string): Promise<LoadedExtensionTheme | null> {
    await this.deps.registry.ensureLoaded();
    const key = value.slice(EXTENSION_THEME_PREFIX.length);
    for (const extension of this.enabled()) {
      for (const theme of extension.manifest.contributes.themes) {
        if (`${extension.id}/${theme.label}` !== key) continue;
        const text = await this.deps.ipc.extReadFile(extension.id, theme.path);
        return parseExtensionTheme(text, theme.label, theme.uiTheme);
      }
    }
    return null;
  }
}
