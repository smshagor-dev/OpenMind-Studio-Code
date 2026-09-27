import * as monaco from "monaco-editor";

export interface ProblemCounts {
  errors: number;
  warnings: number;
}

export type ProblemSeverity = "error" | "warning" | "info" | "hint";

export interface Problem {
  severity: ProblemSeverity;
  message: string;
  /** Who reported it (a language service, a linter), if it says. */
  source: string | null;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

/** Everything reported against one open document. */
export interface ProblemFile {
  /** The Monaco model URI — the stable key for this document's problems. */
  uri: string;
  title: string;
  path: string | null;
  problems: Problem[];
}

/** Maps a model URI to the document it belongs to (set by the composition root). */
export type ResourceResolver = (uri: string) => { title: string; path: string | null } | null;

const NONE: ProblemCounts = { errors: 0, warnings: 0 };

const SEVERITY: Record<number, ProblemSeverity> = {
  [monaco.MarkerSeverity.Error]: "error",
  [monaco.MarkerSeverity.Warning]: "warning",
  [monaco.MarkerSeverity.Info]: "info",
  [monaco.MarkerSeverity.Hint]: "hint",
};

const SEVERITY_ORDER: Record<ProblemSeverity, number> = { error: 0, warning: 1, info: 2, hint: 3 };

/**
 * Diagnostics from every open model's Monaco markers: the status bar's
 * error/warning totals and the Problems panel's per-file list. Markers are the
 * real thing — whatever Monaco's own language services (or, later, LSP) report —
 * so with nothing to report the panel honestly shows no problems.
 */
export class MarkerService {
  private counts: ProblemCounts = NONE;
  private files: readonly ProblemFile[] = [];
  private signature = "";
  private resolver: ResourceResolver = () => null;
  private readonly listeners = new Set<() => void>();
  private subscription: monaco.IDisposable | null = null;
  /** Problems that don't come from Monaco markers (a task's problem matchers), by owner. */
  private readonly external = new Map<string, ProblemFile[]>();

  getCounts(): ProblemCounts {
    return this.counts;
  }

  /** Problems grouped by document, files with errors first. */
  getProblemFiles(): readonly ProblemFile[] {
    return this.files;
  }

  /** Replaces an owner's problems for files that may not be open (`[]` clears them). */
  setExternal(owner: string, files: { path: string; title: string; problems: Problem[] }[]): void {
    if (files.length === 0) this.external.delete(owner);
    else
      this.external.set(
        owner,
        files.map((file) => ({
          uri: `external:${owner}:${file.path}`,
          title: file.title,
          path: file.path,
          problems: file.problems,
        })),
      );
    this.recount();
  }

  setResourceResolver(resolver: ResourceResolver): void {
    this.resolver = resolver;
    this.recount();
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
    const byFile = new Map<string, ProblemFile>();
    let errors = 0;
    let warnings = 0;
    for (const marker of monaco.editor.getModelMarkers({})) {
      const severity = SEVERITY[marker.severity] ?? "info";
      if (severity === "error") errors += 1;
      else if (severity === "warning") warnings += 1;
      const uri = marker.resource.toString();
      let file = byFile.get(uri);
      if (!file) {
        const described = this.resolver(uri);
        file = {
          uri,
          title: described?.title ?? marker.resource.path.split("/").pop() ?? uri,
          path: described?.path ?? null,
          problems: [],
        };
        byFile.set(uri, file);
      }
      file.problems.push({
        severity,
        message: marker.message,
        source: marker.source ?? null,
        line: marker.startLineNumber,
        column: marker.startColumn,
        endLine: marker.endLineNumber,
        endColumn: marker.endColumn,
      });
    }
    for (const file of [...this.external.values()].flat()) {
      for (const problem of file.problems) {
        if (problem.severity === "error") errors += 1;
        else if (problem.severity === "warning") warnings += 1;
      }
      byFile.set(file.uri, { ...file, problems: [...file.problems] });
    }
    const files = [...byFile.values()].map((file) => ({
      ...file,
      problems: file.problems.sort(
        (a, b) =>
          SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
          a.line - b.line ||
          a.column - b.column,
      ),
    }));
    files.sort(
      (a, b) =>
        SEVERITY_ORDER[a.problems[0]?.severity ?? "hint"] -
          SEVERITY_ORDER[b.problems[0]?.severity ?? "hint"] || a.title.localeCompare(b.title),
    );
    const signature = JSON.stringify(files);
    if (signature === this.signature) {
      return;
    }
    this.signature = signature;
    this.files = files;
    this.counts = errors === 0 && warnings === 0 ? NONE : { errors, warnings };
    for (const listener of this.listeners) listener();
  }
}
