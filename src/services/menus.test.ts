import { describe, expect, it } from "vitest";

import { DEFAULT_KEYBINDINGS } from "./keybindings";
import { buildMenuBar, collectCommandIds, type MenuEntry } from "./menus";
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
