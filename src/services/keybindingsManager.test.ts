import { describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { CommandRegistry } from "./commandRegistry";
import type { KeybindingEntry } from "./ipc";
import { DEFAULT_KEYBINDINGS, KeybindingService, type Keybinding } from "./keybindings";
import { KeybindingsManager } from "./keybindingsManager";
import {
  commandCatalog,
  conflictingKeys,
  conflictsFor,
  effectiveBindings,
  entriesForAssign,
  entriesForRemove,
  entriesForReset,
  matchesQuery,
} from "./keybindingsModel";
import { buildMenuBar } from "./menus";

const DEFAULTS: Keybinding[] = [
  { key: "Ctrl+S", command: "file.save", owner: "app" },
  { key: "Ctrl+W", command: "file.closeActiveTab", owner: "app" },
  { key: "Ctrl+F4", command: "file.closeActiveTab", owner: "app" },
  { key: "F5", command: "debug.start", owner: "app" },
  { key: "F11", command: "view.toggleFullScreen", owner: "app" },
  { key: "F11", command: "debug.stepInto", owner: "app" },
  { key: "F12", command: "go.toDefinition", owner: "editor" },
  { key: "Ctrl+D", command: "selection.addNextOccurrence", owner: "editor" },
];

describe("effective bindings", () => {
  it("the defaults apply when the user has no entries", () => {
    const list = effectiveBindings(DEFAULTS, []);
    expect(list).toHaveLength(DEFAULTS.length);
    expect(list.every((binding) => binding.source === "default")).toBe(true);
  });

  it("a user entry is added first and a -command entry removes that command's default for that key", () => {
    const list = effectiveBindings(DEFAULTS, [
      { key: "Ctrl+Alt+S", command: "file.save" },
      { key: "Ctrl+S", command: "-file.save" },
      { key: "Ctrl+W", command: "-file.closeActiveTab" },
    ]);
    expect(list[0]).toMatchObject({
      key: "Ctrl+Alt+S",
      command: "file.save",
      source: "user",
      owner: "app",
    });
    expect(list.some((b) => b.key === "Ctrl+S")).toBe(false);
    expect(list.some((b) => b.key === "Ctrl+W")).toBe(false);
    // The command's other default survives.
    expect(list.some((b) => b.key === "Ctrl+F4" && b.command === "file.closeActiveTab")).toBe(true);
  });

  it("the real defaults are untouched: F5, F10, Ctrl+F5, Ctrl+S and Ctrl+` keep their commands", () => {
    const key = (command: string) => DEFAULT_KEYBINDINGS.find((b) => b.command === command)?.key;
    expect(key("debug.start")).toBe("F5");
    expect(key("debug.stepOver")).toBe("F10");
    expect(key("run.code")).toBe("Ctrl+F5");
    expect(key("file.save")).toBe("Ctrl+S");
    expect(key("terminal.toggle")).toBe("Ctrl+`");
    expect(key("preferences.openSettings")).toBe("Ctrl+,");
  });
});

describe("conflicts", () => {
  const list = effectiveBindings(DEFAULTS, []);

  it("finds the other commands that already use a key", () => {
    expect(conflictsFor(list, "Ctrl+S", "run.code")).toEqual([
      { command: "file.save", owner: "app" },
    ]);
    expect(conflictsFor(list, "Ctrl+Alt+Q", "run.code")).toEqual([]);
    expect(conflictsFor(list, "Ctrl+S", "file.save")).toEqual([]);
  });

  it("F11 is shared by Full Screen and Step Into on purpose: not a conflict", () => {
    expect(conflictsFor(list, "F11", "debug.stepInto")).toEqual([]);
    expect(conflictingKeys(list).has("F11")).toBe(false);
  });

  it("conflictingKeys lists keys used by unrelated commands", () => {
    const clashing = effectiveBindings(DEFAULTS, [{ key: "Ctrl+S", command: "run.code" }]);
    expect(conflictingKeys(clashing).get("Ctrl+S")).toEqual(["run.code", "file.save"]);
  });
});

describe("what gets stored", () => {
  it("assign removes the command's other defaults, adds the key and drops the command's older entries", () => {
    const entries = entriesForAssign(
      [{ key: "Ctrl+Alt+1", command: "file.closeActiveTab" }],
      DEFAULTS,
      "file.closeActiveTab",
      "Ctrl+Alt+W",
    );
    expect(entries).toEqual([
      { key: "Ctrl+W", command: "-file.closeActiveTab" },
      { key: "Ctrl+F4", command: "-file.closeActiveTab" },
      { key: "Ctrl+Alt+W", command: "file.closeActiveTab" },
    ]);
  });

  it("replacing takes the key from the other command, whether it was a default or the user's", () => {
    const entries = entriesForAssign([], DEFAULTS, "run.code", "Ctrl+S", ["file.save"]);
    expect(entries).toContainEqual({ key: "Ctrl+S", command: "-file.save" });
    expect(entries.at(-1)).toEqual({ key: "Ctrl+S", command: "run.code" });

    const again = entriesForAssign(entries, DEFAULTS, "debug.start", "Ctrl+S", ["run.code"]);
    expect(again).not.toContainEqual({ key: "Ctrl+S", command: "run.code" });
  });

  it("remove negates every default of the command; reset drops everything the user did to it", () => {
    const removed = entriesForRemove(
      [{ key: "Ctrl+Alt+S", command: "file.save" }],
      DEFAULTS,
      "file.save",
    );
    expect(removed).toEqual([{ key: "Ctrl+S", command: "-file.save" }]);
    const reset = entriesForReset(
      [
        { key: "Ctrl+S", command: "-file.save" },
        { key: "Ctrl+Alt+S", command: "file.save" },
        { key: "F6", command: "run.code" },
      ],
      "file.save",
    );
    expect(reset).toEqual([{ key: "F6", command: "run.code" }]);
  });
});

describe("the command list", () => {
  it("has every command the spec requires, with a title", () => {
    const registry = new CommandRegistry();
    registry.register("editor.closeAll", () => undefined);
    const catalog = commandCatalog(
      buildMenuBar({ folders: [], files: [] }),
      DEFAULT_KEYBINDINGS,
      (id) => registry.has(id),
    );
    const titles = Object.fromEntries(catalog.map((info) => [info.id, info.title]));
    const required: Record<string, string> = {
      "file.save": "Save",
      "file.open": "Open File",
      "file.openFolder": "Open Folder",
      "file.new": "New Text File",
      "file.closeActiveTab": "Close Editor",
      "run.code": "Run Code",
      "run.stop": "Stop Running Code",
      "debug.start": "Start Debugging",
      "debug.stop": "Stop Debugging",
      "debug.stepOver": "Step Over",
      "debug.stepInto": "Step Into",
      "debug.stepOut": "Step Out",
      "terminal.toggle": "Toggle Terminal",
      "view.showSourceControl": "Source Control",
      "search.findInFiles": "Search: Find in Files",
      "view.showProblems": "Problems",
      "edit.formatDocument": "Format Document",
      "edit.renameSymbol": "Rename Symbol",
      "go.toDefinition": "Go to Definition",
      "go.toReferences": "Find All References",
    };
    for (const [id, title] of Object.entries(required)) expect(titles[id], id).toBe(title);
    expect(catalog.some((info) => info.id === "editor.closeAll")).toBe(true);
  });

  it("matchesQuery needs every word", () => {
    expect(matchesQuery("save ctrl", "Save", "file.save", "File", "Ctrl+S")).toBe(true);
    expect(matchesQuery("save shift", "Save", "file.save", "File", "Ctrl+S")).toBe(false);
    expect(matchesQuery("", "anything")).toBe(true);
  });
});

function rig(saved: KeybindingEntry[] = [], error: string | null = null) {
  const commands = new CommandRegistry();
  const service = new KeybindingService(commands, DEFAULTS);
  let stored = saved;
  const ipc = createFakeIpc({
    keybindingsLoad: vi.fn().mockImplementation(() => Promise.resolve({ entries: stored, error })),
    keybindingsSave: vi.fn().mockImplementation((entries: KeybindingEntry[]) => {
      stored = entries;
      return Promise.resolve(entries);
    }),
    preferencesScopeOf: vi.fn().mockResolvedValue("keybindings"),
  });
  const syncEditor = vi.fn();
  const manager = new KeybindingsManager(ipc, service, {
    defaults: DEFAULTS,
    catalog: () => [
      { id: "file.save", title: "Save", category: "File" },
      { id: "file.closeActiveTab", title: "Close Editor", category: "File" },
      { id: "run.code", title: "Run Code", category: "Run" },
      { id: "debug.start", title: "Start Debugging", category: "Run" },
      { id: "go.toDefinition", title: "Go to Definition", category: "Go" },
      { id: "selection.addNextOccurrence", title: "Add Next Occurrence", category: "Selection" },
    ],
    remappable: (command) => command === "go.toDefinition",
    syncEditor,
  });
  return { manager, service, ipc, syncEditor, stored: () => stored };
}

describe("KeybindingsManager", () => {
  it("lists commands with their keys, sorted, and searches by title, id, category and key", async () => {
    const { manager } = rig();
    await manager.initialize();

    const rows = manager.rows();
    expect(rows.map((row) => row.title)).toEqual([
      "Close Editor",
      "Save",
      "Go to Definition",
      "Run Code",
      "Start Debugging",
      "Add Next Occurrence",
    ]);
    expect(rows.find((row) => row.command === "file.closeActiveTab")?.keys).toEqual([
      "Ctrl+W",
      "Ctrl+F4",
    ]);
    expect(rows.find((row) => row.command === "run.code")).toMatchObject({
      keys: [],
      source: "none",
    });
    expect(manager.rows("f5").map((row) => row.command)).toEqual(["debug.start"]);
    expect(manager.rows("go").map((row) => row.command)).toContain("go.toDefinition");
    expect(manager.rows("ctrl+s").map((row) => row.command)).toEqual(["file.save"]);
  });

  it("assign saves to the file and takes effect at once in the shortcut listener and the labels", async () => {
    const { manager, service, ipc } = rig();
    await manager.initialize();

    const result = await manager.assign("run.code", "Ctrl+Alt+R");

    expect(result).toEqual({ ok: true });
    expect(ipc.keybindingsSave).toHaveBeenCalledWith([{ key: "Ctrl+Alt+R", command: "run.code" }]);
    expect(service.labelFor("run.code")).toBe("Ctrl+Alt+R");
    const registry = new CommandRegistry();
    registry.register("run.code", () => undefined);
    expect(
      new KeybindingService(registry, [...service.getBindings()]).resolve({
        code: "KeyR",
        ctrlKey: true,
        shiftKey: false,
        altKey: true,
        metaKey: false,
      }),
    ).toBe("run.code");
    expect(manager.rows("run code")[0]).toMatchObject({
      keys: ["Ctrl+Alt+R"],
      source: "user",
      customized: true,
    });
  });

  it("assigning a taken key reports the conflict and only replaces when asked", async () => {
    const { manager, service } = rig();
    await manager.initialize();

    const check = manager.checkAssign("run.code", "Ctrl+S");
    expect(check).toEqual({
      ok: false,
      blocked: false,
      reason: 'Ctrl+S is already used by "Save".',
      conflicts: [{ command: "file.save", title: "Save" }],
    });
    expect(await manager.assign("run.code", "Ctrl+S")).toEqual({
      ok: false,
      error: 'Ctrl+S is already used by "Save".',
    });
    expect(service.labelFor("file.save")).toBe("Ctrl+S");

    expect(await manager.assign("run.code", "Ctrl+S", true)).toEqual({ ok: true });
    expect(service.labelFor("run.code")).toBe("Ctrl+S");
    expect(service.labelFor("file.save")).toBeUndefined();
  });

  it("a key that belongs to a built-in editor shortcut can't be taken", async () => {
    const { manager } = rig();
    await manager.initialize();

    const check = manager.checkAssign("run.code", "Ctrl+D");
    expect(check).toMatchObject({ ok: false, blocked: true });
    expect(await manager.assign("run.code", "Ctrl+D", true)).toMatchObject({ ok: false });
  });

  it("a built-in editor shortcut can only be changed where Monaco's own key can be switched off", async () => {
    const { manager } = rig();
    await manager.initialize();

    expect(manager.canChange("selection.addNextOccurrence")).toEqual({
      enabled: false,
      reason: "This shortcut is built into the editor and can't be changed.",
    });
    expect(manager.canChange("go.toDefinition")).toEqual({ enabled: true });
    expect(await manager.assign("selection.addNextOccurrence", "Ctrl+Alt+D")).toMatchObject({
      ok: false,
    });
  });

  it("changing Go to Definition tells the editor to drop Monaco's own F12", async () => {
    const { manager, syncEditor } = rig();
    await manager.initialize();
    expect(syncEditor).toHaveBeenLastCalledWith([]);

    await manager.assign("go.toDefinition", "Ctrl+Alt+G");
    expect(syncEditor).toHaveBeenLastCalledWith([{ command: "go.toDefinition", key: "F12" }]);

    await manager.reset("go.toDefinition");
    expect(syncEditor).toHaveBeenLastCalledWith([]);
  });

  it("remove leaves a command unbound and reset brings the default back", async () => {
    const { manager, service } = rig();
    await manager.initialize();

    await manager.remove("file.save");
    expect(service.labelFor("file.save")).toBeUndefined();
    expect(manager.rows("save")[0]).toMatchObject({ keys: [], source: "none", customized: true });

    await manager.reset("file.save");
    expect(service.labelFor("file.save")).toBe("Ctrl+S");
    expect(manager.rows("save")[0]?.customized).toBe(false);
  });

  it("keys survive a restart: a new manager reads the saved entries", async () => {
    const first = rig();
    await first.manager.initialize();
    await first.manager.assign("run.code", "Ctrl+Alt+R");

    const second = rig(first.stored());
    await second.manager.initialize();

    expect(second.service.labelFor("run.code")).toBe("Ctrl+Alt+R");
  });

  it("a keybindings file with a syntax error uses the defaults and can't be edited from the page", async () => {
    const { manager, service } = rig([], "Not a list of entries (line 1, column 3)");
    await manager.initialize();

    expect(manager.getState().error).toContain("line 1");
    expect(service.labelFor("file.save")).toBe("Ctrl+S");
    expect(manager.canChange("run.code")).toEqual({
      enabled: false,
      reason: "Fix the syntax error in keybindings.json first.",
    });
    expect(await manager.assign("run.code", "Ctrl+Alt+R")).toMatchObject({ ok: false });
  });

  it("a save the backend refuses comes back as its message", async () => {
    const { manager, ipc } = rig();
    await manager.initialize();
    (ipc.keybindingsSave as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Entry 1: nope"));

    expect(await manager.assign("run.code", "Ctrl+Alt+R")).toEqual({
      ok: false,
      error: "Entry 1: nope",
    });
  });

  it("saving keybindings.json in an editor tab re-reads it; other files are ignored", async () => {
    const { manager, ipc } = rig();
    await manager.initialize();

    expect(await manager.handleSaved("C:/app/settings/keybindings.json")).toBe(true);
    expect(ipc.keybindingsLoad).toHaveBeenCalledTimes(2);
    (ipc.preferencesScopeOf as ReturnType<typeof vi.fn>).mockResolvedValue("user");
    expect(await manager.handleSaved("C:/app/settings/settings.json")).toBe(false);
  });
});
