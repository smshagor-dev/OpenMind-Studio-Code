import type { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import type {
  AiChatMessage,
  AiConversation,
  AiConversationSummary,
  AiIpc,
  AiStoredMessage,
} from "./aiIpc";
import {
  newRequestId,
  type AiProviderService,
  type AiProviderView,
  type AiSettingsSource,
} from "./aiProviderService";

export const SYSTEM_PROMPT =
  "You are the AI assistant built into OpenMind Studio, a desktop code editor. Answer concisely and accurately. " +
  "Use Markdown, and put code in fenced code blocks with the language name.";

/** More text than this in one message asks for a confirmation even when confirmations are off. */
export const LARGE_MESSAGE_CHARS = 20_000;
/** A conversation this long (in estimated tokens) gets a warning. */
export const LONG_CONVERSATION_TOKENS = 30_000;
const MAX_SAVED_MESSAGES = 1000;

export interface ChatMessageView {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Why the answer failed, when it did. */
  error: string | null;
  createdAt: number;
  /** The answer is still arriving. */
  streaming: boolean;
  /** The user pressed Stop (the text so far is kept). */
  stopped: boolean;
}

/** What is about to leave this computer, waiting for the user's yes. */
export interface PendingConfirmation {
  providerId: string;
  providerName: string;
  host: string;
  /** "your message", "selected code", "terminal output", "preview text" ... */
  what: string;
  chars: number;
  large: boolean;
}

export interface Submission {
  /** The text sent as the user's message (an action's prompt includes the code it is about). */
  text: string;
  what?: string;
  /** A short label for the conversation list. */
  title?: string;
  /** Send the conversation again as it is (Retry); nothing is added. */
  resend?: boolean;
}

export interface ChatState {
  conversationId: string;
  title: string;
  createdAt: number;
  messages: ChatMessageView[];
  sending: boolean;
  requestId: string | null;
  notice: string | null;
  confirmation: PendingConfirmation | null;
  /** What is typed in the message box. It is emptied when the message is sent and comes back if the user declines. */
  draft: string;
  history: AiConversationSummary[];
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

let messageCounter = 0;
function messageId(): string {
  messageCounter += 1;
  return `m${messageCounter.toString(36)}`;
}

function newConversationId(): string {
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * One conversation with the selected provider. A request is made only when the user submits (typing or a
 * button), never in the background. Before text goes to an online provider the user sees the provider's name,
 * its host and what kind of content it is, and says yes (unless they turned confirmations off and it is not a
 * large message). Answers stream in; Stop cancels; a failure is kept in the conversation and can be retried.
 * Conversations are saved locally only while "save conversation history" is on.
 */
export class AiChatService {
  private state: ChatState;
  private readonly listeners = new Set<() => void>();
  private pending: Submission | null = null;
  private stopChunks: (() => void) | null = null;

  constructor(
    private readonly ipc: AiIpc,
    private readonly events: EventBus<AppEvents>,
    private readonly providers: AiProviderService,
    private readonly settings: AiSettingsSource,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.state = this.emptyState([]);
  }

  private emptyState(history: AiConversationSummary[]): ChatState {
    return {
      conversationId: newConversationId(),
      title: "New chat",
      createdAt: this.now(),
      messages: [],
      sending: false,
      requestId: null,
      notice: null,
      confirmation: null,
      draft: "",
      history,
    };
  }

  getState(): ChatState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private set(patch: Partial<ChatState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Listens for answer pieces. (No request is made.) */
  async initialize(): Promise<void> {
    this.stopChunks?.();
    this.stopChunks = await this.ipc.onAiChunk((chunk) => {
      if (chunk.requestId !== this.state.requestId) return;
      this.updateLast((message) => ({ ...message, content: message.content + chunk.text }));
    });
  }

  dispose(): void {
    this.stopChunks?.();
    this.stopChunks = null;
  }

  private updateLast(change: (message: ChatMessageView) => ChatMessageView): void {
    const messages = [...this.state.messages];
    const last = messages.length - 1;
    const current = messages[last];
    if (current === undefined) return;
    messages[last] = change(current);
    this.set({ messages });
  }

  // --- Sending --------------------------------------------------------------------------------------------

  /** Why a message can't be sent right now, or null. */
  sendBlocker(): string | null {
    const provider = this.providers.selected();
    if (provider === null) return "No AI provider is enabled.";
    if (this.state.sending) return "Wait for the answer, or press Stop.";
    return this.providers.configIssue(provider);
  }

  /** Starts a request for the user's message — after the confirmation when the content leaves this computer. */
  async submit(submission: Submission): Promise<void> {
    const provider = this.providers.selected();
    const blocker = this.sendBlocker();
    if (provider === null || blocker !== null) {
      this.set({ notice: blocker });
      return;
    }
    const chars = submission.resend
      ? this.state.messages.reduce((total, m) => total + m.content.length, 0)
      : submission.text.length;
    const large = chars > LARGE_MESSAGE_CHARS;
    const confirmSetting = this.settings.bool("ai.confirmBeforeOnlineRequest", true);
    if (!provider.local && (confirmSetting || large)) {
      this.pending = submission;
      this.set({
        notice: null,
        confirmation: {
          providerId: provider.id,
          providerName: provider.name,
          host: provider.host,
          what: submission.what ?? "your message",
          chars,
          large,
        },
      });
      return;
    }
    await this.dispatch(provider, submission);
  }

  /** The user said yes to the confirmation. */
  async confirm(): Promise<void> {
    const submission = this.pending;
    this.pending = null;
    this.set({ confirmation: null });
    const provider = this.providers.selected();
    if (submission === null || provider === null) return;
    const blocker = this.sendBlocker();
    if (blocker !== null) {
      this.set({ notice: blocker });
      return;
    }
    await this.dispatch(provider, submission);
  }

  cancelConfirmation(): void {
    const declined = this.pending;
    this.pending = null;
    // Something the user typed is theirs to keep; an action's generated prompt is not.
    if (declined?.what === "your message" && declined.text !== "") {
      const typedSince = this.state.draft;
      this.set({
        confirmation: null,
        draft: typedSince === "" ? declined.text : `${declined.text}\n${typedSince}`,
      });
      return;
    }
    this.set({ confirmation: null });
  }

  setDraft(draft: string): void {
    this.set({ draft });
  }

  /** Sends what is typed in the message box (asking first for an online provider). */
  async sendDraft(): Promise<void> {
    const text = this.state.draft;
    if (text.trim() === "" || this.sendBlocker() !== null) return;
    this.set({ draft: "" });
    await this.submit({ text, what: "your message" });
  }

  private async dispatch(provider: AiProviderView, submission: Submission): Promise<void> {
    const now = this.now();
    const requestId = newRequestId("chat");
    const base = submission.resend ? this.withoutFailedTail() : this.state.messages;
    const messages: ChatMessageView[] = submission.resend
      ? base
      : [
          ...base,
          {
            id: messageId(),
            role: "user",
            content: submission.text,
            error: null,
            createdAt: now,
            streaming: false,
            stopped: false,
          },
        ];
    const title =
      this.state.messages.length === 0 && submission.title !== undefined
        ? submission.title
        : this.state.title === "New chat" && !submission.resend
          ? oneLine(submission.text, 60)
          : this.state.title;
    this.set({
      title,
      requestId,
      sending: true,
      notice: null,
      messages: [
        ...messages,
        {
          id: messageId(),
          role: "assistant",
          content: "",
          error: null,
          createdAt: now,
          streaming: true,
          stopped: false,
        },
      ],
    });
    const model = this.providers.modelOf(provider);
    const wire: AiChatMessage[] = messages
      .filter((m) => !(m.role === "assistant" && m.content === ""))
      .map((m) => ({ role: m.role, content: m.content }));
    try {
      const result = await this.ipc.aiChatSend(requestId, provider.id, {
        model,
        system: SYSTEM_PROMPT,
        messages: wire,
      });
      this.updateLast((m) => ({
        ...m,
        content: result.cancelled ? m.content : result.text,
        streaming: false,
        stopped: result.cancelled,
      }));
    } catch (error) {
      this.updateLast((m) => ({ ...m, streaming: false, error: String(error) }));
    }
    this.set({ sending: false, requestId: null });
    await this.persist(provider, model);
  }

  private withoutFailedTail(): ChatMessageView[] {
    const messages = [...this.state.messages];
    const last = messages[messages.length - 1];
    if (last?.role === "assistant" && (last.error !== null || last.stopped)) messages.pop();
    return messages;
  }

  /** Sends the conversation again after a failed or stopped answer. */
  async retry(): Promise<void> {
    await this.submit({ text: "", what: "the conversation so far", resend: true });
  }

  /** Stops the answer that is arriving. */
  async stop(): Promise<void> {
    const requestId = this.state.requestId;
    if (requestId === null) return;
    await this.ipc.aiRequestCancel(requestId).catch(() => undefined);
  }

  // --- The conversation -----------------------------------------------------------------------------------

  /** The estimated size of the conversation, in tokens. */
  estimatedTokens(): number {
    return estimateTokens(this.state.messages.map((m) => m.content).join(""));
  }

  contextWarning(): string | null {
    const tokens = this.estimatedTokens();
    return tokens > LONG_CONVERSATION_TOKENS
      ? `This conversation is long (about ${tokens.toLocaleString()} tokens); some models may refuse it. Start a new chat to shorten it.`
      : null;
  }

  newChat(): void {
    if (this.state.sending) return;
    this.pending = null;
    this.state = this.emptyState(this.state.history);
    this.set({});
  }

  /** Clears the messages of the open chat (and its saved copy). */
  async clear(): Promise<void> {
    if (this.state.sending) return;
    const id = this.state.conversationId;
    this.newChat();
    await this.ipc.aiConversationDelete(id).catch(() => undefined);
    await this.loadHistory();
  }

  private async persist(provider: AiProviderView, model: string): Promise<void> {
    if (!this.settings.bool("ai.saveConversationHistory", true)) return;
    const messages: AiStoredMessage[] = this.state.messages
      .filter((m) => !m.streaming)
      .slice(-MAX_SAVED_MESSAGES)
      .map((m) => ({
        role: m.role,
        content: m.content,
        error: m.error,
        createdAt: m.createdAt,
      }));
    const conversation: AiConversation = {
      id: this.state.conversationId,
      title: this.state.title,
      providerId: provider.id,
      model,
      createdAt: this.state.createdAt,
      updatedAt: this.now(),
      messages,
    };
    try {
      await this.ipc.aiConversationSave(conversation);
      await this.loadHistory();
    } catch (error) {
      this.events.emit("appError", {
        message: `The conversation could not be saved: ${String(error)}`,
      });
    }
  }

  // --- Saved conversations --------------------------------------------------------------------------------

  async loadHistory(): Promise<void> {
    try {
      this.set({ history: await this.ipc.aiConversationsList() });
    } catch (error) {
      this.set({ notice: `The saved conversations could not be read: ${String(error)}` });
    }
  }

  async open(id: string): Promise<void> {
    if (this.state.sending) return;
    const saved = await this.ipc.aiConversationLoad(id).catch(() => null);
    if (saved === null) {
      this.set({ notice: "That conversation could not be opened." });
      return;
    }
    this.pending = null;
    this.set({
      conversationId: saved.id,
      title: saved.title,
      createdAt: saved.createdAt,
      notice: null,
      confirmation: null,
      messages: saved.messages.map((m) => ({
        id: messageId(),
        role: m.role,
        content: m.content,
        error: m.error,
        createdAt: m.createdAt,
        streaming: false,
        stopped: false,
      })),
    });
  }

  async deleteConversation(id: string): Promise<void> {
    await this.ipc.aiConversationDelete(id).catch(() => undefined);
    if (id === this.state.conversationId) this.newChat();
    await this.loadHistory();
  }

  /** Deletes every saved conversation (the open one stays on screen until it is cleared). */
  async clearHistory(): Promise<void> {
    try {
      await this.ipc.aiConversationsClear();
      this.set({ history: [] });
    } catch (error) {
      this.set({ notice: `The history could not be cleared: ${String(error)}` });
    }
  }

  dismissNotice(): void {
    this.set({ notice: null });
  }

  /** A provider went away (disabled extension, turned off): stop what is in flight and drop a waiting confirmation. */
  onProvidersChanged(): void {
    if (!this.providers.panelVisible()) {
      void this.stop();
      this.pending = null;
      if (this.state.confirmation !== null) this.set({ confirmation: null });
    }
  }
}
