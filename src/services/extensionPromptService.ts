/** A message an extension shows (`showInformationMessage` and friends). */
export interface MessagePrompt {
  kind: "message";
  id: number;
  extension: string;
  severity: "info" | "warning" | "error";
  message: string;
  /** Buttons; without any the message goes away by itself. */
  items: string[];
}

export interface QuickPickPrompt {
  kind: "quickPick";
  id: number;
  extension: string;
  items: { label: string; description?: string; detail?: string }[];
  placeHolder: string | null;
  canPickMany: boolean;
}

export interface InputPrompt {
  kind: "input";
  id: number;
  extension: string;
  prompt: string | null;
  placeHolder: string | null;
  value: string;
  password: boolean;
  title: string | null;
}

export type ExtensionPrompt = MessagePrompt | QuickPickPrompt | InputPrompt;

export interface ExtensionPromptState {
  // Messages stack up; a quick pick or input box takes the whole attention, one at a time.
  messages: MessagePrompt[];
  dialog: QuickPickPrompt | InputPrompt | null;
}

/** A message without buttons disappears after this long. */
export const MESSAGE_LIFETIME_MS = 8000;

type Resolver = (value: unknown) => void;

/**
 * The questions extensions ask the user, as data for a UI to draw: the promise of each is answered when
 * the user clicks a button, picks or types (or dismisses: `null`). UI-free.
 */
export class ExtensionPromptService {
  private nextId = 1;
  private state: ExtensionPromptState = { messages: [], dialog: null };
  private queued: (QuickPickPrompt | InputPrompt)[] = [];
  private readonly resolvers = new Map<number, Resolver>();
  private readonly listeners = new Set<() => void>();

  getState(): ExtensionPromptState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Resolves with the clicked button's label, or `null` when it was dismissed (or had no buttons). */
  showMessage(request: Omit<MessagePrompt, "kind" | "id">): Promise<string | null> {
    const prompt: MessagePrompt = { kind: "message", id: this.nextId++, ...request };
    this.state = { ...this.state, messages: [...this.state.messages, prompt] };
    this.notify();
    if (request.items.length === 0) {
      setTimeout(() => {
        this.dismiss(prompt.id);
      }, MESSAGE_LIFETIME_MS);
      return Promise.resolve(null);
    }
    return this.wait<string | null>(prompt.id);
  }

  /** Resolves with the chosen index (or indexes with `canPickMany`), `null` when cancelled. */
  quickPick(request: Omit<QuickPickPrompt, "kind" | "id">): Promise<number | number[] | null> {
    const prompt: QuickPickPrompt = { kind: "quickPick", id: this.nextId++, ...request };
    return this.enqueue<number | number[] | null>(prompt);
  }

  inputBox(request: Omit<InputPrompt, "kind" | "id">): Promise<string | null> {
    const prompt: InputPrompt = { kind: "input", id: this.nextId++, ...request };
    return this.enqueue<string | null>(prompt);
  }

  /** The user's answer to a prompt (a button label, indexes, text). */
  answer(id: number, value: unknown): void {
    this.finish(id, value);
  }

  /** Closes a prompt without an answer. */
  dismiss(id: number): void {
    this.finish(id, null);
  }

  /** Every open prompt is answered `null` (the host went away). */
  dismissAll(): void {
    for (const id of [...this.resolvers.keys()]) this.finish(id, null);
    this.state = { messages: [], dialog: null };
    this.queued = [];
    this.notify();
  }

  private wait<T>(id: number): Promise<T> {
    return new Promise<T>((resolve) => {
      this.resolvers.set(id, resolve as Resolver);
    });
  }

  private enqueue<T>(prompt: QuickPickPrompt | InputPrompt): Promise<T> {
    const promise = this.wait<T>(prompt.id);
    if (this.state.dialog === null) {
      this.state = { ...this.state, dialog: prompt };
      this.notify();
    } else {
      this.queued.push(prompt);
    }
    return promise;
  }

  private finish(id: number, value: unknown): void {
    this.resolvers.get(id)?.(value);
    this.resolvers.delete(id);
    const messages = this.state.messages.filter((message) => message.id !== id);
    let dialog = this.state.dialog;
    if (dialog?.id === id) dialog = this.queued.shift() ?? null;
    else this.queued = this.queued.filter((prompt) => prompt.id !== id);
    this.state = { messages, dialog };
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
