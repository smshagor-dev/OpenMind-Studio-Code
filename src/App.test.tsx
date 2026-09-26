import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((command: string) => {
    if (command === "theme_get") return Promise.resolve("dark");
    if (command === "session_load") return Promise.resolve({ openPaths: [], activePath: null });
    if (command === "recent_files_list") return Promise.resolve([]);
    if (command === "recent_folders_list" || command === "workspace_recent_folders")
      return Promise.resolve([]);
    if (command === "workspace_active_folder") return Promise.resolve(null);
    if (command === "workspace_list_pinned_folders") return Promise.resolve([]);
    if (command === "terminal_list_shells") return Promise.resolve([]);
    if (command === "settings_get") return Promise.resolve(null);
    if (command === "breakpoints_load") return Promise.resolve([]);
    if (command === "language_registry") return Promise.resolve([]);
    if (command === "ai_providers_list" || command === "ai_conversations_list")
      return Promise.resolve([]);
    return Promise.resolve(undefined);
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: vi.fn().mockResolvedValue(""),
  writeText: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
  save: vi.fn().mockResolvedValue(null),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    minimize: vi.fn().mockResolvedValue(undefined),
    toggleMaximize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    isMaximized: vi.fn().mockResolvedValue(false),
    isFullscreen: vi.fn().mockResolvedValue(false),
    setFullscreen: vi.fn().mockResolvedValue(undefined),
    onResized: vi.fn().mockResolvedValue(() => undefined),
  }),
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ setZoom: vi.fn().mockResolvedValue(undefined) }),
}));

import { App } from "./App";
import { container } from "./services/container";

// Monaco's clipboard service (started by the editor theme) handles every click
// by writing a ClipboardItem whose data promise it may cancel later; jsdom has
// no clipboard. Like a browser, the fake waits for (and so handles) that promise.
class FakeClipboardItem {
  constructor(readonly data: Record<string, Promise<unknown>>) {}
}
Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: {
    write: (items: FakeClipboardItem[]) =>
      Promise.all(items.flatMap((item) => Object.values(item.data))).then(
        () => undefined,
        () => undefined,
      ),
  },
});
vi.stubGlobal("ClipboardItem", FakeClipboardItem);

describe("App", () => {
  it("renders the VS Code-style workbench chrome immediately", () => {
    render(<App />);

    expect(screen.getByRole("menubar", { name: "Application menu" })).toBeInTheDocument();
    expect(screen.getByLabelText("editor area")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Explorer" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(screen.getByLabelText("Status bar")).toBeInTheDocument();
  });

  it("shows the welcome page and a 'No Folder Opened' explorer once startup finishes", async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("Open File...")).toBeInTheDocument();
    });
    expect(screen.getByText("New File...")).toBeInTheDocument();
    expect(screen.getByText("Open Folder...")).toBeInTheDocument();
    expect(screen.getByText("Code anywhere")).toBeInTheDocument();
    expect(screen.getByText("You have not yet opened a folder.")).toBeInTheDocument();
  });

  it("shows Welcome as a closable tab, then the watermark, and Help > Welcome brings it back", async () => {
    render(<App />);

    const tab = await screen.findByRole("tab", { name: /Welcome/ });
    expect(tab).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Start" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Show welcome page on startup" })).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Close Welcome" }));
    expect(screen.queryByRole("tab", { name: /Welcome/ })).toBeNull();
    expect(screen.getByText("New Untitled Text File")).toBeInTheDocument();

    act(() => {
      container.run("help.welcome");
    });
    expect(await screen.findByRole("tab", { name: /Welcome/ })).toBeInTheDocument();
  });

  it("toggles the secondary side bar (Output beside the editor) from the title bar", async () => {
    render(<App />);
    const toggle = await screen.findByRole("button", { name: "Toggle Secondary Side Bar" });
    expect(screen.queryByRole("complementary", { name: "Secondary Side Bar" })).toBeNull();

    fireEvent.click(toggle);
    const aside = await screen.findByRole("complementary", { name: "Secondary Side Bar" });
    expect(within(aside).getByText(/No output in “Run Code” yet/)).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(within(aside).getByRole("button", { name: "Hide Secondary Side Bar" }));
    await waitFor(() => {
      expect(screen.queryByRole("complementary", { name: "Secondary Side Bar" })).toBeNull();
    });
  });

  it("opens the secondary side bar on a channel that doesn't exist yet without looping", async () => {
    // At start-up a restored side bar can show a run's channel (e.g. "Python") before any run created it.
    await container.secondarySideBar.showOutput("Python");
    render(<App />);
    const aside = await screen.findByRole("complementary", { name: "Secondary Side Bar" });
    expect(within(aside).getByText(/No output in “Python” yet/)).toBeInTheDocument();
    await container.secondarySideBar.hide();
  });

  it("opens the File menu with shortcuts and lists only commands that exist", async () => {
    render(<App />);

    fireEvent.mouseDown(screen.getByRole("menuitem", { name: "File" }));

    const menu = await screen.findByRole("menu", { name: "File" });
    const save = within(menu).getByText("Save").closest("[role=menuitem]");
    expect(save).toHaveTextContent("Ctrl+S");
    const newWindow = within(menu).getByText("New Window").closest("[role=menuitem]");
    expect(newWindow).not.toHaveAttribute("aria-disabled");
    expect(newWindow).toHaveTextContent("Ctrl+Shift+N");
    // Features that don't exist yet are not listed at all (no dead, greyed-out items).
    for (const missing of ["Open Workspace from File...", "Save Workspace As...", "Auto Save"]) {
      expect(within(menu).queryByText(missing)).toBeNull();
    }
    const openFolder = within(menu).getByText("Open Folder...").closest("[role=menuitem]");
    expect(openFolder).not.toHaveAttribute("aria-disabled");
  });

  it("has File, Edit, Selection, View, Go, Run, Terminal, Help and About in the menu bar", () => {
    render(<App />);
    const bar = within(screen.getByRole("menubar", { name: "Application menu" }));
    expect(bar.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "File",
      "Edit",
      "Selection",
      "View",
      "Go",
      "Run",
      "Terminal",
      "Help",
      "About",
    ]);
  });

  it("every item in every menu is backed by a registered command, with no empty groups", async () => {
    render(<App />);
    for (const name of ["File", "Edit", "Selection", "View", "Go", "Run", "Terminal", "Help"]) {
      fireEvent.mouseDown(screen.getByRole("menuitem", { name }));
      const menu = await screen.findByRole("menu", { name });
      const rows = within(menu).getAllByRole("menuitem");
      expect(rows.length, name).toBeGreaterThan(0);
      const children = [...menu.children];
      expect(children[0]?.getAttribute("role"), `${name} starts with a separator`).not.toBe(
        "separator",
      );
      expect(
        children[children.length - 1]?.getAttribute("role"),
        `${name} ends with a separator`,
      ).not.toBe("separator");
      children.forEach((child, index) => {
        if (child.getAttribute("role") === "separator") {
          expect(
            children[index + 1]?.getAttribute("role"),
            `${name}: two separators in a row`,
          ).not.toBe("separator");
        }
      });
      fireEvent.keyDown(menu, { key: "Escape" });
    }
  });

  it("About opens the About window straight from the menu bar", async () => {
    render(<App />);
    fireEvent.mouseDown(screen.getByRole("menuitem", { name: "About" }));
    const dialog = await screen.findByRole("dialog", { name: "OpenMind Studio" });
    expect(within(dialog).getByText("Md Shahanur Islam Shagor")).toBeInTheDocument();
    expect(within(dialog).getByText("Founder & Developer, OpenMind Studio")).toBeInTheDocument();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("the Help menu has the real Help commands and no dead links", async () => {
    render(<App />);
    fireEvent.mouseDown(screen.getByRole("menuitem", { name: "Help" }));
    const menu = await screen.findByRole("menu", { name: "Help" });
    const labels = within(menu)
      .getAllByRole("menuitem")
      .map((row) => row.textContent.replace(/Ctrl.*$/, "").trim());
    expect(labels).toEqual([
      "Welcome",
      "Show All Commands",
      "Keyboard Shortcuts",
      "Show Logs",
      "Open Logs Folder",
      "About OpenMind Studio",
    ]);
  });

  it("opens a menu from the keyboard with its Alt mnemonic", async () => {
    render(<App />);

    fireEvent.keyDown(window, { code: "KeyV", altKey: true });

    const menu = await screen.findByRole("menu", { name: "View" });
    expect(within(menu).getByText("Appearance")).toBeInTheDocument();
    expect(within(menu).getByText("Word Wrap")).toBeInTheDocument();
  });
});
