import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((command: string) => {
    if (command === "window_close_ready") return Promise.resolve("test-page-token");
    if (command === "window_restore") return Promise.resolve([]);
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
    listen: vi.fn().mockResolvedValue(() => undefined),
  }),
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ setZoom: vi.fn().mockResolvedValue(undefined) }),
}));

import { App } from "./App";
import { applyLanguageSetting, i18n } from "./i18n";

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


afterEach(() => {
  i18n.setSystemLanguage("en");
  i18n.setLanguage("en");
});

/** Nothing on screen may be a raw key: every key the UI asked for exists. */
function noMissingKeys() {
  expect([...i18n.missing]).toEqual([]);
}

describe("the workbench in the PC's language", () => {
  it("shows the menus, activity bar and welcome page in Russian", async () => {
    i18n.setSystemLanguage("ru");
    applyLanguageSetting("system");
    render(<App />);
    const menubar = screen.getByRole("menubar", { name: "Меню приложения" });
    for (const name of ["Файл", "Правка", "Выделение", "Вид", "Перейти", "Выполнить", "Терминал", "Справка"]) {
      expect(within(menubar).getByText(name)).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Проводник" })).toBeInTheDocument();
    await screen.findByText("Добро пожаловать");
    fireEvent.mouseDown(screen.getByRole("menuitem", { name: "Файл" }));
    const menu = await screen.findByRole("menu", { name: "Файл" });
    expect(within(menu).getByText("Сохранить как...")).toBeInTheDocument();
    expect(within(menu).getByText("Открыть папку...")).toBeInTheDocument();
    // A feature that isn't built stays disabled, with its reason in Russian.
    const workspace = within(menu).getByText("Сохранить рабочую область как...").closest("[role=menuitem]");
    expect(workspace).toHaveAttribute("aria-disabled", "true");
    noMissingKeys();
  });

  it("shows English when that is chosen by hand on a Russian PC", async () => {
    i18n.setSystemLanguage("ru");
    applyLanguageSetting("en");
    render(<App />);
    const menubar = screen.getByRole("menubar", { name: "Application menu" });
    expect(within(menubar).getByText("File")).toBeInTheDocument();
    expect(within(menubar).getByText("Help")).toBeInTheDocument();
    await screen.findByText("Welcome");
    noMissingKeys();
  });

  it("switches language live, without restarting the window", async () => {
    render(<App />);
    const menubar = screen.getByRole("menubar", { name: "Application menu" });
    expect(within(menubar).getByText("File")).toBeInTheDocument();
    act(() => {
      applyLanguageSetting("ru");
    });
    expect(await within(screen.getByRole("menubar")).findByText("Файл")).toBeInTheDocument();
    act(() => {
      applyLanguageSetting("en");
    });
    expect(await within(screen.getByRole("menubar")).findByText("File")).toBeInTheDocument();
  });

  it("Run and Debug and Extensions render in Russian with no missing text", async () => {
    i18n.setSystemLanguage("ru");
    applyLanguageSetting("system");
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /^Запуск и отладка/ }));
    expect(await screen.findByText("Точки останова")).toBeInTheDocument();
    expect(await screen.findByText("Откройте файл или папку, чтобы начать отладку.")).toBeInTheDocument();
    expect(screen.getByText("Переменные появляются, когда программа приостановлена.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Расширения/ }));
    expect(await screen.findByPlaceholderText("Поиск расширений в Marketplace")).toBeInTheDocument();
    noMissingKeys();
  });
});

