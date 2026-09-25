/** An item an extension put in the status bar. */
export interface StatusBarItemView {
  id: string;
  extension: string;
  alignment: "left" | "right";
  priority: number;
  /** Plain text (never HTML); $(icon) markers are removed. */
  text: string;
  tooltip: string;
  command: { command: string; args: unknown[] } | null;
  /** A theme colour id from COLOR_TOKENS, or null. */
  color: string | null;
  background: string | null;
}

export interface StatusBarItemsDeps {
  /** Runs a command an item asked for (a registered app or extension command). */
  runCommand: (command: string, args: unknown[]) => Promise<unknown>;
  /** Whether the command exists; an item with an unknown command says so when clicked. */
  hasCommand: (command: string) => boolean;
  onError: (message: string) => void;
}

/** The theme colours an item may ask for, and the token each maps to (nothing else ever becomes CSS). */
export const COLOR_TOKENS: Record<string, string> = {
  "statusBarItem.errorBackground": "var(--error-border)",
  "statusBarItem.warningBackground": "var(--warning-bg)",
  errorForeground: "var(--error-fg)",
  "editorError.foreground": "var(--error-fg)",
  "editorWarning.foreground": "var(--warning-fg)",
  "editorInfo.foreground": "var(--info-fg)",
};

/** The text as shown: plain, with the "$(icon)" markers of VS Code removed. */
export function displayText(text: string): string {
  return text.replace(/\$\([a-z0-9-]+(?:~[a-z]+)?\)\s*/gi, "").trim();
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * The status bar items extensions created. An item belongs to one extension (its id starts with the
 * extension id); an update naming another extension, an unknown or a disposed item is ignored. Items are
 * shown only while their extension is enabled and the host that made them runs. UI-free.
 */
export class StatusBarItemsService {
  private readonly items = new Map<string, StatusBarItemView>();
  private readonly shown = new Set<string>();
  /** Ids that were disposed: a late update for one must not bring it back. */
  private readonly disposed = new Set<string>();
  private snapshot: StatusBarItemView[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: StatusBarItemsDeps) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The visible items, left to right: a higher priority is further left, ties keep creation order. */
  getItems(): StatusBarItemView[] {
    return this.snapshot;
  }

  itemsOf(alignment: "left" | "right"): StatusBarItemView[] {
    return this.snapshot.filter((item) => item.alignment === alignment);
  }

  /** The host's `statusBar/*` notifications, and `statusBar/reset` when the host went away. */
  handleEvent(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case "statusBar/set":
        this.set(params);
        return;
      case "statusBar/dispose":
        this.dispose(str(params.id), str(params.extension));
        return;
      case "statusBar/reset":
        this.reset();
        return;
    }
  }

  /** Extensions that are gone or disabled lose their items. */
  keepOnly(enabledExtensions: ReadonlySet<string>): void {
    let changed = false;
    for (const [id, item] of [...this.items]) {
      if (!enabledExtensions.has(item.extension)) {
        this.items.delete(id);
        this.shown.delete(id);
        changed = true;
      }
    }
    if (changed) this.publish();
  }

  reset(): void {
    // A new host starts its ids from scratch, so what was remembered as disposed no longer applies.
    this.disposed.clear();
    if (this.items.size === 0) return;
    this.items.clear();
    this.shown.clear();
    this.publish();
  }

  /** A click: runs the item's command, or says why it can't. */
  click(id: string): void {
    const item = this.items.get(id);
    if (!item?.command) return;
    const { command, args } = item.command;
    if (!this.deps.hasCommand(command)) {
      this.deps.onError(
        `The status bar item of ${item.extension} runs '${command}', which isn't a registered command.`,
      );
      return;
    }
    this.deps.runCommand(command, args).catch((error: unknown) => {
      this.deps.onError(
        `'${command}' failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  private set(params: Record<string, unknown>): void {
    const id = str(params.id);
    const extension = str(params.extension);
    if (id === "" || extension === "" || !id.startsWith(`${extension}#`)) return;
    if (this.disposed.has(id)) return;
    const command = record(params.command);
    const known = (value: unknown): string | null =>
      typeof value === "string" && value in COLOR_TOKENS ? value : null;
    this.items.set(id, {
      id,
      extension,
      alignment: params.alignment === "right" ? "right" : "left",
      priority: typeof params.priority === "number" ? params.priority : 0,
      text: displayText(str(params.text)),
      tooltip: str(params.tooltip),
      command:
        typeof command.command === "string"
          ? { command: command.command, args: Array.isArray(command.args) ? command.args : [] }
          : null,
      color: known(params.color),
      background: known(params.background),
    });
    if (params.visible === true) this.shown.add(id);
    else this.shown.delete(id);
    this.publish();
  }

  private dispose(id: string, extension: string): void {
    const item = this.items.get(id);
    if (!item || item.extension !== extension) return;
    this.items.delete(id);
    this.shown.delete(id);
    this.disposed.add(id);
    this.publish();
  }

  private publish(): void {
    const visible: StatusBarItemView[] = [];
    for (const [id, item] of this.items) if (this.shown.has(id)) visible.push(item);
    // Array.prototype.sort is stable: equal priorities keep the order the items were created in.
    this.snapshot = visible.sort((a, b) => b.priority - a.priority);
    for (const listener of this.listeners) listener();
  }
}
