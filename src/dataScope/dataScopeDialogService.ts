import type { CommandRegistry } from "../services/commandRegistry";

/** Whether the Data Scope dialog is on screen. The choice itself lives in the backend (`data/data-scope.json`). */
export class DataScopeDialogService {
  private open = false;
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly isOpen = (): boolean => this.open;

  show(): void {
    this.set(true);
  }

  close(): void {
    this.set(false);
  }

  private set(open: boolean): void {
    if (this.open === open) return;
    this.open = open;
    for (const listener of this.listeners) listener();
  }
}

/** Registers File > Preferences > Data Scope... (`preferences.dataScope`). */
export function wireDataScope(commands: CommandRegistry): DataScopeDialogService {
  const dialog = new DataScopeDialogService();
  commands.register("preferences.dataScope", () => {
    dialog.show();
  });
  return dialog;
}
