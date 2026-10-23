import type { DocumentService } from "./documentService";
import type { EditorGroupService } from "./editorGroupService";
import type { EditorService, VisibleEditorState } from "./editorService";
import type { TextDocumentShowOptions } from "./extensionDocumentOptions";
import type { WorkspaceService } from "./workspaceService";

export interface DocumentOpeningDeps {
  documents: DocumentService;
  workspace: WorkspaceService;
  groups: EditorGroupService;
  editor: EditorService;
  revealEditors?: () => void;
}

/** Resolves a requested group, then waits for that group's actual Monaco pane. */
export class ExtensionDocumentOpening {
  private readonly pending = new Map<string, AbortController>();

  cancel(extension: string, requestId: string): void { this.pending.get(JSON.stringify([extension, requestId]))?.abort(); }
  reset(): void { for (const controller of this.pending.values()) controller.abort(); this.pending.clear(); }
  constructor(private readonly deps: DocumentOpeningDeps) {}

  async show(path: string, options: TextDocumentShowOptions, context = { extension: "", requestId: "" }): Promise<{ editorId: string }> {
    const key = JSON.stringify([context.extension, context.requestId]);
    const controller = new AbortController();
    this.pending.get(key)?.abort();
    this.pending.set(key, controller);
    try { return await this.open(path, options, controller.signal); }
    finally { if (this.pending.get(key) === controller) this.pending.delete(key); }
  }

  private async open(path: string, options: TextDocumentShowOptions, signal: AbortSignal): Promise<{ editorId: string }> {
    const { documents, groups, workspace, editor } = this.deps;
    // Load first: failures must not leave extra groups behind.
    const docId = await documents.openFromPath(path);
    signal.throwIfAborted();
    this.deps.revealEditors?.();
    const uri = documents.modelUri(docId);
    if (!uri) throw new Error("The requested text document has no editor model.");
    const initial = groups.getState();
    let groupId = initial.activeGroupId;
    if (options.viewColumn === -2) {
      const index = initial.groups.findIndex(group => group.id === groupId);
      if (index >= 8) throw new Error("No additional extension editor column is available.");
      groupId = initial.groups[index + 1]?.id ?? groups.splitRight({ copyActiveTab: false, preserveFocus: true });
    } else if (options.viewColumn !== undefined && options.viewColumn > 0) {
      while (groups.getState().groups.length < options.viewColumn) {
        const last = groups.getState().groups.at(-1);
        groups.splitRight({ fromGroupId: last?.id, copyActiveTab: false, preserveFocus: true });
      }
      groupId = groups.getState().groups[options.viewColumn - 1]?.id ?? groupId;
    }
    const opened = await workspace.openPath(path, { kind: "text", groupId, preview: options.preview, preserveFocus: options.preserveFocus });
    if (opened === null) throw new Error("The requested text document could not be opened.");
    signal.throwIfAborted();
    const target = await this.waitForPane(uri, groupId, signal);
    signal.throwIfAborted();
    const native = editor.visibleEditorFor(uri, target.id);
    if (!native) throw new Error("The requested editor was closed before it could be shown.");
    const selection = options.selection;
    if (selection) {
      editor.setSelectionsFor(uri, [{ anchorLine: selection.startLine, anchorColumn: selection.startColumn,
        activeLine: selection.endLine, activeColumn: selection.endColumn }], target.id);
      editor.revealRangeFor(uri, selection, 2, target.id);
    }
    if (!options.preserveFocus) native.focus();
    return { editorId: target.id };
  }

  private waitForPane(uri: string, groupId: string, signal: AbortSignal): Promise<VisibleEditorState> {
    const { editor, groups } = this.deps;
    const docId = this.deps.documents.idForModelUri(uri);
    const requested = () => docId !== undefined && groups.getGroup(groupId)?.activeTabId === docId;
    if (!requested()) return Promise.reject(new Error("The requested editor was closed before it could be shown."));
    const find = () => editor.snapshotEditors().find(pane => pane.uri === uri && pane.groupId === groupId);
    const existing = find();
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (pane?: VisibleEditorState, error?: Error) => {
        if (done) return;
        done = true; clearTimeout(timer); offEditor(); offGroups(); signal.removeEventListener("abort", aborted);
        if (pane) resolve(pane); else reject(error ?? new Error("The requested text editor did not become visible."));
      };
      const aborted = () => { finish(undefined, new Error("The document show request was cancelled.")); };
      signal.addEventListener("abort", aborted, { once: true });
      const offEditor = editor.subscribe(() => { const pane = find(); if (pane) finish(pane); });
      const offGroups = groups.subscribe(() => {
        if (!requested()) finish(undefined, new Error("The requested editor was closed before it could be shown."));
      });
      const timer = setTimeout(() => { finish(); }, 10000);
    });
  }
}
