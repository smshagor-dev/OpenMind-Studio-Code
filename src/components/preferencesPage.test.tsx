import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { makePreferences, type FixtureOptions } from "../testUtils/preferencesFixture";
import { CommandRegistry } from "../services/commandRegistry";
import { EventBus } from "../services/eventBus";
import type { AppEvents } from "../services/events";
import type { IpcClient, KeybindingEntry, SettingValue } from "../services/ipc";
import { KeybindingService, type Keybinding } from "../services/keybindings";
import { KeybindingsManager } from "../services/keybindingsManager";
import { PreferencesPageService } from "../services/preferencesPageService";
import { SettingsService } from "../services/settingsService";

const harness = vi.hoisted((): { current: unknown } => ({ current: null }));

vi.mock("../services/container", () => ({
  get container() {
    return harness.current;
  },
}));
vi.mock("../appHooks", () => ({ useCommandStateRefresh: () => undefined }));

import { PreferencesPage } from "./PreferencesPage";

const DEFAULTS: Keybinding[] = [
  { key: "Ctrl+S", command: "file.save", owner: "app" },
  { key: "F5", command: "debug.start", owner: "app" },
  { key: "F12", command: "go.toDefinition", owner: "editor" },
  { key: "Ctrl+D", command: "selection.addNextOccurrence", owner: "editor" },
];

interface Rig {
  ipc: IpcClient;
  settings: SettingsService;
  page: PreferencesPageService;
  keybindings: KeybindingService;
  manager: KeybindingsManager;
  commands: CommandRegistry;
  run: ReturnType<typeof vi.fn>;
}

async function open(
  tab: "settings" | "keybindings",
  fixture: FixtureOptions = {},
  overrides: Partial<IpcClient> = {},
  savedEntries: KeybindingEntry[] = [],
): Promise<Rig> {
  const store: Record<string, SettingValue> = { ...fixture.values };
  let entries = savedEntries;
  const ipc = createFakeIpc({
    preferencesLoad: vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          makePreferences({ ...fixture, values: store, userSet: Object.keys(store) }),
        ),
      ),
    preferencesSet: vi
      .fn()
      .mockImplementation((_scope: string, id: string, value: SettingValue) => {
        store[id] = value;
        return Promise.resolve(
          makePreferences({ ...fixture, values: store, userSet: Object.keys(store) }),
        );
      }),
    preferencesReset: vi.fn().mockImplementation((_scope: string, id: string) => {
      Reflect.deleteProperty(store, id);
      return Promise.resolve(
        makePreferences({ ...fixture, values: store, userSet: Object.keys(store) }),
      );
    }),
    keybindingsLoad: vi.fn().mockImplementation(() => Promise.resolve({ entries, error: null })),
    keybindingsSave: vi.fn().mockImplementation((next: KeybindingEntry[]) => {
      entries = next;
      return Promise.resolve(next);
    }),
    ...overrides,
  });
  const events = new EventBus<AppEvents>();
  const settings = new SettingsService(ipc, events);
  await settings.initialize();
  const commands = new CommandRegistry();
  const keybindings = new KeybindingService(commands, DEFAULTS);
  const manager = new KeybindingsManager(ipc, keybindings, {
    defaults: DEFAULTS,
    catalog: () => [
      { id: "file.save", title: "Save", category: "File" },
      { id: "debug.start", title: "Start Debugging", category: "Run" },
      { id: "run.code", title: "Run Code", category: "Run" },
      { id: "go.toDefinition", title: "Go to Definition", category: "Go" },
      { id: "selection.addNextOccurrence", title: "Add Next Occurrence", category: "Selection" },
    ],
    remappable: (command) => command === "go.toDefinition",
    syncEditor: () => undefined,
  });
  await manager.initialize();
  const page = new PreferencesPageService();
  const run = vi.fn();
  commands.register("preferences.openSettingsJson", () => undefined);
  commands.register("preferences.openKeybindingsJson", () => undefined);
  harness.current = {
    settings,
    keybindingsManager: manager,
    preferencesPage: page,
    commands,
    run,
  };
  page.open(tab);
  render(<PreferencesPage />);
  return { ipc, settings, page, keybindings, manager, commands, run };
}

describe("Settings page", () => {
  beforeEach(() => {
    harness.current = null;
  });

  it("is hidden until it is opened, and closes with its ×", async () => {
    const r = await open("settings");
    expect(screen.getByRole("region", { name: "Settings" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));

    expect(r.page.getState().open).toBe(false);
    expect(screen.queryByLabelText("Settings and keyboard shortcuts")).toBeNull();
  });

  it("lists the categories with their counts and every setting under them", async () => {
    await open("settings");

    const nav = screen.getByRole("navigation", { name: "Settings categories" });
    expect(within(nav).getByRole("button", { name: /All Settings/ })).toHaveTextContent("7");
    expect(within(nav).getByRole("button", { name: /^Language/ })).toHaveTextContent("1");
    expect(within(nav).getByRole("button", { name: /^Editor/ })).toHaveTextContent("4");
    expect(within(nav).getByRole("button", { name: /^Terminal/ })).toHaveTextContent("1");
    expect(within(nav).getByRole("button", { name: /^Workbench/ })).toHaveTextContent("1");
    expect(screen.getAllByText("Font Size", { selector: ".prefs-row__title" })).toHaveLength(2);
  });

  it("picking a category shows only its settings", async () => {
    await open("settings");

    fireEvent.click(screen.getByRole("button", { name: /^Terminal/ }));

    const list = screen.getByRole("region", { name: "Settings" });
    expect(within(list).getByText("terminal.fontSize")).toBeInTheDocument();
    expect(within(list).queryByText("editor.wordWrap")).toBeNull();
  });

  it("searching filters by any word and says so when nothing matches", async () => {
    await open("settings");

    fireEvent.change(screen.getByLabelText("Search settings"), { target: { value: "wrap" } });
    const list = screen.getByRole("region", { name: "Settings" });
    expect(within(list).getByText("editor.wordWrap")).toBeInTheDocument();
    expect(within(list).queryByText("editor.fontSize")).toBeNull();

    fireEvent.change(screen.getByLabelText("Search settings"), { target: { value: "nonsense" } });
    expect(screen.getByRole("status")).toHaveTextContent("No settings match");
  });

  it("Settings > Language lists every language, and picking one saves it", async () => {
    const r = await open("settings");
    fireEvent.click(screen.getByRole("button", { name: /^Language/ }));
    const list = screen.getByRole("region", { name: "Settings" });
    const group = within(list).getByRole("radiogroup", { name: "Display Language" });
    const choices = within(group).getAllByRole("radio");
    expect(choices.map((c) => (c as HTMLInputElement).value)).toEqual(["system", "en", "ru", "bn"]);
    expect(within(group).getByText("Русский (Russian)")).toBeInTheDocument();
    expect(within(group).getByText("বাংলা (Bangla)")).toBeInTheDocument();
    expect(choices[0]).toBeChecked();
    fireEvent.click(within(group).getByRole("radio", { name: "Русский (Russian)" }));
    await waitFor(() => {
      expect(r.ipc.preferencesSet).toHaveBeenCalledWith("user", "workbench.language", "ru");
    });
    await waitFor(() => {
      expect(within(group).getByRole("radio", { name: "Русский (Russian)" })).toBeChecked();
    });
    // The dropdown is not used for it.
    expect(within(list).queryByRole("combobox", { name: "Display Language" })).toBeNull();
  });

  it("Display Language... opens Settings on the Language section", async () => {
    const r = await open("settings");
    act(() => {
      r.page.close();
      r.page.open("settings", { scope: "user", category: "Language" });
    });
    expect(r.page.getState().category).toBe("Language");
    const list = screen.getByRole("region", { name: "Settings" });
    expect(within(list).getByRole("radiogroup", { name: "Display Language" })).toBeInTheDocument();
    expect(within(list).queryByText("editor.wordWrap")).toBeNull();
  });

  it("a boolean is a checkbox that saves as soon as it is toggled", async () => {
    const r = await open("settings");

    fireEvent.click(screen.getByLabelText(/Word Wrap/, { selector: "input" }));

    await waitFor(() => {
      expect(r.ipc.preferencesSet).toHaveBeenCalledWith("user", "editor.wordWrap", true);
    });
    await waitFor(() => {
      expect(screen.getByLabelText(/Word Wrap/, { selector: "input" })).toBeChecked();
    });
  });

  it("a number saves on Enter, is marked modified and can be reset to its default", async () => {
    const r = await open("settings");
    const input = screen.getByLabelText(/Editor: Font Size/);

    fireEvent.change(input, { target: { value: "18" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(r.ipc.preferencesSet).toHaveBeenCalledWith("user", "editor.fontSize", 18);
    });
    const reset = await screen.findByRole("button", { name: "Reset Font Size" });
    expect(screen.getAllByText("Modified").length).toBe(1);

    fireEvent.click(reset);
    await waitFor(() => {
      expect(r.ipc.preferencesReset).toHaveBeenCalledWith("user", "editor.fontSize");
    });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Reset Font Size" })).toBeNull();
    });
    expect(screen.getByLabelText(/Editor: Font Size/)).toHaveValue("14");
  });

  it("text that isn't a whole number is refused on the spot, without asking the backend", async () => {
    const r = await open("settings");
    const input = screen.getByLabelText(/Editor: Font Size/);

    fireEvent.change(input, { target: { value: "big" } });
    fireEvent.blur(input);

    expect(screen.getByRole("alert")).toHaveTextContent("Font Size must be a whole number.");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(r.ipc.preferencesSet).not.toHaveBeenCalled();
  });

  it("a number the backend refuses shows its message next to the setting", async () => {
    await open(
      "settings",
      {},
      {
        preferencesSet: vi.fn().mockRejectedValue(new Error("Font Size must be between 8 and 40.")),
      },
    );
    const input = screen.getByLabelText(/Editor: Font Size/);

    fireEvent.change(input, { target: { value: "99" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByRole("alert")).toHaveTextContent("between 8 and 40");
    expect(input).toHaveValue("99");
  });

  it("Escape puts a half-typed value back", async () => {
    await open("settings");
    const input = screen.getByLabelText(/Editor: Font Size/);

    fireEvent.change(input, { target: { value: "17" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(input).toHaveValue("14");
  });

  it("a text setting saves when it loses focus", async () => {
    const r = await open("settings");
    const input = screen.getByLabelText(/Editor: Font Family/);

    fireEvent.change(input, { target: { value: "Cascadia Code" } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(r.ipc.preferencesSet).toHaveBeenCalledWith(
        "user",
        "editor.fontFamily",
        "Cascadia Code",
      );
    });
  });

  it("an enum is a dropdown of its options", async () => {
    const r = await open("settings");
    const select = screen.getByLabelText(/Line Numbers/);

    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["On", "Off", "Relative"]);
    fireEvent.change(select, { target: { value: "relative" } });

    await waitFor(() => {
      expect(r.ipc.preferencesSet).toHaveBeenCalledWith("user", "editor.lineNumbers", "relative");
    });
  });

  it("the color theme is a selector with System, Dark, Light and High Contrast", async () => {
    const r = await open("settings");
    fireEvent.change(screen.getByLabelText("Search settings"), {
      target: { value: "color theme" },
    });
    const select = screen.getByLabelText(/Color Theme/);

    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["System", "Dark", "Light", "High Contrast"]);
    fireEvent.change(select, { target: { value: "high-contrast" } });

    await waitFor(() => {
      expect(r.ipc.preferencesSet).toHaveBeenCalledWith(
        "user",
        "workbench.colorTheme",
        "high-contrast",
      );
    });
  });
});

describe("Settings page: user and workspace scope", () => {
  beforeEach(() => {
    harness.current = null;
  });

  it("without an open folder the Workspace tab is disabled and says why", async () => {
    await open("settings");

    const workspace = screen.getByRole("tab", { name: "Workspace" });
    expect(workspace).toBeDisabled();
    expect(workspace).toHaveAttribute("title", "Open a folder to use workspace settings.");
  });

  it("with a folder open the Workspace tab writes to the workspace file", async () => {
    const r = await open("settings", { workspace: "C:/My Site" });

    const workspace = screen.getByRole("tab", { name: "Workspace: My Site" });
    expect(workspace).toBeEnabled();
    fireEvent.click(workspace);
    fireEvent.click(screen.getByLabelText(/Word Wrap/, { selector: "input" }));

    await waitFor(() => {
      expect(r.ipc.preferencesSet).toHaveBeenCalledWith("workspace", "editor.wordWrap", true);
    });
  });

  it("a setting that only exists for the whole app is disabled in the workspace tab, with the reason", async () => {
    await open("settings", { workspace: "C:/My Site" });
    fireEvent.click(screen.getByRole("tab", { name: "Workspace: My Site" }));

    const row = document.querySelector('[data-setting="terminal.fontSize"]') as HTMLElement;
    expect(within(row).getByLabelText(/Terminal: Font Size/)).toBeDisabled();
    expect(
      within(row).getByText("This setting only exists for the whole app."),
    ).toBeInTheDocument();
  });

  it("the user tab says when the open folder overrides a setting", async () => {
    await open("settings", {
      workspace: "C:/My Site",
      values: { "editor.fontSize": 20 },
      sources: { "editor.fontSize": "workspace" },
      workspaceSet: ["editor.fontSize"],
    });

    const row = document.querySelector('[data-setting="editor.fontSize"]') as HTMLElement;
    expect(within(row).getByText(/overrides this in its workspace settings/)).toBeInTheDocument();
  });

  it("Open Settings (JSON) runs the command for the tab's file, and says why when it can't", async () => {
    const r = await open("settings", { workspace: "C:/My Site" });

    fireEvent.click(screen.getByRole("button", { name: "Open Settings (JSON)" }));
    expect(r.run).toHaveBeenLastCalledWith("preferences.openSettingsJson");

    fireEvent.click(screen.getByRole("tab", { name: "Workspace: My Site" }));
    const json = screen.getByRole("button", { name: "Open Settings (JSON)" });
    expect(json).toBeDisabled(); // the workspace JSON command is not registered in this rig
    expect(json).toHaveAttribute("title", "Not available.");
  });

  it("a settings file with a syntax error is reported and its problems listed", async () => {
    const broken = makePreferences();
    broken.userError = "Not valid JSON (line 2, column 3): expected value";
    broken.userIssues = [
      {
        key: "editor.fontSize",
        message: "Font Size must be between 8 and 40.",
        severity: "error",
        line: 2,
      },
    ];
    await open("settings", {}, { preferencesLoad: vi.fn().mockResolvedValue(broken) });

    expect(screen.getByRole("alert")).toHaveTextContent("Not valid JSON (line 2, column 3)");
    expect(screen.getByRole("list", { name: "Problems in user settings" })).toHaveTextContent(
      "Font Size must be between 8 and 40.",
    );
  });
});

function pressKeys(input: HTMLElement, init: KeyboardEventInit) {
  act(() => {
    fireEvent.keyDown(input, init);
  });
}

describe("Keyboard Shortcuts page", () => {
  beforeEach(() => {
    harness.current = null;
  });

  it("lists commands with their keys and where each comes from", async () => {
    await open("keybindings");

    const table = screen.getByRole("table", { name: "Keyboard shortcuts" });
    const save = within(table).getByText("Save").closest("tr") as HTMLElement;
    expect(within(save).getByText("Ctrl+S")).toBeInTheDocument();
    expect(within(save).getByText("Default")).toBeInTheDocument();
    const runCode = within(table).getByText("Run Code").closest("tr") as HTMLElement;
    expect(within(runCode).getByText("Not bound")).toBeInTheDocument();
  });

  it("searching narrows the list by title, category or key", async () => {
    await open("keybindings");
    const search = screen.getByLabelText("Search keyboard shortcuts");

    fireEvent.change(search, { target: { value: "f5" } });
    expect(screen.getByText("Start Debugging")).toBeInTheDocument();
    expect(screen.queryByText("Save")).toBeNull();

    fireEvent.change(search, { target: { value: "zzz" } });
    expect(screen.getByText(/No shortcuts match/)).toBeInTheDocument();
  });

  it("Change records the pressed keys and Enter saves them", async () => {
    const r = await open("keybindings");

    fireEvent.click(screen.getByRole("button", { name: "Change keybinding of Run Code" }));
    const input = screen.getByLabelText("Press the new shortcut for Run Code");
    pressKeys(input, { code: "KeyR", ctrlKey: true, altKey: true });
    expect(input).toHaveValue("Ctrl+Alt+R");
    pressKeys(input, { key: "Enter", code: "Enter" });

    await waitFor(() => {
      expect(r.ipc.keybindingsSave).toHaveBeenCalledWith([
        { key: "Ctrl+Alt+R", command: "run.code" },
      ]);
    });
    expect(await screen.findByText("Ctrl+Alt+R")).toBeInTheDocument();
    expect(r.keybindings.labelFor("run.code")).toBe("Ctrl+Alt+R");
  });

  it("Escape cancels without saving", async () => {
    const r = await open("keybindings");

    fireEvent.click(screen.getByRole("button", { name: "Change keybinding of Run Code" }));
    const input = screen.getByLabelText("Press the new shortcut for Run Code");
    pressKeys(input, { code: "KeyR", ctrlKey: true, altKey: true });
    pressKeys(input, { key: "Escape", code: "Escape" });

    expect(screen.queryByLabelText("Press the new shortcut for Run Code")).toBeNull();
    expect(r.ipc.keybindingsSave).not.toHaveBeenCalled();
  });

  it("a key that another command has shows the conflict, and Replace takes it over", async () => {
    const r = await open("keybindings");

    fireEvent.click(screen.getByRole("button", { name: "Change keybinding of Run Code" }));
    const input = screen.getByLabelText("Press the new shortcut for Run Code");
    pressKeys(input, { code: "KeyS", ctrlKey: true });

    expect(screen.getByRole("alert")).toHaveTextContent('Ctrl+S is already used by "Save".');
    expect(r.ipc.keybindingsSave).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Replace" }));

    await waitFor(() => {
      expect(r.ipc.keybindingsSave).toHaveBeenCalledWith([
        { key: "Ctrl+S", command: "-file.save" },
        { key: "Ctrl+S", command: "run.code" },
      ]);
    });
    expect(r.keybindings.labelFor("file.save")).toBeUndefined();
  });

  it("a key of a built-in editor shortcut can't be taken: no Replace and Save is disabled", async () => {
    const r = await open("keybindings");

    fireEvent.click(screen.getByRole("button", { name: "Change keybinding of Run Code" }));
    const input = screen.getByLabelText("Press the new shortcut for Run Code");
    pressKeys(input, { code: "KeyD", ctrlKey: true });

    expect(screen.getByRole("alert")).toHaveTextContent("built-in editor shortcut");
    expect(screen.queryByRole("button", { name: "Replace" })).toBeNull();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(r.ipc.keybindingsSave).not.toHaveBeenCalled();
  });

  it("Remove unbinds a command and Reset gives the default back", async () => {
    const r = await open("keybindings");
    const reset = screen.getByRole("button", { name: "Reset keybinding of Save" });
    expect(reset).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Remove keybinding of Save" }));
    await waitFor(() => {
      expect(r.ipc.keybindingsSave).toHaveBeenCalledWith([
        { key: "Ctrl+S", command: "-file.save" },
      ]);
    });
    expect(r.keybindings.labelFor("file.save")).toBeUndefined();

    fireEvent.click(await screen.findByRole("button", { name: "Reset keybinding of Save" }));
    await waitFor(() => {
      expect(r.keybindings.labelFor("file.save")).toBe("Ctrl+S");
    });
    expect(screen.getByRole("button", { name: "Reset keybinding of Save" })).toBeDisabled();
  });

  it("a built-in editor shortcut can't be changed and says why; the language ones can", async () => {
    await open("keybindings");

    const builtIn = screen.getByRole("button", {
      name: "Change keybinding of Add Next Occurrence",
    });
    expect(builtIn).toBeDisabled();
    expect(builtIn).toHaveAttribute(
      "title",
      "This shortcut is built into the editor and can't be changed.",
    );
    expect(
      screen.getByRole("button", { name: "Change keybinding of Go to Definition" }),
    ).toBeEnabled();
  });

  it("commands that share a key are flagged in the list", async () => {
    await open("keybindings", {}, {}, [{ key: "Ctrl+S", command: "run.code" }]);

    const runCode = screen.getByText("Run Code").closest("tr") as HTMLElement;
    expect(within(runCode).getByRole("status")).toHaveTextContent("Also used by Save");
  });

  it("a keybindings file with a syntax error is reported and can't be changed from the page", async () => {
    await open(
      "keybindings",
      {},
      {
        keybindingsLoad: vi
          .fn()
          .mockResolvedValue({ entries: [], error: "Not a list (line 1, column 2)" }),
      },
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Not a list (line 1, column 2)");
    expect(screen.getByRole("button", { name: "Change keybinding of Run Code" })).toBeDisabled();
  });

  it("Open Keyboard Shortcuts (JSON) runs its command", async () => {
    const r = await open("keybindings");

    fireEvent.click(screen.getByRole("button", { name: "Open Keyboard Shortcuts (JSON)" }));

    expect(r.run).toHaveBeenCalledWith("preferences.openKeybindingsJson");
  });

  it("the tabs switch between Settings and Keyboard Shortcuts", async () => {
    const r = await open("settings");

    fireEvent.click(screen.getByRole("tab", { name: "Keyboard Shortcuts" }));
    expect(r.page.getState().tab).toBe("keybindings");
    expect(screen.getByRole("table", { name: "Keyboard shortcuts" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Settings" }));
    expect(screen.getByLabelText("Search settings")).toBeInTheDocument();
  });
});
