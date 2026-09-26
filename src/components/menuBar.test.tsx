import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CommandRegistry } from "../services/commandRegistry";
import type { TopLevelMenu } from "../services/menus";

const harness = vi.hoisted((): { current: unknown } => ({ current: null }));

vi.mock("../services/container", () => ({
  get container() {
    return harness.current;
  },
}));

import { MenuBar } from "./MenuBar";

const MENUS: TopLevelMenu[] = [
  {
    id: "file",
    label: "File",
    mnemonic: "F",
    items: [
      { kind: "command", label: "Real", command: "real.command" },
      { kind: "command", label: "Dead", command: "dead.command" },
    ],
  },
  { id: "about", label: "About", mnemonic: "A", items: [], action: "help.about" },
];

let commands: CommandRegistry;
const run = vi.fn();

beforeEach(() => {
  commands = new CommandRegistry();
  commands.register("real.command", () => undefined);
  run.mockReset();
  harness.current = {
    commands,
    run,
    keybindings: { labelFor: () => undefined },
  };
});

describe("MenuBar", () => {
  it("lists only entries whose command exists", () => {
    render(<MenuBar menus={MENUS} />);
    fireEvent.mouseDown(screen.getByRole("menuitem", { name: "File" }));
    expect(screen.getByRole("menuitem", { name: "Real" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Dead" })).toBeNull();
  });

  it("an entry appears once its command is registered", () => {
    render(<MenuBar menus={MENUS} />);
    commands.register("dead.command", () => undefined);
    fireEvent.mouseDown(screen.getByRole("menuitem", { name: "File" }));
    expect(screen.getByRole("menuitem", { name: "Dead" })).toBeInTheDocument();
  });

  it("a top-level entry with an action runs it and opens no dropdown", () => {
    render(<MenuBar menus={MENUS} />);
    fireEvent.mouseDown(screen.getByRole("menuitem", { name: "About" }));
    expect(run).toHaveBeenCalledWith("help.about");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Alt+A runs the About action and moving right from the last dropdown skips it", () => {
    render(<MenuBar menus={MENUS} />);
    fireEvent.keyDown(window, { code: "KeyA", altKey: true });
    expect(run).toHaveBeenCalledWith("help.about");
    run.mockClear();
    fireEvent.keyDown(window, { code: "KeyF", altKey: true });
    fireEvent.keyDown(screen.getByRole("menu", { name: "File" }), { key: "ArrowRight" });
    expect(run).not.toHaveBeenCalled();
  });
});

describe("MenuBar shortcuts", () => {
  it("shows a shortcut only on the plain command, not on an entry that passes arguments", () => {
    commands.register("terminal.new", () => undefined);
    harness.current = {
      commands,
      run,
      keybindings: {
        labelFor: (id: string) => (id === "terminal.new" ? "Ctrl+Shift+`" : undefined),
      },
    };
    const menus: TopLevelMenu[] = [
      {
        id: "terminal",
        label: "Terminal",
        mnemonic: "T",
        items: [
          { kind: "command", label: "New Terminal", command: "terminal.new" },
          { kind: "command", label: "Git Bash", command: "terminal.new", args: ["gitBash"] },
        ],
      },
    ];
    render(<MenuBar menus={menus} />);
    fireEvent.mouseDown(screen.getByRole("menuitem", { name: "Terminal" }));
    expect(screen.getByRole("menuitem", { name: /New Terminal/ })).toHaveTextContent(
      "Ctrl+Shift+`",
    );
    expect(screen.getByRole("menuitem", { name: /Git Bash/ })).not.toHaveTextContent("Ctrl+");
  });
});
