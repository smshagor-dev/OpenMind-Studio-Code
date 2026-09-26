/** Which AI dialog is open (the provider manager). Transient UI state, not persisted. */
export interface AiUiState {
  managerOpen: boolean;
  /** The provider being edited in the manager: an id, `"new"` for the add form, or null for the list. */
  editing: string | null;
}

export class AiUiService {
  private state: AiUiState = { managerOpen: false, editing: null };
  private readonly listeners = new Set<() => void>();

  getState(): AiUiState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  openManager(editing: string | null = null): void {
    this.set({ managerOpen: true, editing });
  }

  closeManager(): void {
    this.set({ managerOpen: false, editing: null });
  }

  edit(editing: string | null): void {
    this.set({ ...this.state, editing });
  }

  private set(state: AiUiState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}
