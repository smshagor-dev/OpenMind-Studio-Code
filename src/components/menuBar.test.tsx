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
  it("lists an entry whose command isn't built as disabled instead of hiding it", () => {
    render(<MenuBar menus={MENUS} />);
    fireEvent.mouseDown(screen.getByRole("menuitem", { name: "File" }));
    expect(screen.getByRole("menuitem", { name: "Real" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Dead/ })).toHaveAttribute("aria-disabled", "true");
  });

  it("an entry appears once its command is registered", () => {
    render(<MenuBar menus={MENUS} />);
    commands.register("dead.command", () => undefined);
    fireEvent.mouseDown(screen.getByRole("menuitem", { name: "File" }));
    expect(screen.getByRole("menuitem", { name: "Dead" })).toBeInTheDocument();
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

describe("MenuBar in a narrow title bar", () => {
  /** jsdom has no layout: the menu bar reports `content` px of menus in `room` px, and every observer fires at once. */
  function narrow(content: number, room: number) {
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(content);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(room);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private readonly callback: () => void) {}
        observe() {
          this.callback();
        }
        disconnect() {}
      },
    );
  }

  it("folds the menus into one button whose menu lists them as submenus", () => {
    narrow(360, 200);
    const titlebar = document.createElement("div");
    document.body.append(titlebar);
    render(<MenuBar menus={MENUS} />, { container: titlebar });

    expect(screen.queryByRole("menuitem", { name: "File" })).toBeNull();
    fireEvent.mouseDown(screen.getByRole("menuitem", { name: "Application menu" }));
    expect(screen.getByRole("menuitem", { name: "File" })).toHaveAttribute("aria-haspopup", "true");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps the menus when they fit", () => {
    narrow(300, 300);
    render(<MenuBar menus={MENUS} />);
    expect(screen.getByRole("menuitem", { name: "File" })).toBeInTheDocument();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
});
