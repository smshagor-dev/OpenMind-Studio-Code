export type SearchTab = "text" | "files" | "symbols" | "references";

export interface SearchPanelState {
  tab: SearchTab;
}

/** Which section of the Search side bar is showing (Text, Files, Symbols, References). UI-free. */
export class SearchPanelService {
  private state: SearchPanelState = { tab: "text" };
  private readonly listeners = new Set<() => void>();

  getState(): SearchPanelState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setTab(tab: SearchTab): void {
    if (tab === this.state.tab) return;
    this.state = { tab };
    for (const listener of this.listeners) listener();
  }
}
