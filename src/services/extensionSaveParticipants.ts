import type { DocumentService } from "./documentService";
import type { HostDocumentSync } from "./extensionHostSync";
import type { ExtensionEditorService } from "./extensionEditorService";

export interface SaveParticipantDeps {
  documents: DocumentService;
  sync: HostDocumentSync;
  isRunning: () => boolean;
  request: (params: unknown) => Promise<unknown>;
  applyEdits: ExtensionEditorService["applyEdits"];
  timeoutMs?: number;
}

/** Late host replies never apply edits: only the caller holding the save deadline can apply them. */
export class ExtensionSaveParticipants {
  private generation = 0;
  constructor(private readonly deps: SaveParticipantDeps) {}
  reset(): void { this.generation++; }
  async run(id: string, reason: 1 | 2 | 3): Promise<void> {
    const { documents, sync } = this.deps;
    if (!this.deps.isRunning() || !documents.has(id) || documents.isReadOnly(id)) return;
    sync.flush();
    const document = sync.describe(id);
    if (!document) return;
    const generation = this.generation;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        this.deps.request({ path: document.path, version: document.version, reason }),
        new Promise<null>(resolve => { timer = setTimeout(() => { resolve(null); }, this.deps.timeoutMs ?? 1750); }),
      ]);
      if (!response || typeof response !== "object" || !("files" in response) || !Array.isArray(response.files)) return;
      if (generation !== this.generation || !this.deps.isRunning() || !documents.has(id) || documents.hostPath(id) !== document.path) return;
      const edits: unknown[] = []; let eol: unknown;
      for (const file of response.files as unknown[]) {
        if (!file || typeof file !== "object" || !("path" in file) || file.path !== document.path || !("version" in file) || file.version !== document.version || !("edits" in file) || !Array.isArray(file.edits)) return;
        edits.push(...file.edits as unknown[]);
        if ("eol" in file) eol = file.eol;
      }
      if (edits.length || eol !== undefined) this.deps.applyEdits({ path: document.path, version: document.version, edits, ...(eol === undefined ? {} : { eol }) });
    } catch { /* Preserve the current buffer and let the save proceed. */ }
    finally { clearTimeout(timer); }
  }
}
