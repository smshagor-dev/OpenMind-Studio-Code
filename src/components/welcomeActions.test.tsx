import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CommandRegistry } from "../services/commandRegistry";

const harness = vi.hoisted((): { current: unknown } => ({ current: null }));

vi.mock("../services/container", () => ({
  get container() {
    return harness.current;
  },
}));
vi.mock("../../src-tauri/icons/128x128.png", () => ({ default: "icon.png" }));

import { WelcomeContent } from "./WelcomeEditor";

const RECENTS = {
  files: [{ path: "C:/My Site/index.php", name: "index.php" }],
  folders: [{ id: 1, name: "My Site", path: "C:/My Site" }],
  pinnedFolders: [{ path: "C:/Pinned", label: null }],
};

function mount(registered: string[] = []) {
  const commands = new CommandRegistry();
  for (const id of registered) commands.register(id, () => undefined);
  const run = vi.fn();
  const workspace = {
    openPath: vi.fn().mockResolvedValue("tab"),
    openFolder: vi.fn().mockResolvedValue(undefined),
    unpinFolder: vi.fn().mockResolvedValue(undefined),
  };
  const welcome = {
    subscribe: () => () => undefined,
    getState: () => WELCOME_STATE,
    setShowOnStartup: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
  harness.current = { commands, run, workspace, welcome };
  render(<WelcomeContent recents={RECENTS as never} />);
  return { run, workspace, welcome };
}

const WELCOME_STATE = { open: true, showOnStartup: true };

describe("Welcome page actions", () => {
  beforeEach(() => {
    harness.current = null;
  });

  it("the Start links run their commands", () => {
    const { run } = mount();

    for (const [label, command] of [
      ["New File...", "file.new"],
      ["Open File...", "file.open"],
      ["Open Folder...", "file.openFolder"],
      ["Clone Git Repository...", "git.clone"],
      ["New Window", "workbench.newWindow"],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name: label }));
      expect(run).toHaveBeenLastCalledWith(command);
    }
  });

  it("recent folders, recent files and pinned folders open through the workspace", () => {
    const { workspace, welcome } = mount();

    fireEvent.click(screen.getByRole("button", { name: /^My Site$/ }));
    expect(workspace.openFolder).toHaveBeenCalledWith("C:/My Site");
    fireEvent.click(screen.getByRole("button", { name: /index\.php/ }));
    expect(workspace.openPath).toHaveBeenCalledWith("C:/My Site/index.php");
    // Opening a recent file replaces the Welcome page, as in VS Code.
    expect(welcome.close).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: /Pinned/ }));
    expect(workspace.openFolder).toHaveBeenCalledWith("C:/Pinned");
  });

  it("the cards cover runtimes, the PHP server, language tools, keyboard shortcuts and settings", () => {
    const { run } = mount([
      "runtime.manage",
      "php.openWindow",
      "lsp.manage",
      "preferences.openKeybindings",
      "preferences.openSettings",
    ]);
    for (const [title, command] of [
      ["Install Runtimes", "runtime.manage"],
      ["PHP Server Control Panel", "php.openWindow"],
      ["Language Tools", "lsp.manage"],
      ["Keyboard Shortcuts", "preferences.openKeybindings"],
      ["Settings", "preferences.openSettings"],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${title}`) }));
      expect(run).toHaveBeenLastCalledWith(command);
    }
  });

  it("a card whose command doesn't exist is disabled, not a dead link", () => {
    mount(["runtime.manage"]);

    expect(screen.getByRole("button", { name: /^Install Runtimes/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^Settings/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Keyboard Shortcuts/ })).toBeDisabled();
  });

  it("Show welcome page on startup is a real checkbox", () => {
    mount();

    const box = within(document.body).getByRole("checkbox", {
      name: /Show welcome page on startup/,
    });
    expect(box).toBeChecked();
  });
});
