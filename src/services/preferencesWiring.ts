import { REMAPPABLE_EDITOR_COMMANDS, syncMonacoDefaults } from "../editor/monacoKeys";
import type { CommandRegistry } from "./commandRegistry";
import type { DocumentService } from "./documentService";
import { EDITOR_SETTING_IDS, type EditorService } from "./editorService";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { IpcClient } from "./ipc";
import { DEFAULT_KEYBINDINGS, type KeybindingService } from "./keybindings";
import { KeybindingsManager } from "./keybindingsManager";
import { commandCatalog, type CommandInfo } from "./keybindingsModel";
import type { LspService } from "./lspService";
import { buildMenuBar } from "./menus";
import { watchPreferenceFiles } from "./preferenceFiles";
import { PreferencesPageService } from "./preferencesPageService";
import { registerPreferencesCommands } from "./preferencesCommands";
import type { PhpServerService } from "./phpServerService";
import type { SearchService } from "./searchService";
import type { SettingsService } from "./settingsService";
import type { ThemeService } from "./themeService";

export interface PreferencesWiringDeps {
  ipc: IpcClient;
  events: EventBus<AppEvents>;
  commands: CommandRegistry;
  settings: SettingsService;
  theme: ThemeService;
  keybindings: KeybindingService;
  documents: DocumentService;
  editor: EditorService;
  search: SearchService;
  lsp: LspService;
  php: PhpServerService;
  openFile: (path: string) => Promise<unknown>;
}

const SEARCH_SETTINGS = [
  "search.caseSensitive",
  "search.useRegex",
  "search.wholeWord",
  "search.include",
  "search.exclude",
];

/**
 * Connects the settings and the keyboard shortcuts to everything that follows them: open editors,
 * the search defaults, language servers, the PHP server's default port, the shortcut listener and
 * Monaco's own bindings. Called once by the composition root.
 */
export function wirePreferences(deps: PreferencesWiringDeps) {
  const { ipc, events, commands, settings, theme, keybindings, documents, editor } = deps;
  const page = new PreferencesPageService();

  let catalog: CommandInfo[] | null = null;
  let monacoRules: { dispose: () => void } | null = null;
  const keybindingsManager = new KeybindingsManager(ipc, keybindings, {
    defaults: DEFAULT_KEYBINDINGS,
    catalog: () => {
      catalog ??= commandCatalog(
        buildMenuBar({ folders: [], files: [] }),
        DEFAULT_KEYBINDINGS,
        (id) => commands.has(id),
      );
      return catalog;
    },
    remappable: (command) => REMAPPABLE_EDITOR_COMMANDS.has(command),
    syncEditor: (removed) => {
      monacoRules = syncMonacoDefaults(removed, monacoRules);
    },
  });

  registerPreferencesCommands({
    commands,
    page,
    settings,
    keybindings: keybindingsManager,
    theme,
    openFile: deps.openFile,
    events,
  });

  const applySearchDefaults = () => {
    deps.search.applyDefaults({
      options: {
        caseSensitive: settings.bool("search.caseSensitive", false),
        useRegex: settings.bool("search.useRegex", false),
        wholeWord: settings.bool("search.wholeWord", false),
      },
      include: settings.string("search.include", ""),
      exclude: settings.string("search.exclude", ""),
    });
  };

  /** Loads the settings and shortcuts and starts following them. Runs before anything reads a setting. */
  async function startSettings(): Promise<void> {
    await settings.initialize();
    await keybindingsManager.initialize();
    applySearchDefaults();
    void deps.lsp.setVerbose(settings.bool("lsp.verboseLogging", false));
    settings.onChange(EDITOR_SETTING_IDS, () => {
      editor.refreshFromSettings();
    });
    settings.onChange(SEARCH_SETTINGS, applySearchDefaults);
    settings.onChange(["lsp.enabled"], () => {
      void deps.lsp.applyEnabled();
    });
    settings.onChange(["lsp.verboseLogging"], () => {
      void deps.lsp.setVerbose(settings.bool("lsp.verboseLogging", false));
    });
    settings.onChange(["php.server.defaultPort"], () => {
      deps.php.applyDefaultPort();
    });
    // Another folder has other workspace settings; another window may have changed a file.
    events.on("workspaceFolderChanged", () => {
      void settings.reload();
    });
    if (typeof window !== "undefined") {
      window.addEventListener("focus", () => {
        void settings.reload();
        void keybindingsManager.reload();
      });
    }
    watchPreferenceFiles({
      events,
      settings,
      keybindings: keybindingsManager,
      contentOf: (id) => documents.contentOf(id),
    });
  }

  return { page, keybindingsManager, startSettings };
}
