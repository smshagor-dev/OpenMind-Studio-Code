export type CommandHandler = (...args: unknown[]) => void | Promise<void>;

export interface CommandOptions {
  /** Evaluated whenever a menu/button needs to know whether the command can run right now. */
  enabled?: () => boolean;
  /** Why the command is disabled right now (shown in menus so nothing is disabled without a reason). */
  disabledReason?: () => string | undefined;
  /** For toggle commands (e.g. "Word Wrap"): whether the toggle is currently on — menus render a check mark. */
  checked?: () => boolean;
}

interface CommandEntry {
  handler: CommandHandler;
  options: CommandOptions;
}

/**
 * Named, executable commands — the seam that lets keyboard shortcuts, menu
 * items, the command palette, and buttons all trigger the same behavior
 * without UI code calling service methods directly.
 *
 * A command id that was never registered (e.g. `terminal.new` before the
 * terminal milestone lands) simply reports as disabled — menus can list the
 * full VS Code-style structure up front and each entry lights up the moment
 * its owning feature registers the command, with no stub handlers.
 */
export class CommandRegistry {
  private readonly commands = new Map<string, CommandEntry>();
  private readonly listeners = new Set<() => void>();

  register(id: string, handler: CommandHandler, options: CommandOptions = {}): void {
    if (this.commands.has(id)) {
      throw new Error(`command "${id}" is already registered`);
    }
    this.commands.set(id, { handler, options });
  }

  unregister(id: string): void {
    this.commands.delete(id);
  }

  has(id: string): boolean {
    return this.commands.has(id);
  }

  list(): string[] {
    return [...this.commands.keys()];
  }

  isEnabled(id: string): boolean {
    const entry = this.commands.get(id);
    if (!entry) {
      return false;
    }
    // A menu asks this while it draws: a predicate that throws must not take the whole window down.
    try {
      return entry.options.enabled?.() ?? true;
    } catch {
      return false;
    }
  }

  /** Why a disabled command is disabled, when its owner says. */
  reasonFor(id: string): string | undefined {
    const entry = this.commands.get(id);
    if (!entry || this.isEnabled(id)) return undefined;
    return entry.options.disabledReason?.();
  }

  /** `undefined` for commands that aren't toggles; `true`/`false` for toggles. */
  isChecked(id: string): boolean | undefined {
    return this.commands.get(id)?.options.checked?.();
  }

  /** Notified after every executed command, so UI showing enabled/checked state can re-render. */
  onDidExecute(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async execute(id: string, ...args: unknown[]): Promise<void> {
    const entry = this.commands.get(id);
    if (!entry) {
      throw new Error(`command "${id}" is not registered`);
    }
    try {
      await entry.handler(...args);
    } finally {
      for (const listener of this.listeners) {
        listener();
      }
    }
  }
}
