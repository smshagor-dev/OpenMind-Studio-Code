import * as monaco from "monaco-editor";

export interface ProblemCounts {
  errors: number;
  warnings: number;
}

const NONE: ProblemCounts = { errors: 0, warnings: 0 };

/** Error/warning totals across every open model's Monaco markers — the status bar's problems item. */
export class MarkerService {
  private counts: ProblemCounts = NONE;
  private readonly listeners = new Set<() => void>();
  private subscription: monaco.IDisposable | null = null;

  getCounts(): ProblemCounts {
    return this.counts;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    this.subscription ??= monaco.editor.onDidChangeMarkers(() => {
      this.recount();
    });
    this.recount();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.subscription?.dispose();
        this.subscription = null;
      }
    };
  }

  private recount(): void {
    let errors = 0;
    let warnings = 0;
    for (const marker of monaco.editor.getModelMarkers({})) {
      if (marker.severity === monaco.MarkerSeverity.Error) errors += 1;
      else if (marker.severity === monaco.MarkerSeverity.Warning) warnings += 1;
    }
    if (errors === this.counts.errors && warnings === this.counts.warnings) {
      return;
    }
    this.counts = { errors, warnings };
    for (const listener of this.listeners) listener();
  }
}
