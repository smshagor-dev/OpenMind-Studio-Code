export type CommandHandler = (...args: unknown[]) => void | Promise<void>;

/**
 * Named, executable commands — the seam that lets keyboard shortcuts, menu
 * items, the command palette (future), and buttons all trigger the same
 * behavior without UI code calling service methods directly.
 */
export class CommandRegistry {
  private readonly commands = new Map<string, CommandHandler>();

  register(id: string, handler: CommandHandler): void {
    if (this.commands.has(id)) {
      throw new Error(`command "${id}" is already registered`);
    }
    this.commands.set(id, handler);
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

  async execute(id: string, ...args: unknown[]): Promise<void> {
    const handler = this.commands.get(id);
    if (!handler) {
      throw new Error(`command "${id}" is not registered`);
    }
    await handler(...args);
  }
}
