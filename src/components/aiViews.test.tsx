import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AiActionsService, type AiContextSource } from "../services/ai/aiActionsService";
import type { AiChatResult } from "../services/ai/aiIpc";
import { AiUiService } from "../services/ai/aiUiService";
import { aiExtension, aiRig, providerInfo } from "../testUtils/aiFixtures";

const harness = vi.hoisted((): { current: unknown } => ({ current: null }));

vi.mock("../services/container", () => ({
  get container() {
    return harness.current;
  },
}));

import { AiView } from "./AiView";
import { AiConfirmDialog } from "./ai/AiConfirmDialog";
import { AiProviderManager } from "./ai/AiProviderManager";

Element.prototype.scrollIntoView = vi.fn();

// A stable snapshot: a store that returns a new object on every read loops `useSyncExternalStore`.
const WORKSPACE_STATE = {};

interface MountOptions {
  rig?: Parameters<typeof aiRig>[0];
  source?: Partial<AiContextSource>;
}

async function mount(options: MountOptions = {}) {
  const rig = aiRig({ providers: [providerInfo()], ...options.rig });
  await rig.providers.initialize();
  await rig.chat.initialize();
  const source: AiContextSource = {
    activeKind: () => "text",
    selection: () => null,
    terminalSelection: () => "",
    activePreview: () => null,
    insertAtCursor: vi.fn().mockReturnValue(true),
    ...options.source,
  };
  const actions = new AiActionsService(
    source,
    rig.chat,
    { showView: vi.fn().mockResolvedValue(undefined) },
    rig.events,
  );
  const ui = new AiUiService();
  const notices: string[] = [];
  rig.events.on("appNotice", ({ message }) => {
    notices.push(message);
  });
  const run = vi.fn();
  harness.current = {
    ai: { providers: rig.providers, chat: rig.chat, actions, ui },
    ipc: rig.ipc,
    events: rig.events,
    settings: rig.settings,
    run,
    editor: { subscribe: () => () => undefined, getStatus: () => null },
    workspace: { subscribe: () => () => undefined, getState: () => WORKSPACE_STATE },
  };
  return { rig, actions, ui, source, notices, run };
}

function answer(text: string): Promise<AiChatResult> {
  return Promise.resolve({ text, cancelled: false });
}

beforeEach(() => {
  harness.current = null;
});

describe("AiProviderManager", () => {
  it("lists a provider with its kind, Online/Local label, key state and status", async () => {
    const { ui } = await mount({
      rig: {
        providers: [
          providerInfo({ hasKey: true }),
          providerInfo({
            id: "loc",
            name: "Llama",
            kind: "local",
            local: true,
            needsKey: false,
            hasKey: false,
            host: "127.0.0.1",
          }),
        ],
      },
    });
    ui.openManager();
    render(<AiProviderManager />);
    const dialog = screen.getByRole("dialog", { name: "AI Providers" });
    expect(within(dialog).getByText(/Online · api\.example\.com/)).toBeInTheDocument();
    expect(within(dialog).getByText(/API key saved/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Local · 127\.0\.0\.1/)).toBeInTheDocument();
    expect(within(dialog).getByText(/No API key needed/)).toBeInTheDocument();
    expect(within(dialog).getAllByText("Ready.")).toHaveLength(2);
  });

  it("tests the connection on request and shows the result or the failure", async () => {
    const { rig, ui } = await mount();
    ui.openManager();
    render(<AiProviderManager />);
    expect(rig.ipc.aiProviderTest).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("Connected. 2 models available.")).toBeInTheDocument();

    vi.mocked(rig.ipc.aiProviderTest).mockRejectedValueOnce(
      "The provider rejected the API key or the request (HTTP 401).",
    );
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText(/HTTP 401/)).toBeInTheDocument();
  });

  it("turns a provider off and on with its Enabled box", async () => {
    const { rig, ui } = await mount();
    ui.openManager();
    render(<AiProviderManager />);
    const box = screen.getByRole("checkbox", { name: "Enabled" });
    fireEvent.click(box);
    await waitFor(() => {
      expect(rig.ipc.aiProviderSetEnabled).toHaveBeenCalledWith("p1", false);
    });
    await waitFor(() => {
      expect(screen.getByText("This provider is turned off.")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Test connection" })).toBeDisabled();
  });

  it("deletes a provider only after a confirmation", async () => {
    const { rig, ui } = await mount();
    ui.openManager();
    render(<AiProviderManager />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const confirm = screen.getByRole("alertdialog");
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(rig.ipc.aiProviderDelete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }),
    );
    await waitFor(() => {
      expect(rig.ipc.aiProviderDelete).toHaveBeenCalledWith("p1");
    });
    expect(await screen.findByText(/No AI providers yet/)).toBeInTheDocument();
  });

  it("offers Delete for a provider whose extension was uninstalled", async () => {
    const extension = aiExtension();
    const { rig, ui } = await mount({ rig: { providers: [], extensions: [extension] } });
    rig.setExtensions([]);
    ui.openManager();
    render(<AiProviderManager />);
    expect(await screen.findByText(/is not installed/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }),
    );
    await waitFor(() => {
      expect(rig.ipc.aiProviderDelete).toHaveBeenCalled();
    });
  });

  it("does not offer Delete for an extension's provider, and says how to remove it", async () => {
    const { ui } = await mount({ rig: { providers: [], extensions: [aiExtension()] } });
    ui.openManager();
    render(<AiProviderManager />);
    expect(await screen.findByText("Acme AI")).toBeInTheDocument();
    expect(screen.getByText(/from extension Sample AI Provider/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(
      screen.getByText("Disable or uninstall the extension to remove it."),
    ).toBeInTheDocument();
  });

  it("edits a provider: the key field is masked, empty means keep, and the saved key can be cleared", async () => {
    const { rig, ui } = await mount();
    ui.openManager("p1");
    render(<AiProviderManager />);
    const key = screen.getByLabelText("API key");
    expect(key).toHaveAttribute("type", "password");
    expect(key).toHaveValue("");
    expect(key).toHaveAttribute("placeholder", expect.stringContaining("Saved"));

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(rig.ipc.aiProviderSave).toHaveBeenCalled();
    });
    expect(rig.ipc.aiProviderSetKey).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("API key")).toBeNull();

    act(() => {
      ui.edit("p1");
    });
    fireEvent.click(screen.getByRole("button", { name: "Clear saved API key" }));
    await waitFor(() => {
      expect(rig.ipc.aiProviderClearKey).toHaveBeenCalledWith("p1");
    });
    expect(rig.providers.find("p1")?.hasKey).toBe(false);
  });

  it("shows why a save was refused", async () => {
    const { rig, ui } = await mount({ rig: { providers: [] } });
    vi.mocked(rig.ipc.aiProviderSave).mockRejectedValueOnce("Only https endpoints are allowed.");
    ui.openManager("new");
    render(<AiProviderManager />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Bad" } });
    fireEvent.change(screen.getByLabelText("Endpoint address"), {
      target: { value: "http://example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Only https endpoints are allowed.");
  });

  it("clears the saved AI history only after a confirmation", async () => {
    const { rig, ui } = await mount();
    ui.openManager();
    render(<AiProviderManager />);
    fireEvent.click(screen.getByRole("button", { name: "Clear AI history" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Clear history" }),
    );
    await waitFor(() => {
      expect(rig.ipc.aiConversationsClear).toHaveBeenCalled();
    });
  });

  it("renders nothing while closed", async () => {
    await mount();
    render(<AiProviderManager />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("AiConfirmDialog", () => {
  it("names the provider, the host and the content, and warns about a large message", async () => {
    const { rig } = await mount();
    render(<AiConfirmDialog />);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await act(async () => {
      await rig.chat.submit({ text: "x".repeat(25_000), what: "the selected code" });
    });
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("Send to Mock AI?");
    expect(dialog).toHaveTextContent(
      "This will send the selected code (about 25,000 characters) to Mock AI (api.example.com). It leaves this computer.",
    );
    expect(dialog).toHaveTextContent("large amount of text");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(rig.ipc.aiChatSend).not.toHaveBeenCalled();
  });
});

describe("AiView", () => {
  it("renders nothing without a provider", async () => {
    await mount({ rig: { providers: [] } });
    const { container: view } = render(<AiView />);
    expect(view).toBeEmptyDOMElement();
  });

  it("offers a provider selector only when there are several, and a model selector", async () => {
    const one = await mount();
    const first = render(<AiView />);
    expect(screen.queryByLabelText("Provider")).toBeNull();
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "m2" } });
    await waitFor(() => {
      expect(one.rig.providers.find("p1")?.model).toBe("m2");
    });
    first.unmount();

    await mount({
      rig: { providers: [providerInfo(), providerInfo({ id: "p2", name: "Second" })] },
    });
    render(<AiView />);
    const select = screen.getByLabelText("Provider");
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Mock AI", "Second"]);
    fireEvent.change(select, { target: { value: "p2" } });
    expect(await screen.findByText(/Second/)).toBeInTheDocument();
  });

  it("uses a text field for the model when the provider lists none", async () => {
    const { rig } = await mount({ rig: { providers: [providerInfo({ model: "", models: [] })] } });
    render(<AiView />);
    // No model chosen: a configuration prompt, not a chat.
    expect(screen.getByText(/Choose a model for Mock AI/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Message")).toBeNull();
    const field = screen.getByLabelText("Model");
    fireEvent.change(field, { target: { value: "gpt-x" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => {
      expect(rig.providers.find("p1")?.model).toBe("gpt-x");
    });
    expect(await screen.findByLabelText("Message")).toBeInTheDocument();
  });

  it("keeps Send disabled with a reason until there is text, and sends with Enter after confirmation", async () => {
    const { rig } = await mount({ rig: { settings: { "ai.confirmBeforeOnlineRequest": false } } });
    vi.mocked(rig.ipc.aiChatSend).mockReturnValue(answer("hello!"));
    render(<AiView />);
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeDisabled();
    expect(send).toHaveAttribute("title", "Type a message first.");
    const box = screen.getByLabelText("Message");
    fireEvent.change(box, { target: { value: "Hi there" } });
    expect(send).toBeEnabled();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(await screen.findByText("hello!")).toBeInTheDocument();
    expect(screen.getByText("Hi there")).toBeInTheDocument();
    expect(box).toHaveValue("");
  });

  it("puts the text back in the message box when the user declines the confirmation", async () => {
    await mount();
    render(<AiView />);
    render(<AiConfirmDialog />);
    const box = screen.getByLabelText("Message");
    fireEvent.change(box, { target: { value: "Do not send this yet" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(box).toHaveValue("");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(box).toHaveValue("Do not send this yet");
    });
  });

  it("shows Stop while an answer arrives, and Stop cancels the request", async () => {
    const { rig } = await mount({ rig: { settings: { "ai.confirmBeforeOnlineRequest": false } } });
    vi.mocked(rig.ipc.aiChatSend).mockImplementation(
      (requestId: string) =>
        new Promise<AiChatResult>((resolve) => {
          rig.pushChunk({ requestId, text: "Thinking" });
          vi.mocked(rig.ipc.aiRequestCancel).mockImplementationOnce(() => {
            resolve({ text: "", cancelled: true });
            return Promise.resolve();
          });
        }),
    );
    render(<AiView />);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "go" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const stop = await screen.findByRole("button", { name: "Stop" });
    expect(await screen.findByText("Thinking")).toBeInTheDocument();
    fireEvent.click(stop);
    expect(await screen.findByText("Stopped.")).toBeInTheDocument();
    expect(rig.ipc.aiRequestCancel).toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "Send" })).toBeInTheDocument();
    expect(screen.getByText("Thinking")).toBeInTheDocument();
  });

  it("shows a failed answer with its error and a Retry that works", async () => {
    const { rig } = await mount({ rig: { settings: { "ai.confirmBeforeOnlineRequest": false } } });
    const send = vi.mocked(rig.ipc.aiChatSend);
    send.mockRejectedValueOnce("The provider could not be reached: connection refused");
    render(<AiView />);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("connection refused");

    send.mockReturnValueOnce(answer("back again"));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("back again")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders answers as text and code blocks — never as HTML — with Copy and Insert", async () => {
    const { rig, source } = await mount({
      rig: { settings: { "ai.confirmBeforeOnlineRequest": false } },
    });
    const reply = 'Try <img src=x onerror="alert(1)"> this:\n```ts\nconst a = 1;\n```';
    vi.mocked(rig.ipc.aiChatSend).mockReturnValue(answer(reply));
    render(<AiView />);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "code please" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("const a = 1;")).toBeInTheDocument();
    // The markup stayed text.
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText(/onerror/)).toBeInTheDocument();

    const list = screen.getByRole("list", { name: "Conversation" });
    const block = list.querySelector(".ai-code") as HTMLElement;
    fireEvent.click(within(block).getByRole("button", { name: "Insert" }));
    expect(source.insertAtCursor).toHaveBeenCalledWith("const a = 1;");
    fireEvent.click(within(block).getByRole("button", { name: "Copy" }));
    await waitFor(() => {
      expect(rig.ipc.clipboardWriteText).toHaveBeenCalledWith("const a = 1;");
    });
  });

  it("disables Insert with a reason when a preview is the active tab", async () => {
    const { rig } = await mount({
      rig: { settings: { "ai.confirmBeforeOnlineRequest": false } },
      source: { activeKind: () => "preview" },
    });
    vi.mocked(rig.ipc.aiChatSend).mockReturnValue(answer("```js\nx\n```"));
    render(<AiView />);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const insert = await screen.findByRole("button", { name: "Insert" });
    expect(insert).toBeDisabled();
    expect(insert).toHaveAttribute("title", "A preview can't be edited. Switch to a text file.");
  });

  it("shows every action, each disabled with its reason when it can't run", async () => {
    await mount({ source: { activeKind: () => "preview" } });
    render(<AiView />);
    const group = screen.getByRole("group", { name: "AI actions" });
    for (const name of [
      "Explain Selected Code",
      "Suggest Fix for Selected Code",
      "Generate Comment / Docstring",
    ]) {
      const button = within(group).getByRole("button", { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute(
        "title",
        "A preview is not a text editor. Switch to a text file.",
      );
    }
    expect(within(group).getByRole("button", { name: "Explain Terminal Error" })).toHaveAttribute(
      "title",
      "Select the terminal output to explain first.",
    );
    expect(
      within(group).getByRole("button", { name: "Summarize Current Preview" }),
    ).toHaveAttribute("title", "Open a file preview first.");
  });

  it("runs an enabled action through its command", async () => {
    const { run } = await mount({
      source: {
        selection: () => ({
          text: "x = 1",
          languageId: "python",
          fileName: "a.py",
          startLine: 1,
          endLine: 1,
        }),
      },
    });
    render(<AiView />);
    const button = screen.getByRole("button", { name: "Explain Selected Code" });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(run).toHaveBeenCalledWith("ai.explainSelection");
  });

  it("starts a new chat and clears a chat", async () => {
    const { rig } = await mount({ rig: { settings: { "ai.confirmBeforeOnlineRequest": false } } });
    vi.mocked(rig.ipc.aiChatSend).mockReturnValue(answer("hey"));
    render(<AiView />);
    expect(screen.getByRole("button", { name: "New chat" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("hey")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear chat" }));
    await waitFor(() => {
      expect(screen.queryByText("hey")).toBeNull();
    });
    expect(rig.ipc.aiConversationDelete).toHaveBeenCalled();
    expect(screen.getByText(/Ask a question/)).toBeInTheDocument();
  });

  it("lists saved conversations, opens and deletes them, and clears all", async () => {
    const { rig } = await mount({
      rig: {
        ipc: {
          aiConversationsList: vi.fn().mockResolvedValue([
            {
              id: "c1",
              title: "Closures",
              providerId: "p1",
              model: "m1",
              updatedAt: 5,
              messageCount: 2,
            },
          ]),
          aiConversationLoad: vi.fn().mockResolvedValue({
            id: "c1",
            title: "Closures",
            providerId: "p1",
            model: "m1",
            createdAt: 1,
            updatedAt: 5,
            messages: [
              { role: "user", content: "what is a closure", error: null, createdAt: 1 },
              { role: "assistant", content: "a function with memory", error: null, createdAt: 2 },
            ],
          }),
        },
      },
    });
    render(<AiView />);
    fireEvent.click(screen.getByRole("button", { name: "Show history" }));
    fireEvent.click(await screen.findByRole("button", { name: "Closures" }));
    expect(await screen.findByText("a function with memory")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete Closures" }));
    await waitFor(() => {
      expect(rig.ipc.aiConversationDelete).toHaveBeenCalledWith("c1");
    });
    fireEvent.click(screen.getByRole("button", { name: "Clear all history" }));
    await waitFor(() => {
      expect(rig.ipc.aiConversationsClear).toHaveBeenCalled();
    });
  });

  it("warns when the conversation is long", async () => {
    const { rig } = await mount({ rig: { settings: { "ai.confirmBeforeOnlineRequest": false } } });
    vi.mocked(rig.ipc.aiChatSend).mockReturnValue(answer("ok"));
    render(<AiView />);
    await act(async () => {
      await rig.chat.submit({ text: "y".repeat(130_000) });
      await rig.chat.confirm();
    });
    expect(await screen.findByText(/This conversation is long/)).toBeInTheDocument();
  });
});
