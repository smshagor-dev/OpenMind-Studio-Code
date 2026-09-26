import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AiChatResult, AiProviderConfig, AiProviderInfo } from "./services/ai/aiIpc";
import { providerInfo } from "./testUtils/aiFixtures";

// The whole app over a fake backend: the AI panel must exist only while a provider is enabled.
const backend = vi.hoisted(() => ({
  providers: [] as unknown[],
  calls: [] as { command: string; args: Record<string, unknown> | undefined }[],
  chat: { text: "Here is the answer." },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((command: string, args?: Record<string, unknown>) => {
    backend.calls.push({ command, args });
    const providers = backend.providers as AiProviderInfo[];
    switch (command) {
      case "theme_get":
        return Promise.resolve("dark");
      case "session_load":
        return Promise.resolve({ openPaths: [], activePath: null });
      case "recent_files_list":
      case "recent_folders_list":
      case "workspace_recent_folders":
      case "workspace_list_pinned_folders":
      case "terminal_list_shells":
      case "breakpoints_load":
      case "ai_conversations_list":
      case "language_registry":
        return Promise.resolve([]);
      case "settings_get":
      case "workspace_active_folder":
        return Promise.resolve(null);
      case "ai_providers_list":
        return Promise.resolve([...providers]);
      case "ai_provider_set_enabled": {
        const { id, enabled } = args as { id: string; enabled: boolean };
        const at = providers.findIndex((p) => p.id === id);
        const updated = { ...providers[at], enabled } as AiProviderInfo;
        providers[at] = updated;
        return Promise.resolve(updated);
      }
      case "ai_provider_save": {
        const { config } = args as { config: AiProviderConfig };
        const local = config.kind === "local" || config.baseUrl.includes("127.0.0.1");
        const info: AiProviderInfo = {
          ...config,
          hasKey: false,
          needsKey: !local,
          local,
          host: local ? "127.0.0.1" : "api.example.com",
        };
        const at = providers.findIndex((p) => p.id === config.id);
        if (at >= 0) providers[at] = { ...info, hasKey: providers[at]?.hasKey ?? false };
        else providers.push(info);
        return Promise.resolve(info);
      }
      case "ai_provider_set_key": {
        const { id } = args as { id: string };
        const at = providers.findIndex((p) => p.id === id);
        providers[at] = { ...providers[at], hasKey: true } as AiProviderInfo;
        return Promise.resolve(undefined);
      }
      case "ai_chat_send":
        return Promise.resolve({
          text: backend.chat.text,
          cancelled: false,
        } satisfies AiChatResult);
      default:
        return Promise.resolve(undefined);
    }
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
Element.prototype.scrollIntoView = vi.fn();

const aiButton = () => screen.queryByRole("button", { name: "AI" });

async function started(): Promise<void> {
  await screen.findByRole("button", { name: "Explorer" });
  // Start-up is finished when the session is restored and the welcome tab is shown.
  await screen.findByRole("tab", { name: /Welcome/ });
}

const sent = () => backend.calls.filter((call) => call.command === "ai_chat_send");

describe("the AI panel appears only with an enabled provider", () => {
  beforeEach(async () => {
    // The container is shared by the tests of this file: start each from the Explorer.
    await container.layout.showView("explorer");
    backend.providers.length = 0;
    backend.calls.length = 0;
    backend.chat.text = "Here is the answer.";
  });

  it("shows no AI item, no AI panel and no AI command — and makes no request — when no provider exists", async () => {
    render(<App />);
    await started();
    expect(aiButton()).toBeNull();
    expect(screen.queryByLabelText("Message")).toBeNull();
    expect(container.commands.has("ai.openChat")).toBe(false);
    expect(container.commands.has("ai.explainSelection")).toBe(false);
    // The provider manager is the way in, and it is always available.
    expect(container.commands.has("ai.manageProviders")).toBe(true);
    expect(sent()).toEqual([]);
    expect(backend.calls.some((call) => call.command === "ai_provider_test")).toBe(false);
  });

  it("shows the AI item and panel once a provider is enabled, hides them when it is disabled and restores them on enable", async () => {
    backend.providers.push(providerInfo({ hasKey: true }));
    render(<App />);
    await started();
    const button = await screen.findByRole("button", { name: "AI" });
    fireEvent.click(button);

    const panel = await screen.findByRole("complementary", { name: "AI" });
    expect(within(panel).getByText("Mock AI")).toBeInTheDocument();
    expect(within(panel).getByLabelText("Model")).toHaveValue("m1");
    expect(within(panel).getByText(/Online · api\.example\.com/)).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Send" })).toBeDisabled();
    expect(container.commands.has("ai.openChat")).toBe(true);

    await act(async () => {
      await container.ai.providers.setEnabled("p1", false);
    });
    await waitFor(() => {
      expect(aiButton()).toBeNull();
    });
    expect(screen.queryByRole("complementary", { name: "AI" })).toBeNull();
    expect(screen.getByRole("complementary", { name: "Explorer" })).toBeInTheDocument();
    expect(container.commands.has("ai.openChat")).toBe(false);

    await act(async () => {
      await container.ai.providers.setEnabled("p1", true);
    });
    expect(await screen.findByRole("button", { name: "AI" })).toBeInTheDocument();
    expect(await screen.findByRole("complementary", { name: "AI" })).toBeInTheDocument();
    expect(container.commands.has("ai.openChat")).toBe(true);
  });

  it("asks before sending to an online provider, names it, and shows the answer", async () => {
    backend.providers.push(providerInfo({ hasKey: true }));
    render(<App />);
    await started();
    fireEvent.click(await screen.findByRole("button", { name: "AI" }));
    const panel = await screen.findByRole("complementary", { name: "AI" });

    fireEvent.change(within(panel).getByLabelText("Message"), {
      target: { value: "What is a closure?" },
    });
    fireEvent.click(within(panel).getByRole("button", { name: "Send" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Send to Mock AI?")).toBeInTheDocument();
    expect(dialog).toHaveTextContent(
      "This will send your message (about 18 characters) to Mock AI (api.example.com). It leaves this computer.",
    );
    expect(sent()).toEqual([]);

    // Cancel: nothing was sent.
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(sent()).toEqual([]);

    fireEvent.change(within(panel).getByLabelText("Message"), {
      target: { value: "What is a closure?" },
    });
    fireEvent.click(within(panel).getByRole("button", { name: "Send" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Send" }),
    );
    expect(await within(panel).findByText("Here is the answer.")).toBeInTheDocument();
    expect(within(panel).getByText("What is a closure?")).toBeInTheDocument();
    expect(sent()).toHaveLength(1);
    expect(sent()[0]?.args).toMatchObject({
      providerId: "p1",
      request: { model: "m1", messages: [{ role: "user", content: "What is a closure?" }] },
    });
  });

  it("shows a provider that lacks its API key as a configuration prompt, not a broken chat", async () => {
    backend.providers.push(providerInfo({ hasKey: false }));
    render(<App />);
    await started();
    fireEvent.click(await screen.findByRole("button", { name: "AI" }));
    const panel = await screen.findByRole("complementary", { name: "AI" });
    expect(within(panel).getByText(/Add an API key for Mock AI/)).toBeInTheDocument();
    expect(within(panel).queryByLabelText("Message")).toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: "Open provider settings" }));

    const dialog = await screen.findByRole("dialog", { name: "AI Providers" });
    const key = within(dialog).getByLabelText("API key");
    expect(key).toHaveAttribute("type", "password");
    fireEvent.change(key, { target: { value: "sk-super-secret" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(backend.calls.some((call) => call.command === "ai_provider_set_key")).toBe(true);
    });
    const setKey = backend.calls.find((call) => call.command === "ai_provider_set_key");
    expect(setKey?.args).toEqual({ id: "p1", key: "sk-super-secret" });
    // The key is never shown again, and the chat is available now.
    expect(document.body.textContent).not.toContain("sk-super-secret");
    expect(await within(panel).findByLabelText("Message")).toBeInTheDocument();
  });

  it("adds the first provider from the manager, which turns the panel on", async () => {
    render(<App />);
    await started();
    expect(aiButton()).toBeNull();
    act(() => {
      container.run("ai.manageProviders");
    });
    const dialog = await screen.findByRole("dialog", { name: "AI Providers" });
    expect(within(dialog).getByText(/No AI providers yet/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Add provider" }));

    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Local Llama" } });
    fireEvent.change(within(dialog).getByLabelText("Type"), { target: { value: "local" } });
    fireEvent.change(within(dialog).getByLabelText("Model"), { target: { value: "llama3" } });
    // A local server needs no key: the key field isn't offered.
    expect(within(dialog).queryByLabelText("API key")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("button", { name: "AI" })).toBeInTheDocument();
    expect(within(dialog).getByText("Local Llama")).toBeInTheDocument();
    expect(within(dialog).getByText(/Local · 127\.0\.0\.1/)).toBeInTheDocument();
  });
});
