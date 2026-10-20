import type { MenuEntry } from "../menus";

export interface ContextMenuRequest {
  /** Where the pointer was (client coordinates); the popup keeps itself inside the window. */
  x: number;
  y: number;
  /** Rebuilt on every redraw, so enabled states follow what becomes known while the menu is open. */
  entries: () => MenuEntry[];
  ariaLabel: string;
  /** Runs after the menu closed without a choice (focus goes back where it was). */
  onDismiss?: () => void;
}

/**
 * The one open context menu of the window (editor, tab, Explorer file). UI-free: the layer component draws it; other
 * services tell it to redraw when something a menu entry depends on changed (`refresh`).
 */
export class ContextMenuService {
  private request: ContextMenuRequest | null = null;
  /** A new object on every change (React compares snapshots by identity). */
  private state: { request: ContextMenuRequest | null; revision: number } = { request: null, revision: 0 };
  private readonly listeners = new Set<() => void>();

  getState(): { request: ContextMenuRequest | null; revision: number } {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    this.state = { request: this.request, revision: this.state.revision + 1 };
    for (const listener of this.listeners) listener();
  }

  open(request: ContextMenuRequest): void {
    this.request = request;
    this.notify();
  }

  isOpen(): boolean {
    return this.request !== null;
  }

  /** Closes the menu; `dismissed`: without a choice (Escape, a click outside). */
  close(dismissed = false): void {
    const request = this.request;
    if (request === null) return;
    this.request = null;
    this.notify();
    if (dismissed) request.onDismiss?.();
  }

  /** Redraws the open menu (an entry's state changed). */
  refresh(): void {
    if (this.request !== null) this.notify();
  }
}
