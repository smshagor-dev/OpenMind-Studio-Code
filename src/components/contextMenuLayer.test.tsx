import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CommandRegistry } from "../services/commandRegistry";
import { ContextMenuService } from "../services/editorMenu/contextMenuService";
import type { MenuEntry } from "../services/menus";

const harness = vi.hoisted(
  (): {
    container: unknown;
    menu: unknown;
    reason: (command: string, path: string) => string | null;
  } => ({
    container: null,
    menu: null,
    reason: () => null,
  }),
);

vi.mock("../services/container", () => ({
  get container() {
    return harness.container;
  },
}));

vi.mock("../services/editorMenu", () => ({
  get contextMenu() {
    return harness.menu;
  },
  installEditorMenu: () => ({
    reasonForFile: (command: string, path: string) => harness.reason(command, path),
  }),
}));

import { ContextMenuLayer } from "./ContextMenuLayer";
import { resolveContextEntries } from "./contextMenuItems";

let commands: CommandRegistry;
let menu: ContextMenuService;
const run = vi.fn();

beforeEach(() => {
  commands = new CommandRegistry();
  for (const id of ["edit.copy", "git.openFileHistory", "git.openFileOnRemote", "openmindAi.explain"]) {
    commands.register(id, () => undefined);
  }
  commands.register("edit.refactor", () => undefined, {
    enabled: () => false,
    disabledReason: () => "No language server supports this file type.",
  });
  run.mockReset();
  menu = new ContextMenuService();
  harness.menu = menu;
  harness.reason = () => null;
  harness.container = {
    commands,
    run,
    keybindings: { labelFor: (id: string) => (id === "edit.copy" ? "Ctrl+C" : undefined) },
  };
});

const ENTRIES: MenuEntry[] = [
  { kind: "command", label: "Explain", command: "openmindAi.explain" },
  { kind: "separator" },
  { kind: "command", label: "Refactor...", command: "edit.refactor" },
  {
    kind: "submenu",
    label: "File History",
    items: [{ kind: "command", label: "Open File History", command: "git.openFileHistory" }],
  },
  { kind: "separator" },
  { kind: "command", label: "Copy", command: "edit.copy" },
  { kind: "separator" },
];

describe("ContextMenuLayer", () => {
  it("draws the open menu with shortcuts and reasons, runs a choice and closes", () => {
    render(<ContextMenuLayer />);
    expect(screen.queryByRole("menu")).toBeNull();
    act(() => {
      menu.open({ x: 40, y: 50, ariaLabel: "Editor context menu", entries: () => ENTRIES });
    });
    expect(screen.getByRole("menu", { name: "Editor context menu" })).toBeTruthy();
    expect(screen.getByText("Ctrl+C")).toBeTruthy();
    const refactor = screen.getByText("Refactor...").closest("[role=menuitem]");
    expect(refactor?.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("No language server supports this file type.")).toBeTruthy();
    fireEvent.click(screen.getByText("Explain"));
    expect(run).toHaveBeenCalledWith("openmindAi.explain");
    expect(menu.isOpen()).toBe(false);
  });

  it("opens a submenu with the keyboard and closes on Escape", () => {
    const dismissed = vi.fn();
    render(<ContextMenuLayer />);
    act(() => {
      menu.open({ x: 0, y: 0, ariaLabel: "m", entries: () => ENTRIES, onDismiss: dismissed });
    });
    const root = screen.getByRole("menu", { name: "m" });
    // Explain is focused first; the disabled Refactor row is skipped.
    fireEvent.keyDown(root, { key: "ArrowDown" });
    fireEvent.keyDown(root, { key: "ArrowRight" });
    expect(screen.getByText("Open File History")).toBeTruthy();
    fireEvent.keyDown(root, { key: "Escape" });
    expect(menu.isOpen()).toBe(false);
    expect(dismissed).toHaveBeenCalled();
  });

  it("redraws when something an entry depends on changes", () => {
    let label = "Explain";
    render(<ContextMenuLayer />);
    act(() => {
      menu.open({
        x: 0,
        y: 0,
        ariaLabel: "m",
        entries: () => [{ kind: "command", label, command: "openmindAi.explain" }],
      });
    });
    label = "Explain Again";
    act(() => {
      menu.refresh();
    });
    expect(screen.getByText("Explain Again")).toBeTruthy();
  });
});

describe("resolveContextEntries", () => {
  it("judges an entry about another file by that file, and drops stray separators", () => {
    harness.reason = (command, path) =>
      command === "git.openFileOnRemote" && path === "C:/r/b.ts"
        ? "No remote is configured for this repository."
        : null;
    const target = { path: "C:/r/b.ts", line: 1, endLine: 1 };
    const items = resolveContextEntries(
      [
        { kind: "separator" },
        { kind: "command", label: "Open File History", command: "git.openFileHistory", args: [target] },
        { kind: "command", label: "Open File on Remote", command: "git.openFileOnRemote", args: [target] },
        { kind: "separator" },
        { kind: "separator" },
      ],
      harness.reason,
    );
    expect(items.map((item) => item.kind)).toEqual(["item", "item"]);
    expect(items[1]).toMatchObject({ enabled: false, reason: "No remote is configured for this repository." });
    const first = items[0];
    if (first?.kind !== "item") throw new Error("expected an item");
    first.onSelect();
    expect(run).toHaveBeenCalledWith("git.openFileHistory", target);
  });
});
