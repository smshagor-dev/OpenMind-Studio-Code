export type ExtensionDomain = "tests" | "scm" | "notebooks" | "debug";
export interface TestNode { id: string; label: string; uri?: string; children: TestNode[] }
export interface TestSnapshot {
  controllers: { handle: string; label: string; items: TestNode[]; profiles: { id: string; label: string; kind: number }[] }[];
  runs: { id: string; name: string; ended: boolean; output: string; results: { id: string; label: string; status: string; messages: { message: string }[] }[] }[];
}
export interface ScmSnapshot {
  providers: { handle: string; label: string; input: { value: string; placeholder: string; enabled: boolean }; canAccept: boolean;
    groups: { id: string; label: string; resources: { index: number; uri: string; tooltip?: string; hasCommand: boolean }[] }[] }[];
}
export interface NotebookSnapshot {
  serializers: string[];
  controllers: { handle: string; label: string; notebookType: string }[];
  documents: { uri: string; notebookType: string; dirty: boolean; version: number; unavailable?: boolean;
    cells: { index: number; value: string; languageId: string; kind: number; running: boolean; outputs: { mime: string; text: string }[] }[] }[];
}
export interface DebugSnapshot {
  types: string[];
  sessions: { id: string; name: string; state: string; type: string; threadId?: number; output: string[] }[];
}
export interface WorkbenchSnapshot { tests: TestSnapshot; scm: ScmSnapshot; notebooks: NotebookSnapshot; debug: DebugSnapshot }
export interface WorkbenchState { visible: boolean; domain: ExtensionDomain; error: string | null; pending: number; snapshot: WorkbenchSnapshot; trusted: boolean; folders: string[] }
const empty = (): WorkbenchSnapshot => ({ tests: { controllers: [], runs: [] }, scm: { providers: [] }, notebooks: { serializers: [], controllers: [], documents: [] }, debug: { types: [], sessions: [] } });

export class ExtensionWorkbenchService {
  private state: WorkbenchState = { visible: false, domain: "tests", error: null, pending: 0, snapshot: empty(), trusted: false, folders: [] };
  private readonly listeners = new Set<() => void>();
  private request: ((params: Record<string, unknown>) => Promise<unknown>) | null = null;
  private generation = 0;
  private readonly revisions: Record<ExtensionDomain, number> = { tests: 0, scm: 0, notebooks: 0, debug: 0 };
  private readonly notebookEdits = new Map<string, Set<Promise<unknown>>>();
  private readonly notebookEditErrors = new Map<string, string>();
  connect(request: (params: Record<string, unknown>) => Promise<unknown>): void { this.request = request; }
  getState = (): WorkbenchState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private update(value: Partial<WorkbenchState>): void { this.state = { ...this.state, ...value }; for (const listener of this.listeners) listener(); }
  private retainNotebookRecovery(domain: ExtensionDomain, value: unknown): unknown {
    if (domain !== "notebooks" || !value || typeof value !== "object") return value;
    const incoming = value as NotebookSnapshot;
    if (!Array.isArray(incoming.documents)) return value;
    const recovered = this.state.snapshot.notebooks.documents.filter(document => document.dirty && document.unavailable);
    return { ...incoming, documents: [...incoming.documents, ...recovered.filter(document => !incoming.documents.some(next => next.uri === document.uri))] };
  }
  hide(): void { this.update({ visible: false }); }
  async show(domain: ExtensionDomain = this.state.domain): Promise<void> {
    this.update({ visible: true, domain }); await this.act(domain, "snapshot");
  }
  handle(method: string, value: Record<string, unknown>): void {
    if (method === "workbench/reset") {
      this.generation++;
      this.notebookEdits.clear();
      this.notebookEditErrors.clear();
      const retained = this.state.snapshot.notebooks.documents.filter(document => document.dirty).map(document => ({ ...document, unavailable: true }));
      this.update({ pending: 0, trusted: false, folders: [], snapshot: { ...empty(), notebooks: { serializers: [], controllers: [], documents: retained } }, error: retained.length ? "The extension host stopped. Unsaved notebook cells remain visible for recovery." : null });
      return;
    }
    const domain = value.domain;
    if (domain !== "tests" && domain !== "scm" && domain !== "notebooks" && domain !== "debug") return;
    if (method === "workbench/show") { void this.show(domain); return; }
    if (method === "workbench/changed") {
      this.revisions[domain]++;
      this.update({ snapshot: { ...this.state.snapshot, [domain]: this.retainNotebookRecovery(domain, value) }, trusted: value.isTrusted === true,
        folders: Array.isArray(value.folders) ? value.folders.filter((folder): folder is string => typeof folder === "string") : this.state.folders });
    }
  }
  async act(domain: ExtensionDomain, op: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.request) { this.update({ error: "The extension host is not connected." }); return undefined; }
    this.update({ pending: this.state.pending + 1, error: null });
    const generation = this.generation;
    const revision = this.revisions[domain];
    try {
      const uri = typeof params.uri === "string" ? params.uri : "";
      if (domain === "notebooks" && ["execute", "save", "close"].includes(op)) {
        await Promise.all(this.notebookEdits.get(uri) ?? []);
        if (generation !== this.generation) return undefined;
        const editError = this.notebookEditErrors.get(uri);
        if (editError) throw new Error(`Resolve the notebook edit before ${op}: ${editError}`);
      }
      const request = this.request({ domain, op, ...params });
      if (domain === "notebooks" && op === "edit") {
        if (!this.notebookEdits.has(uri)) this.notebookEdits.set(uri, new Set());
        const edits = this.notebookEdits.get(uri);
        edits?.add(request);
        void request.then(() => { edits?.delete(request); if (generation === this.generation) this.notebookEditErrors.delete(uri); }, error => {
          edits?.delete(request); if (generation === this.generation) this.notebookEditErrors.set(uri, String(error));
        });
      }
      const result = await request;
      if (generation !== this.generation) return undefined;
      if (op === "snapshot" && revision === this.revisions[domain]) {
        const info = result && typeof result === "object" ? result as Record<string, unknown> : {};
        this.update({ snapshot: { ...this.state.snapshot, [domain]: this.retainNotebookRecovery(domain, result) }, trusted: info.isTrusted === true,
          folders: Array.isArray(info.folders) ? info.folders.filter((folder): folder is string => typeof folder === "string") : [] });
      }
      return result;
    } catch (error) { if (generation === this.generation) this.update({ error: String(error).replace(/^Error: /, "") }); return undefined; }
    finally { if (generation === this.generation) this.update({ pending: Math.max(0, this.state.pending - 1) }); }
  }
}
export const extensionWorkbench = new ExtensionWorkbenchService();
