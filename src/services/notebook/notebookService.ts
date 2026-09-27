import type { ConfirmPrompt, QuickPickPrompt } from "../extensionPromptService";
import type { IpcClient } from "../ipc";
import type { KernelCandidate, NotebookCellEdit, NotebookCellKind } from "../workflowIpc";
import { runBlocker } from "./notebookModel";

export interface CellState {
  /** A key that stays while cells move. */
  key: string;
  /** Its index in the file it was read from (`null` for a new cell): the cell keeps its metadata on save. */
  origin: number | null;
  kind: NotebookCellKind;
  source: string;
  executionCount: number | null;
  outputs: Record<string, unknown>[];
}

export interface NotebookDoc {
  path: string;
  status: "loading" | "ready" | "error";
  error: string | null;
  fingerprint: string;
  trusted: boolean;
  language: string;
  kernelName: string | null;
  cells: CellState[];
  dirty: boolean;
  /** The kernel the user picked (a label), while it runs. */
  kernel: string | null;
  /** The cell that is running. */
  running: string | null;
  /** The last save found the file changed on disk: saving again overwrites it. */
  conflict: boolean;
}

export interface NotebookDeps {
  ipc: Pick<
    IpcClient,
    | "notebookOpen"
    | "notebookSave"
    | "notebookSetTrust"
    | "notebookKernels"
    | "notebookKernelStart"
    | "notebookKernelStop"
    | "notebookExecute"
  >;
  confirm: (request: Omit<ConfirmPrompt, "kind" | "id">) => Promise<string | null>;
  quickPick: (request: Omit<QuickPickPrompt, "kind" | "id">) => Promise<number | number[] | null>;
  notice: (message: string) => void;
  log: (line: string) => void;
  /** `files.autoSave` and `files.autoSaveDelay`. */
  autoSave: () => { mode: string; delay: number };
}

export const TRUST = "Trust Notebook";
export const RUN_ALL = "Run All Cells";

/**
 * Open notebooks (Milestone 19): cells, edits, save, trust and the kernel. Opening reads the file and nothing else —
 * no cell runs and no kernel starts. A cell runs only on the user's action, in a notebook the user trusted, on a
 * kernel the user picked; Run All asks first. UI-free.
 */
export class NotebookService {
  private docs = new Map<string, NotebookDoc>();
  private readonly listeners = new Set<() => void>();
  private next = 0;
  private saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: NotebookDeps) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get(path: string): NotebookDoc | undefined {
    return this.docs.get(key(path));
  }

  private key(): string {
    this.next += 1;
    return `cell-${String(this.next)}`;
  }

  private put(path: string, patch: Partial<NotebookDoc>): void {
    const current = this.get(path);
    if (!current) return;
    this.docs = new Map(this.docs).set(key(path), { ...current, ...patch });
    for (const listener of this.listeners) listener();
  }

  /** Reads the notebook (again). Nothing runs. */
  async open(path: string, force = false): Promise<void> {
    if (this.get(path) && !force) return;
    const loading: NotebookDoc = {
      path,
      status: "loading",
      error: null,
      fingerprint: "",
      trusted: false,
      language: "python",
      kernelName: null,
      cells: [],
      dirty: false,
      kernel: null,
      running: null,
      conflict: false,
    };
    this.docs = new Map(this.docs).set(key(path), this.get(path) ?? loading);
    this.put(path, { status: "loading", error: null });
    try {
      const opened = await this.deps.ipc.notebookOpen(path);
      this.put(path, {
        status: "ready",
        fingerprint: opened.fingerprint,
        trusted: opened.trusted,
        language: opened.model.language,
        kernelName: opened.model.kernelName,
        kernel: opened.kernel,
        dirty: false,
        conflict: false,
        cells: opened.model.cells.map((cell) => ({
          key: this.key(),
          origin: cell.index,
          kind: cell.kind,
          source: cell.source,
          executionCount: cell.executionCount,
          outputs: cell.outputs,
        })),
      });
    } catch (error) {
      this.put(path, { status: "error", error: String(error).replace(/^Error: /, "") });
    }
  }

  // --- Editing ---

  private edit(path: string, cells: CellState[]): void {
    this.put(path, { cells, dirty: true });
    this.scheduleAutoSave(path);
  }

  setSource(path: string, cellKey: string, source: string): void {
    const doc = this.get(path);
    if (!doc) return;
    const cell = doc.cells.find((c) => c.key === cellKey);
    if (!cell || cell.source === source) return;
    this.edit(
      path,
      doc.cells.map((c) => (c.key === cellKey ? { ...c, source } : c)),
    );
  }

  setKind(path: string, cellKey: string, kind: NotebookCellKind): void {
    const doc = this.get(path);
    if (!doc) return;
    this.edit(
      path,
      doc.cells.map((c) =>
        c.key === cellKey
          ? {
              ...c,
              kind,
              outputs: kind === "code" ? c.outputs : [],
              executionCount: kind === "code" ? c.executionCount : null,
            }
          : c,
      ),
    );
  }

  /** Adds an empty cell after `afterKey` (or at the end). Returns its key. */
  addCell(path: string, afterKey: string | null, kind: NotebookCellKind): string | null {
    const doc = this.get(path);
    if (!doc) return null;
    const cell: CellState = {
      key: this.key(),
      origin: null,
      kind,
      source: "",
      executionCount: null,
      outputs: [],
    };
    const at =
      afterKey === null ? doc.cells.length : doc.cells.findIndex((c) => c.key === afterKey) + 1;
    const cells = [...doc.cells];
    cells.splice(at <= 0 ? cells.length : at, 0, cell);
    this.edit(path, cells);
    return cell.key;
  }

  deleteCell(path: string, cellKey: string): void {
    const doc = this.get(path);
    if (!doc) return;
    this.edit(
      path,
      doc.cells.filter((c) => c.key !== cellKey),
    );
  }

  moveCell(path: string, cellKey: string, by: -1 | 1): void {
    const doc = this.get(path);
    if (!doc) return;
    const index = doc.cells.findIndex((c) => c.key === cellKey);
    const target = index + by;
    if (index < 0 || target < 0 || target >= doc.cells.length) return;
    const cells = [...doc.cells];
    const [cell] = cells.splice(index, 1);
    if (cell) cells.splice(target, 0, cell);
    this.edit(path, cells);
  }

  clearOutputs(path: string): void {
    const doc = this.get(path);
    if (!doc) return;
    this.edit(
      path,
      doc.cells.map((c) => ({ ...c, outputs: [], executionCount: null })),
    );
  }

  // --- Save ---

  private scheduleAutoSave(path: string): void {
    const { mode, delay } = this.deps.autoSave();
    if (mode !== "afterDelay") return;
    const old = this.saveTimers.get(path);
    if (old !== undefined) clearTimeout(old);
    this.saveTimers.set(
      path,
      setTimeout(
        () => {
          this.saveTimers.delete(path);
          void this.save(path);
        },
        Math.max(200, delay),
      ),
    );
  }

  /** The window lost focus: notebooks save when Auto Save is onFocusChange/onWindowChange. */
  windowBlurred(): void {
    const { mode } = this.deps.autoSave();
    if (mode !== "onFocusChange" && mode !== "onWindowChange") return;
    for (const doc of this.docs.values()) if (doc.dirty && !doc.conflict) void this.save(doc.path);
  }

  /** Saves the cells into the file (everything else in it is kept). `overwrite` after a conflict. */
  async save(path: string, overwrite = false): Promise<boolean> {
    const doc = this.get(path);
    if (doc?.status !== "ready") return false;
    const edits: NotebookCellEdit[] = doc.cells.map((cell) => ({
      origin: cell.origin,
      kind: cell.kind,
      source: cell.source,
      executionCount: cell.executionCount,
      outputs: cell.outputs,
    }));
    try {
      const saved = await this.deps.ipc.notebookSave(path, edits, doc.fingerprint, overwrite);
      this.put(path, { fingerprint: saved.fingerprint, dirty: false, conflict: false });
      this.deps.log(`Saved ${path}`);
      return true;
    } catch (error) {
      const message = String(error).replace(/^Error: /, "");
      this.put(path, { conflict: message.includes("changed on disk") });
      this.deps.notice(message);
      return false;
    }
  }

  // --- Trust and kernel ---

  async setTrusted(path: string, trusted: boolean): Promise<void> {
    if (!this.get(path)) return;
    if (trusted && this.get(path)?.dirty) {
      // Trust is for the file's content: save first so the trusted content is what is shown.
      if (!(await this.save(path))) return;
    }
    try {
      await this.deps.ipc.notebookSetTrust(path, trusted);
      this.put(path, { trusted, ...(trusted ? {} : { kernel: null }) });
    } catch (error) {
      this.deps.notice(String(error).replace(/^Error: /, ""));
    }
  }

  async kernels(): Promise<KernelCandidate[]> {
    return this.deps.ipc.notebookKernels().catch(() => []);
  }

  /** Select Kernel: the user picks one of the Pythons found; OpenMind's runner starts with it. */
  async selectKernel(path: string): Promise<void> {
    const candidates = await this.kernels();
    if (candidates.length === 0) {
      this.deps.notice(
        "Kernel not configured. Install/configure Python from Runtime Manager (nothing is downloaded automatically).",
      );
      return;
    }
    const picked = await this.deps.quickPick({
      extension: "OpenMind Studio",
      placeHolder:
        "Select a Python to run this notebook's cells (OpenMind's Python runner, not Jupyter)",
      canPickMany: false,
      items: candidates.map((c) => ({
        label: c.label,
        description: c.hasIpykernel ? "ipykernel installed (not used by OpenMind's runner)" : "",
        detail: c.interpreter,
      })),
    });
    const candidate = typeof picked === "number" ? candidates[picked] : undefined;
    if (!candidate) return;
    try {
      const label = await this.deps.ipc.notebookKernelStart(path, candidate.interpreter);
      this.put(path, { kernel: label });
      this.deps.log(`Kernel for ${path}: ${label} (${candidate.interpreter})`);
    } catch (error) {
      this.deps.notice(String(error).replace(/^Error: /, ""));
    }
  }

  /** Stops the kernel (a running cell ends; the variables are lost). */
  async stopKernel(path: string): Promise<void> {
    await this.deps.ipc.notebookKernelStop(path).catch(() => undefined);
    this.put(path, { kernel: null });
  }

  // --- Running ---

  /** Why the cell can't run now, or null. */
  runReason(path: string, cellKey: string): string | null {
    const doc = this.get(path);
    const cell = doc?.cells.find((c) => c.key === cellKey);
    if (!doc || !cell) return "The cell is gone.";
    return runBlocker({
      trusted: doc.trusted,
      kernel: doc.kernel !== null,
      language: doc.language,
      cellKind: cell.kind,
      running: doc.running !== null,
    });
  }

  async runCell(path: string, cellKey: string): Promise<boolean> {
    const reason = this.runReason(path, cellKey);
    const doc = this.get(path);
    if (reason !== null || !doc) {
      if (reason) this.deps.notice(reason);
      return false;
    }
    const index = doc.cells.findIndex((c) => c.key === cellKey);
    const source = doc.cells[index]?.source ?? "";
    this.put(path, { running: cellKey });
    let ok = false;
    let outputs: Record<string, unknown>[];
    let executionCount: number | null = null;
    try {
      const result = await this.deps.ipc.notebookExecute(path, index, source, doc.fingerprint);
      ok = result.ok;
      outputs = result.outputs;
      executionCount = result.executionCount;
    } catch (error) {
      const message = String(error).replace(/^Error: /, "");
      outputs = [{ output_type: "error", ename: "OpenMind", evalue: message, traceback: [] }];
      if (message.includes("stopped") || message.includes("not running"))
        this.put(path, { kernel: null });
    }
    const latest = this.get(path);
    if (latest) {
      this.put(path, {
        running: null,
        dirty: true,
        cells: latest.cells.map((c) => (c.key === cellKey ? { ...c, outputs, executionCount } : c)),
      });
      this.scheduleAutoSave(path);
    }
    return ok;
  }

  /** Runs every code cell in order after the user confirmed; stops at the first one that fails. */
  async runAll(path: string): Promise<void> {
    const doc = this.get(path);
    if (!doc) return;
    const code = doc.cells.filter((c) => c.kind === "code");
    const first = code[0];
    const reason = first ? this.runReason(path, first.key) : "There are no code cells.";
    if (reason !== null) {
      this.deps.notice(reason);
      return;
    }
    const answer = await this.deps.confirm({
      extension: "OpenMind Studio",
      title: `Run all ${String(code.length)} code cells?`,
      details: [
        { label: "Notebook", value: path },
        { label: "Kernel", value: doc.kernel ?? "" },
      ],
      notes: [
        "The cells run one after another with your rights, on this computer. It stops at the first cell that fails.",
      ],
      buttons: [RUN_ALL],
    });
    if (answer !== RUN_ALL) return;
    for (const cell of code) {
      if (!(await this.runCell(path, cell.key))) break;
    }
  }

  /** The notebook's tab closed: its kernel stops and its state is dropped. */
  async close(path: string): Promise<void> {
    if (!this.get(path)) return;
    const timer = this.saveTimers.get(path);
    if (timer !== undefined) clearTimeout(timer);
    await this.deps.ipc.notebookKernelStop(path).catch(() => undefined);
    const docs = new Map(this.docs);
    docs.delete(key(path));
    this.docs = docs;
    for (const listener of this.listeners) listener();
  }
}

function key(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}
