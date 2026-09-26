import { describe, expect, it, vi } from "vitest";

import { aiRig, providerInfo } from "../../testUtils/aiFixtures";
import { LARGE_MESSAGE_CHARS, LONG_CONVERSATION_TOKENS } from "./aiChatService";
import type { AiChatResult } from "./aiIpc";

async function ready(options: Parameters<typeof aiRig>[0] = {}) {
  const rig = aiRig({ providers: [providerInfo()], ...options });
  await rig.providers.initialize();
  await rig.chat.initialize();
  return rig;
}

function answer(text: string): Promise<AiChatResult> {
  return Promise.resolve({ text, cancelled: false });
}

describe("AiChatService: nothing is sent without the user", () => {
  it("makes no request when it starts or when providers load", async () => {
    const rig = await ready();
    expect(rig.ipc.aiChatSend).not.toHaveBeenCalled();
    expect(rig.chat.getState().messages).toEqual([]);
  });

  it("asks first for an online provider, naming the provider, its host and what is sent", async () => {
    const rig = await ready();
    vi.mocked(rig.ipc.aiChatSend).mockReturnValue(answer("hi"));
    await rig.chat.submit({ text: "explain this", what: "the selected code" });
    expect(rig.ipc.aiChatSend).not.toHaveBeenCalled();
    expect(rig.chat.getState().confirmation).toEqual({
      providerId: "p1",
      providerName: "Mock AI",
      host: "api.example.com",
      what: "the selected code",
      chars: 12,
      large: false,
    });
  });

  it("sends only after the user confirms, and not at all when they cancel", async () => {
    const rig = await ready();
    vi.mocked(rig.ipc.aiChatSend).mockReturnValue(answer("hi"));
    await rig.chat.submit({ text: "one" });
    rig.chat.cancelConfirmation();
    expect(rig.chat.getState().confirmation).toBeNull();
    expect(rig.ipc.aiChatSend).not.toHaveBeenCalled();
    expect(rig.chat.getState().messages).toEqual([]);

    await rig.chat.submit({ text: "two" });
    await rig.chat.confirm();
    expect(rig.ipc.aiChatSend).toHaveBeenCalledTimes(1);
    expect(rig.chat.getState().messages.map((m) => m.content)).toEqual(["two", "hi"]);
  });

  it("gives back what the user typed when they decline, but not a generated action prompt", async () => {
    const rig = await ready();
    rig.chat.setDraft("my private question");
    await rig.chat.sendDraft();
    expect(rig.chat.getState().draft).toBe("");
    expect(rig.chat.getState().confirmation).not.toBeNull();
    // Typed again while the question was open: nothing is lost.
    rig.chat.setDraft("and another thing");
    rig.chat.cancelConfirmation();
    expect(rig.chat.getState().draft).toBe("my private question\nand another thing");

    await rig.chat.submit({ text: "Explain this code ...", what: "the selected code" });
    rig.chat.setDraft("");
    rig.chat.cancelConfirmation();
    expect(rig.chat.getState().draft).toBe("");
    expect(rig.ipc.aiChatSend).not.toHaveBeenCalled();
  });

  it("does not ask for a provider on this computer", async () => {
    const rig = await ready({
      providers: [providerInfo({ local: true, needsKey: false, host: "127.0.0.1" })],
    });
    vi.mocked(rig.ipc.aiChatSend).mockReturnValue(answer("ok"));
    await rig.chat.submit({ text: "hello" });
    expect(rig.chat.getState().confirmation).toBeNull();
    expect(rig.ipc.aiChatSend).toHaveBeenCalledTimes(1);
  });

  it("skips the question when confirmations are off — except for a large message", async () => {
    const rig = await ready({ settings: { "ai.confirmBeforeOnlineRequest": false } });
    vi.mocked(rig.ipc.aiChatSend).mockReturnValue(answer("ok"));
    await rig.chat.submit({ text: "small" });
    expect(rig.ipc.aiChatSend).toHaveBeenCalledTimes(1);

    await rig.chat.submit({ text: "x".repeat(LARGE_MESSAGE_CHARS + 1) });
    expect(rig.ipc.aiChatSend).toHaveBeenCalledTimes(1);
    expect(rig.chat.getState().confirmation).toMatchObject({ large: true });
  });

  it("refuses with a reason when there is no key, no model, no provider or a request is running", async () => {
    const noKey = await ready({ providers: [providerInfo({ hasKey: false })] });
    expect(noKey.chat.sendBlocker()).toContain("Add an API key");
    await noKey.chat.submit({ text: "hi" });
    expect(noKey.ipc.aiChatSend).not.toHaveBeenCalled();
    expect(noKey.chat.getState().notice).toContain("Add an API key");

    const none = await ready({ providers: [] });
    expect(none.chat.sendBlocker()).toBe("No AI provider is enabled.");

    const busy = await ready();
    busy.chat.cancelConfirmation();
    vi.mocked(busy.ipc.aiChatSend).mockReturnValue(new Promise(() => undefined));
    void busy.chat.submit({ text: "first" }).then(() => busy.chat.confirm());
    await vi.waitFor(() => {
      expect(busy.chat.getState().sending).toBe(true);
    });
    expect(busy.chat.sendBlocker()).toBe("Wait for the answer, or press Stop.");
  });
});

describe("AiChatService: answers, streaming, stopping and errors", () => {
  it("shows the answer as it streams and keeps the final text", async () => {
    const rig = await ready({ settings: { "ai.confirmBeforeOnlineRequest": false } });
    let finish: (result: AiChatResult) => void = () => undefined;
    vi.mocked(rig.ipc.aiChatSend).mockImplementation(
      (requestId: string) =>
        new Promise<AiChatResult>((resolve) => {
          finish = resolve;
          rig.pushChunk({ requestId, text: "Hel" });
          rig.pushChunk({ requestId, text: "lo" });
        }),
    );
    const sending = rig.chat.submit({ text: "hi" });
    await vi.waitFor(() => {
      expect(rig.chat.getState().messages.at(-1)?.content).toBe("Hello");
    });
    expect(rig.chat.getState().messages.at(-1)?.streaming).toBe(true);
    finish({ text: "Hello", cancelled: false });
    await sending;
    expect(rig.chat.getState().messages.at(-1)).toMatchObject({
      content: "Hello",
      streaming: false,
      error: null,
    });
    expect(rig.chat.getState().sending).toBe(false);
  });

  it("ignores pieces that belong to another request", async () => {
    const rig = await ready({ settings: { "ai.confirmBeforeOnlineRequest": false } });
    vi.mocked(rig.ipc.aiChatSend).mockReturnValue(new Promise(() => undefined));
    void rig.chat.submit({ text: "hi" });
    await vi.waitFor(() => {
      expect(rig.chat.getState().sending).toBe(true);
    });
    rig.pushChunk({ requestId: "someone-else", text: "leak" });
    expect(rig.chat.getState().messages.at(-1)?.content).toBe("");
  });

  it("Stop cancels the running request and keeps what arrived", async () => {
    const rig = await ready({ settings: { "ai.confirmBeforeOnlineRequest": false } });
    let resolveSend: (result: AiChatResult) => void = () => undefined;
    vi.mocked(rig.ipc.aiChatSend).mockImplementation(
      (requestId: string) =>
        new Promise<AiChatResult>((resolve) => {
          resolveSend = resolve;
          rig.pushChunk({ requestId, text: "partial" });
        }),
    );
    const sending = rig.chat.submit({ text: "hi" });
    await vi.waitFor(() => {
      expect(rig.chat.getState().messages.at(-1)?.content).toBe("partial");
    });
    await rig.chat.stop();
    expect(rig.ipc.aiRequestCancel).toHaveBeenCalledWith(rig.chat.getState().requestId);
    resolveSend({ text: "", cancelled: true });
    await sending;
    expect(rig.chat.getState().messages.at(-1)).toMatchObject({
      content: "partial",
      stopped: true,
      streaming: false,
    });
    expect(rig.chat.getState().sending).toBe(false);
  });

  it("keeps a provider error in the conversation and Retry sends the conversation again", async () => {
    const rig = await ready({ settings: { "ai.confirmBeforeOnlineRequest": false } });
    const send = vi.mocked(rig.ipc.aiChatSend);
    send.mockRejectedValueOnce("The provider rejected the API key or the request (HTTP 401).");
    await rig.chat.submit({ text: "hi" });
    const failed = rig.chat.getState().messages.at(-1);
    expect(failed?.error).toContain("HTTP 401");
    expect(rig.chat.getState().sending).toBe(false);

    send.mockReturnValueOnce(answer("recovered"));
    await rig.chat.retry();
    expect(send).toHaveBeenCalledTimes(2);
    const messages = rig.chat.getState().messages;
    expect(messages.map((m) => m.content)).toEqual(["hi", "recovered"]);
    expect(messages.at(-1)?.error).toBeNull();
    // The retry sent the same single user message, not a duplicate.
    const request = send.mock.calls[1]?.[2] as { messages: { role: string; content: string }[] };
    expect(request.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("sends the model of the selected provider and the whole conversation", async () => {
    const rig = await ready({ settings: { "ai.confirmBeforeOnlineRequest": false } });
    const send = vi.mocked(rig.ipc.aiChatSend);
    send.mockReturnValueOnce(answer("first")).mockReturnValueOnce(answer("second"));
    await rig.chat.submit({ text: "one" });
    await rig.chat.submit({ text: "two" });
    const [, providerId, request] = send.mock.calls[1] as [
      string,
      string,
      { model: string; messages: { content: string }[]; system: string },
    ];
    expect(providerId).toBe("p1");
    expect(request.model).toBe("m1");
    expect(request.messages.map((m) => m.content)).toEqual(["one", "first", "two"]);
    expect(request.system).toContain("OpenMind Studio");
  });
});

describe("AiChatService: the conversation and its history", () => {
  it("saves the conversation locally after an answer, and not when saving is off", async () => {
    const rig = await ready({ settings: { "ai.confirmBeforeOnlineRequest": false } });
    vi.mocked(rig.ipc.aiChatSend).mockReturnValue(answer("hi"));
    await rig.chat.submit({ text: "hello there", title: "Greeting" });
    expect(rig.ipc.aiConversationSave).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Greeting",
        providerId: "p1",
        model: "m1",
        messages: [
          expect.objectContaining({ role: "user", content: "hello there" }),
          expect.objectContaining({ role: "assistant", content: "hi" }),
        ],
      }),
    );

    const off = await ready({
      settings: { "ai.confirmBeforeOnlineRequest": false, "ai.saveConversationHistory": false },
    });
    vi.mocked(off.ipc.aiChatSend).mockReturnValue(answer("hi"));
    await off.chat.submit({ text: "private" });
    expect(off.ipc.aiConversationSave).not.toHaveBeenCalled();
  });

  it("titles a new chat from the first message", async () => {
    const rig = await ready({ settings: { "ai.confirmBeforeOnlineRequest": false } });
    vi.mocked(rig.ipc.aiChatSend).mockReturnValue(answer("hi"));
    await rig.chat.submit({ text: "How do I reverse a list in Python?" });
    expect(rig.chat.getState().title).toBe("How do I reverse a list in Python?");
  });

  it("starts a new chat, clears a chat with its saved copy, and opens or deletes saved ones", async () => {
    const rig = await ready({
      settings: { "ai.confirmBeforeOnlineRequest": false },
      ipc: {
        aiConversationLoad: vi.fn().mockResolvedValue({
          id: "saved",
          title: "Old chat",
          providerId: "p1",
          model: "m1",
          createdAt: 1,
          updatedAt: 2,
          messages: [
            { role: "user", content: "q", error: null, createdAt: 1 },
            { role: "assistant", content: "a", error: null, createdAt: 2 },
          ],
        }),
        aiConversationsList: vi.fn().mockResolvedValue([
          {
            id: "saved",
            title: "Old chat",
            providerId: "p1",
            model: "m1",
            updatedAt: 2,
            messageCount: 2,
          },
        ]),
      },
    });
    vi.mocked(rig.ipc.aiChatSend).mockReturnValue(answer("hi"));
    await rig.chat.submit({ text: "hello" });
    const id = rig.chat.getState().conversationId;
    await rig.chat.clear();
    expect(rig.chat.getState().messages).toEqual([]);
    expect(rig.ipc.aiConversationDelete).toHaveBeenCalledWith(id);

    await rig.chat.loadHistory();
    expect(rig.chat.getState().history).toHaveLength(1);
    await rig.chat.open("saved");
    expect(rig.chat.getState()).toMatchObject({ conversationId: "saved", title: "Old chat" });
    expect(rig.chat.getState().messages.map((m) => m.content)).toEqual(["q", "a"]);

    await rig.chat.deleteConversation("saved");
    expect(rig.ipc.aiConversationDelete).toHaveBeenCalledWith("saved");
    expect(rig.chat.getState().messages).toEqual([]);

    await rig.chat.clearHistory();
    expect(rig.ipc.aiConversationsClear).toHaveBeenCalled();
    expect(rig.chat.getState().history).toEqual([]);
  });

  it("warns when the conversation gets long", async () => {
    const rig = await ready({ settings: { "ai.confirmBeforeOnlineRequest": false } });
    expect(rig.chat.contextWarning()).toBeNull();
    vi.mocked(rig.ipc.aiChatSend).mockReturnValue(answer("ok"));
    // Larger than a "large message", so it is confirmed first.
    await rig.chat.submit({ text: "y".repeat(LONG_CONVERSATION_TOKENS * 4 + 8) });
    await rig.chat.confirm();
    expect(rig.chat.contextWarning()).toContain("long");
  });

  it("stops a request and drops a waiting question when the provider goes away", async () => {
    const rig = await ready();
    await rig.chat.submit({ text: "hi" });
    expect(rig.chat.getState().confirmation).not.toBeNull();
    await rig.providers.setEnabled("p1", false);
    rig.chat.onProvidersChanged();
    expect(rig.chat.getState().confirmation).toBeNull();
    await rig.chat.confirm();
    expect(rig.ipc.aiChatSend).not.toHaveBeenCalled();
  });
});
