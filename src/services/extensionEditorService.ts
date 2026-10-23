import type { DocumentService } from "./documentService";
import type { EditorService } from "./editorService";
import type { HostDocumentSync } from "./extensionHostSync";
import {
  type EditResult,
  type HostRange,
  type HostSelection,
  type HostTextEdit,
  type HostEditOptions,
  parseEditOptions,
  parseEdits,
  parseSelections,
} from "./hostEdits";

export interface ExtensionEditorDeps {
  documents: DocumentService;
  editor: EditorService;
  sync: HostDocumentSync;
  /** Whether a text editor (not only a Markdown preview) shows this document. */
  hasTextTab: (docId: string) => boolean;
}

/** One file of an edit as the host sends it. */
export interface FileEdits extends HostEditOptions {
  path: string;
  version: number;
  edits: HostTextEdit[];
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * What an extension may do to the editors: edit the text of an open document (`TextEditor.edit`,
 * `workspace.applyEdit`), move the selection and reveal a range. Edits change the open buffer only —
 * the file on disk is untouched and Save stays the app's own; every check happens before anything changes,
 * so a refused batch changes nothing. UI-free.
 */
export class ExtensionEditorService {
  constructor(private readonly deps: ExtensionEditorDeps) {}

  /** Checks one file of an edit: the document id when it can be edited, otherwise why not. */
  private editable(file: FileEdits): { id: string } | { reason: string } {
    const { documents, sync } = this.deps;
    const id = documents.idForPath(file.path);
    if (id === null) return { reason: `${file.path} isn't open.` };
    if (!this.deps.hasTextTab(id)) {
      return { reason: `${file.path} is shown read-only (a preview), so it can't be edited.` };
    }
    if (sync.hasPending(id) || sync.versionOf(id) !== file.version) {
      return {
        reason: `${file.path} changed since the extension read it (it had version ${String(file.version)}).`,
      };
    }
    return { id };
  }

  /** `TextEditor.edit`: one document, all or nothing. */
  applyEdits(params: unknown): EditResult {
    const p = record(params);
    return this.applyFiles([
      { path: str(p.path), version: Number(p.version), edits: parseEdits(p.edits), ...parseEditOptions(p) },
    ]);
  }

  /** `workspace.applyEdit`: several open documents (only documents that are open). */
  applyWorkspaceEdit(params: unknown): EditResult {
    const p = record(params);
    const list = Array.isArray(p.files) ? p.files : [];
    return this.applyFiles(
      list.map((raw: unknown) => {
        const file = record(raw);
        return {
          path: str(file.path),
          version: Number(file.version),
          edits: parseEdits(file.edits),
          ...parseEditOptions(file),
        };
      }),
    );
  }

  private applyFiles(files: FileEdits[]): EditResult {
    const { documents, sync } = this.deps;
    const targets: { id: string; edits: HostTextEdit[]; options: HostEditOptions }[] = [];
    const seen = new Set<string>();
    for (const file of files) {
      const found = this.editable(file);
      if ("reason" in found) return { applied: false, reason: found.reason };
      if (seen.has(found.id)) {
        return { applied: false, reason: "A workspace edit targets the same document more than once." };
      }
      seen.add(found.id);
      try {
        documents.validateHostEdits(found.id, file.edits);
      } catch (error) {
        return { applied: false, reason: error instanceof Error ? error.message : String(error) };
      }
      targets.push({ id: found.id, edits: file.edits, options: parseEditOptions({ ...file }) });
    }
    const applied: string[] = [];
    try {
      for (const target of targets) {
        documents.applyHostEdits(target.id, target.edits, target.options);
        applied.push(target.id);
      }
    } catch (error) {
      // Each document is its own buffer: the ones already changed keep their (undoable) edit.
      for (const id of applied) sync.commitChange(id);
      return { applied: false, reason: error instanceof Error ? error.message : String(error) };
    }
    for (const id of applied) sync.commitChange(id);
    return { applied: true };
  }

  setSelections(params: unknown): void {
    const p = record(params);
    const uri = this.modelUriOf(str(p.path));
    if (uri === null) return;
    const selections: HostSelection[] = parseSelections(p.selections);
    this.deps.editor.setSelectionsFor(uri, selections);
  }

  setOptions(params: unknown): void {
    const p = record(params);
    const options = record(p.options);
    const uri = this.modelUriOf(str(p.path));
    if (uri === null) return;
    const tabSize = options.tabSize;
    const insertSpaces = options.insertSpaces;
    if (tabSize !== undefined && tabSize !== "auto" && (typeof tabSize !== "number" || !Number.isInteger(tabSize) || tabSize < 1 || tabSize > 1000)) throw new Error("Invalid editor tab size.");
    if (insertSpaces !== undefined && insertSpaces !== "auto" && typeof insertSpaces !== "boolean") throw new Error("Invalid editor indentation option.");
    this.deps.editor.setOptionsFor(uri, { tabSize: tabSize, insertSpaces: insertSpaces });
  }

  revealRange(params: unknown): void {
    const p = record(params);
    const uri = this.modelUriOf(str(p.path));
    if (uri === null) return;
    const type = p.type === 1 || p.type === 2 || p.type === 3 ? p.type : 0;
    this.deps.editor.revealRangeFor(uri, record(p.range) as unknown as HostRange, type);
  }

  private modelUriOf(path: string): string | null {
    const id = this.deps.documents.idForPath(path);
    return id === null ? null : this.deps.documents.modelUri(id);
  }
}

