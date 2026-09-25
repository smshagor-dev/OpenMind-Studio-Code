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
    expect(screen.getByText("Portable AI-ready development environment")).toBeInTheDocument();
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

  it("opens the File menu with shortcuts, and disables commands of unbuilt features", async () => {
    render(<App />);

    fireEvent.mouseDown(screen.getByRole("menuitem", { name: "File" }));

    const menu = await screen.findByRole("menu", { name: "File" });
    const save = within(menu).getByText("Save").closest("[role=menuitem]");
    expect(save).toHaveTextContent("Ctrl+S");
    const newWindow = within(menu).getByText("New Window").closest("[role=menuitem]");
    expect(newWindow).not.toHaveAttribute("aria-disabled");
    expect(newWindow).toHaveTextContent("Ctrl+Shift+N");
    const workspaceFile = within(menu)
      .getByText("Open Workspace from File...")
      .closest("[role=menuitem]");
    expect(workspaceFile).toHaveAttribute("aria-disabled", "true");
    const openFolder = within(menu).getByText("Open Folder...").closest("[role=menuitem]");
    expect(openFolder).not.toHaveAttribute("aria-disabled");
  });

  it("opens a menu from the keyboard with its Alt mnemonic", async () => {
    render(<App />);

    fireEvent.keyDown(window, { code: "KeyV", altKey: true });

    const menu = await screen.findByRole("menu", { name: "View" });
    expect(within(menu).getByText("Appearance")).toBeInTheDocument();
    expect(within(menu).getByText("Word Wrap")).toBeInTheDocument();
  });
});
