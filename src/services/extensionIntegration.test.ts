import { afterEach, describe, expect, it, vi } from "vitest";

import { TEST_DEFINITIONS, makePreferences } from "../testUtils/preferencesFixture";
import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { CommandRegistry } from "./commandRegistry";
import type { DocumentService } from "./documentService";
import { EditorService, type CodeEditorLike } from "./editorService";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import { HostDocumentSync, CHANGE_DELAY_MS } from "./extensionHostSync";
import type { SettingDefinition } from "./ipc";
import { type Keybinding, KeybindingService } from "./keybindings";
import { KeybindingsManager } from "./keybindingsManager";
import { effectiveBindings } from "./keybindingsModel";
import { SettingsService } from "./settingsService";
import { type SchemeQuery, ThemeService } from "./themeService";
import type { LoadedExtensionTheme } from "./extensionTheme";

const DEFAULTS: Keybinding[] = [
  { key: "Ctrl+S", command: "file.save", owner: "app" },
  { key: "Ctrl+Alt+H", command: "help.about", owner: "app" },
];
const FROM_EXTENSION: Keybinding[] = [
  { key: "Ctrl+Alt+H", command: "sampleCommand.hello", owner: "app", extension: "openmind-samples.sample-command" },
  { key: "Ctrl+Alt+J", command: "sampleCommand.other", owner: "app", extension: "openmind-samples.sample-command" },
];

describe("extension keybindings", () => {
  it("are merged after the built-in shortcuts and marked as coming from an extension", () => {
    const list = effectiveBindings([...DEFAULTS, ...FROM_EXTENSION], []);
    expect(list.map((binding) => binding.source)).toEqual(["default", "default", "extension", "extension"]);
  });

  it("a user shortcut overrides an extension's, and can remove it", () => {
    const list = effectiveBindings(
      [...DEFAULTS, ...FROM_EXTENSION],
      [
        { key: "Ctrl+Alt+K", command: "sampleCommand.hello" },
        { key: "Ctrl+Alt+H", command: "-sampleCommand.hello" },
      ],
    );
    expect(list.filter((binding) => binding.command === "sampleCommand.hello")).toEqual([
      { key: "Ctrl+Alt+K", command: "sampleCommand.hello", owner: "app", source: "user" },
    ]);
  });

  function manager(extra: () => readonly Keybinding[]) {
    const commands = new CommandRegistry();
    const service = new KeybindingService(commands, []);
    const ipc = createFakeIpc({
      keybindingsLoad: vi.fn().mockResolvedValue({ entries: [], error: null }),
    });
    const keybindings = new KeybindingsManager(ipc, service, {
      defaults: DEFAULTS,
      extra,
      catalog: () => [
        { id: "file.save", title: "Save", category: "File" },
        { id: "help.about", title: "About", category: "Help" },
        { id: "sampleCommand.hello", title: "Say Hello", category: "Sample" },
        { id: "sampleCommand.other", title: "Other", category: "Sample" },
      ],
      remappable: () => false,
      syncEditor: () => undefined,
    });
    return { keybindings, service };
  }

  it("show in the Keyboard Shortcuts list with their extension, and conflicts are detected", async () => {
    const { keybindings, service } = manager(() => FROM_EXTENSION);
    await keybindings.initialize();
    const rows = keybindings.rows("");
    const hello = rows.find((row) => row.command === "sampleCommand.hello");
    expect(hello).toMatchObject({
      keys: ["Ctrl+Alt+H"],
      source: "extension",
      extension: "openmind-samples.sample-command",
      conflicts: ["About"],
    });
    const other = rows.find((row) => row.command === "sampleCommand.other");
    expect(other?.conflicts).toEqual([]);
    // The built-in command keeps the key when both are enabled (it comes first).
    expect(service.getBindings().find((binding) => binding.key === "Ctrl+Alt+H")?.command).toBe("help.about");
  });

  it("follow the extensions: refresh applies newly contributed shortcuts", async () => {
    let contributed: Keybinding[] = [];
    const { keybindings, service } = manager(() => contributed);
    await keybindings.initialize();
    expect(service.getBindings().some((binding) => binding.command === "sampleCommand.other")).toBe(false);
    contributed = FROM_EXTENSION;
    keybindings.refresh();
    expect(service.getBindings().some((binding) => binding.command === "sampleCommand.other")).toBe(true);
    contributed = [];
    keybindings.refresh();
    expect(service.getBindings().some((binding) => binding.command === "sampleCommand.other")).toBe(false);
  });
});

describe("contributed settings", () => {
  const greeting: SettingDefinition = {
    id: "sampleConfig.greeting",
    category: "Sample Configuration",
    title: "Greeting",
    description: "The greeting the sample shows.",
    kind: { type: "text", maxLength: 50 },
    default: "Hello",
    scope: "both",
  };

  it("appear in the Settings list under the extension's own category, with their values", async () => {
    const ipc = createFakeIpc({
      preferencesLoad: vi.fn().mockResolvedValue({
        ...makePreferences({ values: { "sampleConfig.greeting": "Howdy" } }),
        definitions: [...TEST_DEFINITIONS, greeting],
        categories: ["Editor", "Terminal", "Workbench", "Sample Configuration"],
      }),
    });
    const settings = new SettingsService(ipc, new EventBus<AppEvents>());
    await settings.initialize();
    const groups = settings.search("greeting");
    expect(groups.map((group) => group.category)).toEqual(["Sample Configuration"]);
    expect(groups[0]?.settings[0]?.id).toBe("sampleConfig.greeting");
    expect(settings.string("sampleConfig.greeting", "")).toBe("Howdy");
    // The host reads the same effective values.
    expect(settings.values()["sampleConfig.greeting"]).toBe("Howdy");
  });
});

describe("extension colour themes", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("style");
  });

  function rig(value: string, load: (value: string) => Promise<LoadedExtensionTheme | null>) {
    const ipc = createFakeIpc({
      preferencesLoad: vi
        .fn()
        .mockResolvedValue(makePreferences({ values: { "workbench.colorTheme": value } })),
    });
    const events = new EventBus<AppEvents>();
    const notices: string[] = [];
    events.on("appNotice", ({ message }) => notices.push(message));
    const themed: string[] = [];
    events.on("themeChanged", ({ theme }) => themed.push(theme));
    const settings = new SettingsService(ipc, events);
    const scheme: SchemeQuery = {
      matches: true,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    const theme = new ThemeService(settings, events, () => scheme);
    theme.setExtensionThemeSource({ load });
    return { theme, notices, themed };
  }

  const night: LoadedExtensionTheme = {
    label: "Night",
    kind: "dark",
    monaco: { base: "vs-dark", inherit: true, rules: [], colors: { "editor.background": "#101820" } },
    tokens: { "--editor-bg": "#101820" },
  };

  it("apply their colours through the app's colour tokens and Monaco", async () => {
    const { theme, themed } = rig("extension:openmind-samples.sample-theme/Night", () => Promise.resolve(night));
    await theme.initialize();
    await vi.waitFor(() => {
      expect(document.documentElement.style.getPropertyValue("--editor-bg")).toBe("#101820");
    });
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(theme.getExtensionTheme()).toBe("extension:openmind-samples.sample-theme/Night");
    expect(themed).toContain("dark");
  });

  it("fall back to Dark, and say so, when the theme's extension is gone", async () => {
    const { theme, notices } = rig("extension:gone.ext/Missing", () => Promise.resolve(null));
    await theme.initialize();
    await vi.waitFor(() => {
      expect(notices).toHaveLength(1);
    });
    expect(notices[0]).toContain("using Dark");
    expect(theme.getExtensionTheme()).toBeNull();
    expect(document.documentElement.style.getPropertyValue("--editor-bg")).toBe("");
  });
});

describe("the editor's extension actions", () => {
  it("are added to every editor (palette and context menu) and replaced when they change", () => {
    const disposed: string[] = [];
    const added: { id: string; label: string; contextMenuGroupId?: string }[] = [];
    const editor = {
      addAction: (action: { id: string; label: string; contextMenuGroupId?: string }) => {
        added.push(action);
        return { dispose: () => disposed.push(action.id) };
      },
      focus: vi.fn(),
      trigger: vi.fn(),
      setSelection: vi.fn(),
      revealRangeInCenter: vi.fn(),
      onDidFocusEditorWidget: () => ({ dispose: vi.fn() }),
      updateOptions: vi.fn(),
      getSelections: () => [],
      getModel: () => null,
      onDidChangeCursorSelection: () => ({ dispose: vi.fn() }),
      onDidChangeModel: () => ({ dispose: vi.fn() }),
      onDidChangeModelLanguage: () => ({ dispose: vi.fn() }),
      onDidChangeModelOptions: () => ({ dispose: vi.fn() }),
    } as unknown as CodeEditorLike;
    const service = new EditorService(createFakeIpc());
    const ran: string[] = [];
    service.setActionRunner((command) => ran.push(command));
    service.setExtensionActions([{ command: "a.b", label: "Sample: A", inContextMenu: true }]);
    const detach = service.attach(editor);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ id: "extension.a.b", label: "Sample: A", contextMenuGroupId: "9_extensions" });
    service.setExtensionActions([{ command: "c.d", label: "Sample: C", inContextMenu: false }]);
    expect(disposed).toEqual(["extension.a.b"]);
    expect(added[1]).toMatchObject({ id: "extension.c.d", contextMenuGroupId: undefined });
    detach();
    expect(disposed).toEqual(["extension.a.b", "extension.c.d"]);
    expect(ran).toEqual([]);
  });
});

describe("HostDocumentSync", () => {
  function documentsRig() {
    const texts = new Map<string, string>([["doc-1", "one"]]);
    const listeners = new Map<string, () => void>();
    const documents = {
      fileBackedIds: () => [...texts.keys()],
      has: (id: string) => texts.has(id),
      snapshot: (id: string) => ({ id, path: `C:/My Site/${id}.txt`, dirty: false }),
      languageOf: () => "plaintext",
      contentOf: (id: string) => texts.get(id) ?? "",
      onDidChangeContent: (id: string, listener: () => void) => {
        listeners.set(id, listener);
        return () => listeners.delete(id);
      },
    } as unknown as DocumentService;
    const events = new EventBus<AppEvents>();
    const sent: [string, unknown][] = [];
    const sync = new HostDocumentSync({ documents, events, notify: (method, params) => sent.push([method, params]) });
    return { texts, listeners, events, sent, sync };
  }

  it("starts from the open files and tells the host about opens, edits and closes", () => {
    vi.useFakeTimers();
    try {
      const { texts, listeners, events, sent, sync } = documentsRig();
      expect(sync.initial().documents).toEqual([
        { path: "C:/My Site/doc-1.txt", languageId: "plaintext", version: 1, text: "one", isDirty: false },
      ]);
      sync.start();
      texts.set("doc-1", "one two");
      listeners.get("doc-1")?.();
      listeners.get("doc-1")?.();
      expect(sent).toEqual([]);
      vi.advanceTimersByTime(CHANGE_DELAY_MS + 1);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.[0]).toBe("host/documentChanged");
      expect(sent[0]?.[1]).toMatchObject({ text: "one two", version: 2 });

      texts.set("doc-2", "two");
      events.emit("documentOpened", { id: "doc-2" });
      expect(sent[1]?.[0]).toBe("host/documentOpened");
      events.emit("tabsChanged", { tabs: [], activeId: "doc-2" });
      expect(sent[2]).toEqual(["host/activeEditorChanged", { editor: { path: "C:/My Site/doc-2.txt" } }]);
      events.emit("documentClosed", { id: "doc-2", path: "C:/My Site/doc-2.txt" });
      expect(sent[3]).toEqual(["host/documentClosed", { path: "C:/My Site/doc-2.txt" }]);
      sync.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("flush sends a pending edit at once, so a language feature sees the current text", () => {
    vi.useFakeTimers();
    try {
      const { texts, listeners, sent, sync } = documentsRig();
      sync.start();
      texts.set("doc-1", "changed");
      listeners.get("doc-1")?.();
      sync.flush();
      expect(sent).toHaveLength(1);
      vi.advanceTimersByTime(CHANGE_DELAY_MS * 2);
      expect(sent).toHaveLength(1);
      sync.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
