import { describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { makePreferences } from "../testUtils/preferencesFixture";
import { BreakpointService } from "./breakpointService";
import { DebugConfigurationService } from "./debugConfigurationService";
import { DebugConsoleService } from "./debugConsoleService";
import { DebugService } from "./debugService";
import { EditorService, type CodeEditorLike } from "./editorService";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { DebugStatus } from "./ipc";
import { OutputService } from "./outputService";
import { PanelService } from "./panelService";
import { PhpServerService } from "./phpServerService";
import { PortsService } from "./portsService";
import { RuntimeService } from "./runtimeService";
import { SearchService } from "./searchService";
import { SettingsService } from "./settingsService";
import { WelcomeService } from "./welcomeService";

/** A settings service over an in-memory backend, so tests can change a setting the way the page does. */
async function settingsRig(values: Record<string, boolean | number | string> = {}) {
  const store = { ...values };
  const ipc = createFakeIpc({
    preferencesLoad: vi
      .fn()
      .mockImplementation(() => Promise.resolve(makePreferences({ values: store }))),
    preferencesSet: vi
      .fn()
      .mockImplementation((_scope: string, id: string, value: boolean | number | string) => {
        store[id] = value;
        return Promise.resolve(makePreferences({ values: store }));
      }),
  });
  const events = new EventBus<AppEvents>();
  const settings = new SettingsService(ipc, events);
  await settings.initialize();
  return { ipc, events, settings, store };
}

function fakeEditor() {
  const calls: Record<string, unknown>[] = [];
  const editor = {
    focus: vi.fn(),
    trigger: vi.fn(),
    setSelection: vi.fn(),
    revealRangeInCenter: vi.fn(),
    onDidFocusEditorWidget: () => ({ dispose: () => undefined }),
    updateOptions: (options: Record<string, unknown>) => {
      calls.push(options);
    },
    getSelections: () => null,
    getModel: () => null,
    onDidChangeCursorSelection: () => ({ dispose: () => undefined }),
    onDidChangeModel: () => ({ dispose: () => undefined }),
    onDidChangeModelLanguage: () => ({ dispose: () => undefined }),
    onDidChangeModelOptions: () => ({ dispose: () => undefined }),
  } as unknown as CodeEditorLike;
  return { editor, calls, last: () => calls[calls.length - 1] };
}

describe("editor settings", () => {
  it("an attached editor gets the font, tab and cursor settings", async () => {
    const { ipc, settings } = await settingsRig({
      "editor.fontSize": 20,
      "editor.fontFamily": "Cascadia Code",
      "editor.lineNumbers": "relative",
    });
    const service = new EditorService(ipc, settings);
    const { editor, last } = fakeEditor();

    service.attach(editor);

    expect(last()).toMatchObject({
      fontSize: 20,
      fontFamily: "Cascadia Code",
      lineNumbers: "relative",
      tabSize: 4,
      insertSpaces: true,
      cursorBlinking: "blink",
      wordWrap: "off",
    });
  });

  it("changing a setting reaches open editors at once, and a workspace value counts too", async () => {
    const { ipc, settings } = await settingsRig();
    const service = new EditorService(ipc, settings);
    const { editor, last } = fakeEditor();
    service.attach(editor);
    settings.onChange(["editor.fontSize", "editor.wordWrap"], () => {
      service.refreshFromSettings();
    });

    await settings.set("user", "editor.fontSize", 24);
    expect(last()).toMatchObject({ fontSize: 24 });

    await settings.set("user", "editor.wordWrap", true);
    expect(last()).toMatchObject({ wordWrap: "on" });
    expect(service.getOptions().wordWrap).toBe(true);
  });

  it("the View menu toggles write the setting instead of a private value", async () => {
    const { ipc, settings, store } = await settingsRig();
    const service = new EditorService(ipc, settings);

    await service.toggleOption("wordWrap");

    expect(store["editor.wordWrap"]).toBe(true);
    expect(ipc.settingsSet).not.toHaveBeenCalled();
    // A toggle that is not a setting keeps its own storage.
    await service.toggleOption("columnSelection");
    expect(ipc.settingsSet).toHaveBeenCalledWith(
      "editor.viewOptions",
      expect.stringContaining("columnSelection"),
    );
  });

  it("toggles saved before settings existed move into the settings file once", async () => {
    const { ipc, settings, store } = await settingsRig();
    (ipc.settingsGet as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({ wordWrap: true, minimap: false, columnSelection: true }),
    );
    const service = new EditorService(ipc, settings);

    await service.initialize();

    expect(store["editor.wordWrap"]).toBe(true);
    expect(store["editor.minimap"]).toBe(false);
    expect(store["editor.stickyScroll"]).toBeUndefined(); // it was never changed
    expect(service.getOptions()).toMatchObject({
      wordWrap: true,
      minimap: false,
      columnSelection: true,
    });
    const rewritten = (ipc.settingsSet as ReturnType<typeof vi.fn>).mock.calls.at(
      -1,
    )?.[1] as string;
    expect(JSON.parse(rewritten)).toEqual(expect.objectContaining({ columnSelection: true }));
    expect(JSON.parse(rewritten)).not.toHaveProperty("wordWrap");
  });
});

describe("search settings", () => {
  const defaults = (over: { caseSensitive?: boolean; include?: string } = {}) => ({
    options: { caseSensitive: over.caseSensitive ?? false, useRegex: false, wholeWord: false },
    include: over.include ?? "",
    exclude: "",
  });

  function searchService() {
    const ipc = createFakeIpc();
    return new SearchService(ipc, new EventBus<AppEvents>(), new OutputService(), () => null, {
      openPathAt: () => Promise.resolve(null),
    });
  }

  it("the fields start with the defaults from the settings", () => {
    const search = searchService();

    search.applyDefaults(defaults({ caseSensitive: true, include: "src/**" }));

    expect(search.getState().options.caseSensitive).toBe(true);
    expect(search.getState().include).toBe("src/**");
  });

  it("a field the user changed keeps their value when the default changes", () => {
    const search = searchService();
    search.applyDefaults(defaults({ include: "src/**" }));
    search.setInclude("lib/**");

    search.applyDefaults(defaults({ include: "docs/**" }));

    expect(search.getState().include).toBe("lib/**");
  });

  it("an untouched field follows the setting", () => {
    const search = searchService();
    search.applyDefaults(defaults({ caseSensitive: true }));
    search.applyDefaults(defaults({ caseSensitive: false }));

    expect(search.getState().options.caseSensitive).toBe(false);
  });
});

describe("welcome page setting", () => {
  it("showing it on startup is the setting, and turning it off writes the setting", async () => {
    const { ipc, settings, store } = await settingsRig({ "workbench.welcomeOnStartup": false });
    const welcome = new WelcomeService(ipc, settings);

    await welcome.initialize();
    expect(welcome.getState()).toMatchObject({ showOnStartup: false, open: false });

    await welcome.setShowOnStartup(true);
    expect(store["workbench.welcomeOnStartup"]).toBe(true);
    expect(ipc.settingsSet).not.toHaveBeenCalled();
  });

  it("a choice made before settings existed is moved into the settings file", async () => {
    const { ipc, settings, store } = await settingsRig();
    (ipc.settingsGet as ReturnType<typeof vi.fn>).mockResolvedValue("false");
    const welcome = new WelcomeService(ipc, settings);

    await welcome.initialize();

    expect(store["workbench.welcomeOnStartup"]).toBe(false);
    expect(welcome.getState().open).toBe(false);
  });
});

describe("PHP server default port", () => {
  async function phpRig(values: Record<string, number>, saved: string | null = null) {
    const { ipc, settings } = await settingsRig(values);
    vi.mocked(ipc.settingsGet).mockImplementation((key: string) =>
      Promise.resolve(key === "php.server" ? saved : null),
    );
    const events = new EventBus<AppEvents>();
    const output = new OutputService();
    const php = new PhpServerService(
      ipc,
      events,
      output,
      new RuntimeService(ipc, events, () => undefined),
      new PortsService(ipc, events),
      new PanelService(ipc),
      () => settings.number("php.server.defaultPort", 8000),
    );
    return { php, settings, ipc };
  }

  it("uses the setting until the user picks a port", async () => {
    const { php } = await phpRig({ "php.server.defaultPort": 8123 });
    await php.initialize();
    expect(php.getState().port).toBe(8123);
  });

  it("a port the user chose beats the setting, even when the setting changes", async () => {
    const { php, settings } = await phpRig(
      { "php.server.defaultPort": 8123 },
      JSON.stringify({ port: 9001 }),
    );
    await php.initialize();
    expect(php.getState().port).toBe(9001);

    await settings.set("user", "php.server.defaultPort", 8200);
    php.applyDefaultPort();

    expect(php.getState().port).toBe(9001);
  });

  it("an unchosen port follows a change of the setting", async () => {
    const { php, settings } = await phpRig({});
    await php.initialize();
    expect(php.getState().port).toBe(8000);

    await settings.set("user", "php.server.defaultPort", 8200);
    php.applyDefaultPort();

    expect(php.getState().port).toBe(8200);
  });
});

describe("debugger settings", () => {
  it("Stop on Entry adds stopOnEntry to the launch configuration", async () => {
    const ready = {
      target: "python",
      ready: true,
      problem: null,
      interpreter: "Python",
      installKind: null,
    };
    const status: DebugStatus = {
      workspace: "C:/My Site",
      run: null,
      python: ready as DebugStatus["python"],
      node: { ...ready, target: "node" },
      php: {
        ...ready,
        target: "php",
        ready: false,
        problem: "PHP debugging requires Xdebug and is not available yet.",
      },
    };
    const ipc = createFakeIpc({
      debugStatus: vi.fn().mockResolvedValue(status),
      debugStart: vi
        .fn()
        .mockResolvedValue({
          runId: 1,
          configName: "Python: Current File",
          target: "python",
          state: "starting",
          program: "C:/My Site/a.py",
          pid: 1,
        }),
    });
    const events = new EventBus<AppEvents>();
    const stop = { current: true };
    const debug = new DebugService(
      ipc,
      events,
      new BreakpointService(ipc, () => false),
      new DebugConfigurationService(),
      new DebugConsoleService(
        () => Promise.resolve({ result: "", type: null, variablesReference: 0 }),
        () => null,
      ),
      {
        activeFile: () => ({ path: "C:/My Site/a.py", docId: "d" }),
        saveIfDirty: () => Promise.resolve(true),
        workspacePath: () => "C:/My Site",
        showConsole: () => undefined,
        log: () => undefined,
        stopOnEntry: () => stop.current,
      },
    );
    await debug.refreshStatus();

    await debug.start();
    expect(ipc.debugStart).toHaveBeenLastCalledWith(
      expect.objectContaining({ stopOnEntry: true }),
      [],
    );

    stop.current = false;
    (ipc.debugStart as ReturnType<typeof vi.fn>).mockClear();
    const second = await debug.start();
    // A session is already starting, so a second start is refused; the first call's flag is what counts.
    expect(second).toBe(false);
  });
});
