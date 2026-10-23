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

/**
 * A question the app asks on an extension's behalf before something consequential happens (a command line in a
 * terminal, a task). Drawn as a modal: it is only answered by a button (or Escape = cancel), never by a stray click.
 */
export interface ConfirmPrompt {
  kind: "confirm";
  id: number;
  extension: string;
  title: string;
  /** What will happen, as labelled lines (Command, Folder, Environment ...). */
  details: { label: string; value: string }[];
  notes: string[];
  /** The buttons besides Cancel; the answer is the chosen label (`null` = cancelled). */
  buttons: string[];
}

export type ExtensionPrompt = MessagePrompt | QuickPickPrompt | InputPrompt | ConfirmPrompt;

export interface DynamicQuickInput {
  id: string; extension: string; kind: "quickPick" | "input"; visible: boolean;
  title?: string; placeholder?: string; prompt?: string; value: string; enabled: boolean; busy: boolean;
  password?: boolean; ignoreFocusOut?: boolean; canSelectMany?: boolean; matchOnDescription?: boolean; matchOnDetail?: boolean;
  step?: number; totalSteps?: number; valueSelection?: [number, number];
  validationMessage?: string | { message: string; severity: number };
  buttons: { id: string; tooltip?: string; back?: boolean }[];
  items: { id: string; label: string; description?: string; detail?: string; kind?: number; alwaysShow?: boolean; buttons: { id: string; tooltip?: string }[] }[];
  selectedItems: string[]; activeItems: string[];
}

export interface ExtensionPromptState {
  // Messages stack up; a quick pick or input box takes the whole attention, one at a time.
  dynamic?: DynamicQuickInput;
  messages: MessagePrompt[];
  dialog: QuickPickPrompt | InputPrompt | ConfirmPrompt | null;
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
  private dynamicEvent: ((params: Record<string, unknown>) => void) | null = null;
  private state: ExtensionPromptState = { messages: [], dialog: null };
  private queued: (QuickPickPrompt | InputPrompt | ConfirmPrompt)[] = [];
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

  setQuickInput(prompt: DynamicQuickInput, event: (params: Record<string, unknown>) => void): void {
    if (!prompt.visible) {
      if (this.state.dynamic?.id === prompt.id) { this.state = { ...this.state, dynamic: undefined }; this.dynamicEvent = null; this.notify(); }
      return;
    }
    if (this.state.dynamic && this.state.dynamic.id !== prompt.id) this.quickInputEvent("hide");
    this.dynamicEvent = event; this.state = { ...this.state, dynamic: prompt }; this.notify();
  }

  quickInputEvent(event: string, params: Record<string, unknown> = {}): void {
    const current = this.state.dynamic;
    if (!current) return;
    const callback = this.dynamicEvent;
    if (event === "hide") { this.state = { ...this.state, dynamic: undefined }; this.dynamicEvent = null; }
    else if (event === "value" && typeof params.value === "string") this.state = { ...this.state, dynamic: { ...current, value: params.value } };
    else if ((event === "selection" || event === "active") && Array.isArray(params.items)) this.state = { ...this.state, dynamic: { ...current, [event === "selection" ? "selectedItems" : "activeItems"]: params.items.filter((item): item is string => typeof item === "string") } };
    this.notify(); callback?.({ id: current.id, event, ...params });
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

  /** Resolves with the chosen button's label, or `null` when the user cancelled. */
  confirm(request: Omit<ConfirmPrompt, "kind" | "id">): Promise<string | null> {
    const prompt: ConfirmPrompt = { kind: "confirm", id: this.nextId++, ...request };
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
    this.dynamicEvent = null;
    this.queued = [];
    this.notify();
  }

  private wait<T>(id: number): Promise<T> {
    return new Promise<T>((resolve) => {
      this.resolvers.set(id, resolve as Resolver);
    });
  }

  private enqueue<T>(prompt: QuickPickPrompt | InputPrompt | ConfirmPrompt): Promise<T> {
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
    this.state = { ...this.state, messages, dialog };
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

