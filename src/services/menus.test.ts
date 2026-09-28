import { describe, expect, it } from "vitest";

import { DEFAULT_KEYBINDINGS } from "./keybindings";
import {
  buildMenuBar,
  collectCommandIds,
  projectMenuCommands,
  pruneMenuEntries,
  type MenuEntry,
} from "./menus";
import { EDITOR_ACTIONS, EDITOR_TOGGLES } from "./workbenchCommands";

const EMPTY = { folders: [], files: [] };

function findSubmenu(items: MenuEntry[], label: string): MenuEntry[] {
  const found = items.find((item) => item.kind === "submenu" && item.label === label);
  if (found?.kind !== "submenu") throw new Error(`submenu ${label} not found`);
  return found.items;
}

describe("buildMenuBar", () => {
  it("has VS Code's top-level menus in order, each with a unique mnemonic", () => {
    const menus = buildMenuBar(EMPTY);

    expect(menus.map((menu) => menu.label)).toEqual([
      "File",
      "Edit",
      "Selection",
      "View",
      "Go",
      "Run",
      "Terminal",
      "Help",
    ]);
    expect(new Set(menus.map((menu) => menu.mnemonic)).size).toBe(menus.length);
  });

  it("lists recent folders and files under File > Open Recent", () => {
    const menus = buildMenuBar({
      folders: [{ name: "proj", path: "C:/proj" }],
      files: [{ path: "C:/proj/a.ts" }],
    });
    const file = menus[0];
    if (!file) throw new Error("no file menu");

    const recent = findSubmenu(file.items, "Open Recent");

    expect(recent).toContainEqual({
      kind: "command",
      label: "C:/proj",
      command: "file.openRecentFolder",
      args: ["C:/proj"],
    });
    expect(recent).toContainEqual({
      kind: "command",
      label: "C:/proj/a.ts",
      command: "file.openRecentFile",
      args: ["C:/proj/a.ts"],
    });
  });

  it("exposes every Monaco-backed action and editor toggle somewhere in the menus", () => {
    const ids = new Set(collectCommandIds(buildMenuBar(EMPTY)));

    for (const id of [...Object.keys(EDITOR_ACTIONS), ...Object.keys(EDITOR_TOGGLES)]) {
      expect(ids.has(id), id).toBe(true);
    }
  });

  it("only binds keys to commands that appear in the menus", () => {
    const ids = new Set(collectCommandIds(buildMenuBar(EMPTY)));
    const menuless = new Set(["search.findInFiles", "search.replaceInFiles"]);

    for (const binding of DEFAULT_KEYBINDINGS) {
      if (menuless.has(binding.command)) continue;
      expect(ids.has(binding.command), binding.command).toBe(true);
    }
  });
});

describe("pruneMenuEntries", () => {
  const cmdEntry = (command: string): MenuEntry => ({ kind: "command", label: command, command });
  const sep: MenuEntry = { kind: "separator" };

  it("drops commands that are not registered, and shows the ones that are", () => {
    const items: MenuEntry[] = [cmdEntry("a"), cmdEntry("b"), cmdEntry("c")];
    expect(
      pruneMenuEntries(items, (id) => id !== "b").map((i) =>
        i.kind === "command" ? i.command : "-",
      ),
    ).toEqual(["a", "c"]);
  });

  it("drops a submenu that ends up empty and keeps one that has an entry", () => {
    const items: MenuEntry[] = [
      { kind: "submenu", label: "Empty", items: [cmdEntry("x")] },
      { kind: "submenu", label: "Full", items: [cmdEntry("y"), cmdEntry("x")] },
    ];
    const pruned = pruneMenuEntries(items, (id) => id === "y");
    expect(pruned).toHaveLength(1);
    expect(pruned[0]).toMatchObject({ kind: "submenu", label: "Full" });
  });

  it("never leaves a separator first, last or doubled", () => {
    const items: MenuEntry[] = [
      sep,
      cmdEntry("a"),
      sep,
      cmdEntry("gone"),
      sep,
      cmdEntry("b"),
      sep,
      cmdEntry("gone2"),
      sep,
    ];
    const kinds = pruneMenuEntries(items, (id) => id === "a" || id === "b").map((i) => i.kind);
    expect(kinds).toEqual(["command", "separator", "command"]);
  });

  it("an item appears when its command gets registered (the AI Panel rule)", () => {
    const view = buildMenuBar(EMPTY).find((menu) => menu.id === "view");
    if (!view) throw new Error("no view menu");
    const shown = (registered: string[]) =>
      collectCommandIds([
        { ...view, items: pruneMenuEntries(view.items, (id) => registered.includes(id)) },
      ]);
    expect(shown(["view.showExplorer"])).not.toContain("ai.openChat");
    expect(shown(["view.showExplorer", "ai.openChat"])).toContain("ai.openChat");
  });
});

describe("dynamic menu content", () => {
  it("lists only the shells that were found under Terminal > New Terminal With Profile", () => {
    const none = buildMenuBar(EMPTY).find((menu) => menu.id === "terminal");
    expect(
      none?.items.some((item) => item.kind === "submenu" && item.label === "New Terminal With Profile"),
    ).toBe(false);
    const menus = buildMenuBar(EMPTY, {
      shells: [
        { kind: "powerShell", label: "PowerShell" },
        { kind: "gitBash", label: "Git Bash" },
      ],
      projectCommands: [],
    });
    const terminal = menus.find((menu) => menu.id === "terminal");
    if (!terminal) throw new Error("no terminal menu");
    const profiles = findSubmenu(terminal.items, "New Terminal With Profile");
    expect(profiles).toEqual([
      { kind: "command", label: "PowerShell", command: "terminal.new", args: ["powerShell"] },
      { kind: "command", label: "Git Bash", command: "terminal.new", args: ["gitBash"] },
    ]);
  });

  it("puts the project's run, build and test commands under Run, each running through one command", () => {
    const projects = [
      {
        root: "web",
        name: "Vite + React",
        commandStatus: [
          { id: "node.script.dev", label: "npm run dev", category: "dev" },
          { id: "node.script.build", label: "npm run build", category: "build" },
          { id: "node.script.test", label: "npm run test", category: "test" },
          { id: "node.install", label: "npm install", category: "install" },
        ],
      },
    ];
    const commands = projectMenuCommands(projects);
    expect(commands.map((c) => c.commandId)).toEqual([
      "node.script.dev",
      "node.script.build",
      "node.script.test",
    ]);
    const run = buildMenuBar(EMPTY, { shells: [], projectCommands: commands }).find(
      (m) => m.id === "run",
    );
    if (!run) throw new Error("no run menu");
    expect(findSubmenu(run.items, "Project Run Commands")).toEqual([
      {
        kind: "command",
        label: "npm run dev",
        command: "language.runProjectCommand",
        args: ["web", "node.script.dev"],
      },
    ]);
    expect(findSubmenu(run.items, "Project Build Commands")).toHaveLength(1);
    expect(findSubmenu(run.items, "Project Test Commands")).toHaveLength(1);
  });

  it("with several projects each entry names its project; with none there are no project submenus", () => {
    const two = projectMenuCommands([
      { root: "a", name: "A", commandStatus: [{ id: "x", label: "go run .", category: "run" }] },
      { root: "b", name: "B", commandStatus: [{ id: "y", label: "cargo run", category: "run" }] },
    ]);
    const run = buildMenuBar(EMPTY, { shells: [], projectCommands: two }).find(
      (m) => m.id === "run",
    );
    const items = findSubmenu(run?.items ?? [], "Project Run Commands");
    expect(items.map((i) => (i.kind === "command" ? i.label : ""))).toEqual([
      "go run . — A",
      "cargo run — B",
    ]);
    const bare = buildMenuBar(EMPTY).find((m) => m.id === "run");
    expect(bare?.items.some((i) => i.kind === "submenu" && i.label.startsWith("Project"))).toBe(
      false,
    );
  });
});
