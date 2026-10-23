import type { DocumentService, DocumentSnapshot } from "./documentService";
import { EditorAssociationService } from "./editorAssociationService";
import {
  EditorGroupService,
  tabIdFor,
  type EditorGroup,
  type EditorKind,
  type EditorTab,
} from "./editorGroupService";
import { EditorLayoutService, type SavedLayout } from "./editorLayoutService";
import { FilePreviewService, isPreviewableText, type CollabOrigin } from "./filePreviewService";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { IpcClient, PinnedFolderEntry, RecentFileInfo, WorkspaceInfo } from "./ipc";
import { PreviewEditorService } from "./previewEditorService";
import { safely } from "./safely";

/** One open tab as the UI sees it: the document's snapshot plus how and where it is shown. */
export interface EditorTabView extends DocumentSnapshot {
  /** The tab's id (a text tab's is its document id; see `tabIdFor`). */
  id: string;
  docId: string;
  kind: EditorKind;
  /** Provisional ("italic") tab. */
  preview: boolean;
  groupId: string;
}

export interface EditorGroupView {
  id: string;
  tabs: EditorTabView[];
  activeTabId: string | null;
  locked: boolean;
}

export interface WorkspaceState {
  /** The active group's tabs and active tab — what the single-editor commands work on. */
  tabs: EditorTabView[];
  activeId: string | null;
  groups: EditorGroupView[];
  activeGroupId: string;
  weights: number[];
}

export interface OpenPathOptions {
  /** Open as a provisional tab (honored only while "Enable Preview Editors" is on). */
  preview?: boolean;
  groupId?: string;
  /** Force an editor kind instead of the file type's default. */
  kind?: EditorKind;
}

/** A place in a document to reveal after opening it (1-based, UTF-16 columns like Monaco). */
export interface RevealTarget {
  line: number;
  column: number;
  length: number;
}

export type ReopenView = "text" | "markdownEditor" | "markdownPreview";

export interface WorkspaceDeps {
  groups: EditorGroupService;
  associations: EditorAssociationService;
  previews: PreviewEditorService;
  filePreviews: FilePreviewService;
}

const EMPTY_STATE: WorkspaceState = {
  tabs: [],
  activeId: null,
  groups: [],
  activeGroupId: "",
  weights: [],
};

/**
 * Owns the documents' relationship to the editor area (opening, closing,
 * saving, which tab is active), the active workspace *folder*, and
 * session/recent-files persistence. The arrangement itself — groups, tab
 * order, provisional and locked state — is `EditorGroupService`'s; this class
 * adds what needs documents: a document stays open while any tab shows it and
 * is released when its last tab closes. Session state is saved after every
 * mutation, so it survives a crash or force-quit, not just a clean exit.
 */
export class WorkspaceService {
  private readonly groups: EditorGroupService;
  private readonly associations: EditorAssociationService;
  private readonly previews: PreviewEditorService;
  readonly filePreviews: FilePreviewService;
  private readonly layout: EditorLayoutService;
  private cachedState: WorkspaceState = EMPTY_STATE;
  private activeWorkspace: WorkspaceInfo | null = null;
  private defaultWorkspace: Promise<WorkspaceInfo | null> | null = null;
  /** Paths of closed file-backed documents, most recent last — backs "Reopen Closed Editor". */
  private readonly closedPaths: string[] = [];
  private revealer: ((uri: string, target: RevealTarget) => void) | null = null;
  private readonly unsubscribers: (() => void)[] = [];

  constructor(
    private readonly documents: DocumentService,
    private readonly ipc: IpcClient,
    private readonly events: EventBus<AppEvents>,
    deps: Partial<WorkspaceDeps> = {},
  ) {
    this.groups = deps.groups ?? new EditorGroupService();
    this.associations = deps.associations ?? new EditorAssociationService(ipc);
    this.previews = deps.previews ?? new PreviewEditorService(ipc);
    this.filePreviews = deps.filePreviews ?? new FilePreviewService(ipc);
    this.layout = new EditorLayoutService(
      ipc,
      this.groups,
      (docId) => this.docPath(docId),
      (error) => {
        this.events.emit("appError", {
          message: `Couldn't save the open editors, so they won't reopen after a restart: ${String(error)}`,
        });
      },
    );
    this.unsubscribers.push(
      this.groups.subscribe(() => {
        this.recompute();
      }),
      // The file behind a tab changed on disk, was deleted or renamed: the tab shows it.
      this.events.on("documentExternalChanged", ({ id }) => {
        if (this.groups.tabsForDoc(id).length > 0) this.recompute();
      }),
      // Save As or a rename/move: the tab title, breadcrumbs and the saved session follow the new path.
      this.events.on("documentPathChanged", ({ id }) => {
        if (this.groups.tabsForDoc(id).length === 0) return;
        this.recompute();
        void this.persistSession();
      }),
      this.events.on("documentDirtyChanged", ({ id, dirty }) => {
        // Editing a provisional tab keeps it.
        if (dirty) this.groups.pinDoc(id);
        if (this.groups.tabsForDoc(id).length > 0) this.recompute();
      }),
    );
    this.layout.startAutoSave();
    this.recompute();
  }

  getState(): WorkspaceState {
    return this.cachedState;
  }

  getActiveWorkspace(): WorkspaceInfo | null {
    return this.activeWorkspace;
  }

  subscribe(listener: () => void): () => void {
    return this.events.on("tabsChanged", listener);
  }

  subscribeWorkspace(listener: () => void): () => void {
    return this.events.on("workspaceFolderChanged", listener);
  }

  /** Where "reveal this position" goes once a file is showing (wired by the composition root). */
  setRevealer(revealer: (uri: string, target: RevealTarget) => void): void {
    this.revealer = revealer;
  }

  // --- Opening ---

  createUntitled(): string {
    const id = this.documents.createUntitled();
    return this.groups.openTab(id, "text").id;
  }

  /** Opens `path` in a tab; failures (e.g. a binary file, or one deleted outside the app) surface as `appError` rather than throwing. */
  async openPath(path: string, options: OpenPathOptions = {}): Promise<string | null> {
    if (options.kind !== "text" && (await this.filePreviews.shouldPreview(path))) {
      return this.openFilePreview(path, options);
    }
    const docId = await safely(
      this.events,
      () => this.documents.openFromPath(path),
      `open "${path}"`,
      null,
    );
    if (docId === null) {
      return null;
    }
    const tab = this.showDocument(docId, options.kind ?? this.associations.kindFor(path), options);
    await this.persistSession();
    return tab.id;
  }

  /** The preview document behind a preview tab's `docId`, if it is one. */
  filePreviewState(docId: string) {
    return this.filePreviews.get(docId);
  }

  /** Whether `docId` is a read-only file preview (not a text document). */
  isFilePreview(docId: string): boolean {
    return this.filePreviews.has(docId);
  }

  /** Opens a read-only preview tab for a file (image, PDF, Office file, or any text format shown rendered). */
  async openFilePreview(path: string, options: OpenPathOptions = {}): Promise<string> {
    const docId = this.filePreviews.open(path);
    const tab = this.showDocument(docId, "filePreview", options);
    await this.persistSession();
    return tab.id;
  }

  /** Opens an extension's custom-scheme document (`memfs:/a.txt`) in a read-only tab (Milestone 18). */
  openVirtualDocument(request: {
    uri: string;
    text: string;
    language: string;
    extension: string;
    readonly: boolean;
    collab?: CollabOrigin;
  }): string {
    const docId = this.filePreviews.openVirtual(request);
    return this.showDocument(docId, "filePreview", {}).id;
  }

  /** Refreshes an existing virtual preview without opening a tab or changing focus. */
  updateVirtualDocument(request: Parameters<FilePreviewService["openVirtual"]>[0]): boolean {
    if (this.filePreviews.virtualId(request.uri) === null) return false;
    this.filePreviews.openVirtual(request);
    return true;
  }

  /** Why the text document `docId` has no file preview (or Markdown preview), or null when it has one. */
  filePreviewUnavailableReason(docId: string | null): string | null {
    if (docId === null) return "There is no editor open.";
    const path = this.docPath(docId);
    if (path === null) return "Save the file first to preview it.";
    if (this.filePreviews.has(docId)) return "This is already a preview.";
    return isPreviewableText(path)
      ? null
      : "Preview is available for Markdown, HTML, LaTeX and CSV files.";
  }

  /** Opens the read-only preview of a text document's saved file in the active group. */
  async openFilePreviewOf(docId: string): Promise<boolean> {
    if (this.filePreviewUnavailableReason(docId) !== null) return false;
    const path = this.docPath(docId);
    if (path === null) return false;
    await this.openFilePreview(path);
    return true;
  }

  /** "Open as Text": replaces a preview tab by the text editor on the same file, when that is safe. */
  async openAsText(id: string): Promise<boolean> {
    const found = this.findTab(id);
    if (!found || found.tab.kind !== "filePreview") return false;
    const doc = this.filePreviews.get(found.tab.docId);
    if (!doc) return false;
    if (doc.info?.textSafe !== true) {
      this.events.emit("appError", { message: `${doc.name} can't be opened as text safely.` });
      return false;
    }
    const docId = await safely(
      this.events,
      () => this.documents.openFromPath(doc.path),
      `open "${doc.path}" as text`,
      null,
    );
    if (docId === null) return false;
    this.tracking(() => this.groups.replaceTab(found.group.id, found.tab.id, docId, "text"));
    await this.persistSession();
    return true;
  }

  /** Opens `path` in the text editor and reveals a position in it (search results, problems). */
  async openPathAt(path: string, target: RevealTarget): Promise<string | null> {
    const id = await this.openPath(path, { kind: "text", preview: true });
    const docId = id === null ? null : this.docIdOfTab(id);
    if (docId !== null) this.reveal(docId, target);
    return id;
  }

  /** Opens an already-open document (`docId`) in a tab, e.g. from the Problems panel. */
  openDocument(docId: string, kind: EditorKind, options: OpenPathOptions = {}): string {
    return this.showDocument(docId, kind, options).id;
  }

  /** Brings a document's text editor up and reveals a position in it. */
  openDocumentAt(docId: string, target: RevealTarget): void {
    this.showDocument(docId, "text", {});
    this.reveal(docId, target);
  }

  /** Opens the document behind a Monaco model URI (a Problems entry) at a position. False if it's no longer open. */
  openProblemAt(uri: string, target: RevealTarget): boolean {
    const docId = this.documents.idForModelUri(uri);
    if (docId === undefined) return false;
    this.openDocumentAt(docId, target);
    return true;
  }

  private showDocument(docId: string, kind: EditorKind, options: OpenPathOptions): EditorTab {
    return this.tracking(() =>
      this.groups.openTab(docId, kind, {
        groupId: options.groupId,
        preview: this.previews.shouldOpenAsPreview(options.preview === true),
      }),
    );
  }

  private reveal(docId: string, target: RevealTarget): void {
    const uri = this.documents.modelUri(docId);
    if (uri !== null) this.revealer?.(uri, target);
  }

  // --- Tabs ---

  /** Activates a tab of the active group (or, failing that, any group). */
  setActive(id: string): void {
    const found = this.findTab(id);
    if (found) this.groups.activateTab(found.group.id, found.tab.id);
  }

  activateTab(groupId: string, tabId: string): void {
    this.groups.activateTab(groupId, tabId);
  }

  async close(id: string): Promise<void> {
    const found = this.findTab(id);
    if (found) await this.closeTab(found.group.id, found.tab.id);
  }

  async closeTab(groupId: string, tabId: string): Promise<void> {
    this.tracking(() => this.groups.closeTab(groupId, tabId));
    await this.persistSession();
  }

  /** Closes the tabs in `groupId` (every group when omitted) that match `keep === false`. */
  async closeTabsWhere(
    groupId: string | null,
    shouldClose: (tab: EditorTabView) => boolean,
  ): Promise<void> {
    const victims = this.cachedState.groups
      .filter((group) => groupId === null || group.id === groupId)
      .flatMap((group) => group.tabs.filter(shouldClose));
    if (victims.length === 0) return;
    this.tracking(() => {
      for (const tab of victims) this.groups.closeTab(tab.groupId, tab.id);
    });
    await this.persistSession();
  }

  /** Closes every tab in the group, or in all groups when none is given. */
  async closeAll(groupId: string | null = null): Promise<void> {
    await this.closeTabsWhere(groupId, () => true);
  }

  /** Activates the tab `delta` positions away in the active group, wrapping around (Ctrl+PageDown/PageUp). */
  cycleActive(delta: number): void {
    const group = this.groups.activeGroup();
    if (group.tabs.length === 0) {
      return;
    }
    const current = Math.max(
      0,
      group.tabs.findIndex((tab) => tab.id === group.activeTabId),
    );
    const next = (((current + delta) % group.tabs.length) + group.tabs.length) % group.tabs.length;
    const nextTab = group.tabs[next];
    if (nextTab) this.groups.activateTab(group.id, nextTab.id);
  }

  /** Reopens the most recently closed file-backed document, skipping any that no longer open. */
  async reopenClosed(): Promise<void> {
    let path = this.closedPaths.pop();
    while (path !== undefined) {
      if ((await this.openPath(path)) !== null) {
        return;
      }
      path = this.closedPaths.pop();
    }
  }

  canReopenClosed(): boolean {
    return this.closedPaths.length > 0;
  }

  /** Makes a provisional tab permanent (double-click, "Keep Open"). */
  pinTab(groupId: string, tabId: string): void {
    this.groups.pinTab(groupId, tabId);
  }

  /** "Reopen Editor With": shows the tab's document another way, in the same place. */
  reopenTabAs(groupId: string, tabId: string, view: ReopenView): void {
    const tab = this.groups.getGroup(groupId)?.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return;
    if (view === "markdownPreview") {
      this.groups.replaceTab(groupId, tabId, tab.docId, "markdownPreview");
      return;
    }
    // The text editor with plain-text or Markdown syntax highlighting.
    this.documents.setLanguage(tab.docId, view === "markdownEditor" ? "markdown" : "plaintext");
    this.groups.replaceTab(groupId, tabId, tab.docId, "text");
  }

  // --- Groups ---

  /** Split Editor Right: a new group beside the active one, showing the same editor. */
  splitRight(): string {
    return this.groups.splitRight();
  }

  setGroupLocked(groupId: string, locked: boolean): void {
    this.groups.setLocked(groupId, locked);
  }

  setActiveGroup(groupId: string): void {
    this.groups.setActiveGroup(groupId);
  }

  // --- Documents ---

  docPath(docId: string): string | null {
    if (this.filePreviews.has(docId)) return this.filePreviews.path(docId);
    return this.documents.has(docId) ? this.documents.snapshot(docId).path : null;
  }

  /** The syntax mode an open document is currently in ("markdown", "plaintext", ...). */
  docLanguage(docId: string): string {
    return this.documents.has(docId) ? this.documents.languageOf(docId) : "plaintext";
  }

  /** The document behind a tab id of the active group (or any group). */
  docIdOfTab(id: string): string | null {
    return this.findTab(id)?.tab.docId ?? null;
  }

  /** Saves every dirty document in tab order (untitled ones go through Save As, like VS Code). */
  async saveAll(): Promise<void> {
    const seen = new Set<string>();
    for (const { tab } of this.groups.allTabs()) {
      if (seen.has(tab.docId) || this.filePreviews.has(tab.docId)) continue;
      seen.add(tab.docId);
      if (this.documents.isDirty(tab.docId)) {
        await this.save(tab.docId);
      }
    }
    // Documents kept open without a tab (collaborative edits on the Owner's side) are saved too.
    for (const id of this.documents.fileBackedIds()) {
      if (!seen.has(id) && this.documents.isHeld(id) && this.documents.isDirty(id)) await this.save(id);
    }
  }

  /** Discards unsaved changes in the tab's document, restoring its last-saved content. */
  revert(id: string): void {
    const docId = this.docIdOfTab(id);
    if (docId === null || this.filePreviews.has(docId)) {
      return;
    }
    this.documents.revert(docId);
    this.recompute();
  }

  /** `format: false` skips Format on Save (Auto Save after a delay must not rearrange text while you type). */
  async save(id: string, options: { format?: boolean } = {}): Promise<void> {
    const docId = this.docIdOfTab(id) ?? (this.documents.has(id) ? id : null);
    if (docId === null || this.filePreviews.has(docId)) return;
    const before = this.documents.snapshot(docId).path;
    await safely(
      this.events,
      () => this.documents.save(docId, options),
      "save that file",
      undefined,
    );
    this.recompute();
    if (before === null) await this.afterFirstSave(docId);
  }

  async saveAs(id: string): Promise<void> {
    const docId = this.docIdOfTab(id) ?? (this.documents.has(id) ? id : null);
    if (docId === null || this.filePreviews.has(docId)) return;
    const before = this.documents.snapshot(docId).path;
    await safely(this.events, () => this.documents.saveAs(docId), "save that file", undefined);
    this.recompute();
    if (before === null) await this.afterFirstSave(docId);
    await this.persistSession();
  }

  /**
   * An untitled file just got its first place on disk. With no folder open (a fresh start), its folder becomes the
   * workspace, so the Explorer shows it instead of "No Folder Opened". An open folder is never replaced.
   */
  private async afterFirstSave(docId: string): Promise<void> {
    if (this.activeWorkspace !== null || !this.documents.has(docId)) return;
    const path = this.documents.snapshot(docId).path;
    if (path === null) return;
    const folder = parentFolder(path);
    if (folder !== null) await this.openFolder(folder);
  }

  async loadRecentFiles(): Promise<RecentFileInfo[]> {
    return safely(this.events, () => this.ipc.recentFilesList(), "load recent files", []);
  }

  // --- Session ---

  /**
   * Reopens the previous session: the saved editor layout (groups, tabs,
   * preview/locked state) if there is one, else the older flat list of open
   * files. Missing/unreadable files are skipped, not fatal.
   */
  async restoreSession(): Promise<void> {
    this.layout.pause();
    try {
      const saved = await this.layout.load();
      if (saved?.groups.some((group) => group.tabs.length > 0)) {
        await this.restoreLayout(saved);
      } else {
        await this.restoreFlatSession();
      }
    } finally {
      this.layout.resume();
    }
    await this.layout.save();
  }

  private async restoreLayout(saved: SavedLayout): Promise<void> {
    const restored: EditorGroup[] = [];
    let activeIndex = saved.activeGroup;
    for (const [index, savedGroup] of saved.groups.entries()) {
      const tabs: EditorTab[] = [];
      let activeTabId: string | null = null;
      for (const [tabIndex, savedTab] of savedGroup.tabs.entries()) {
        const docId =
          savedTab.kind === "filePreview"
            ? await this.openPreviewForRestore(savedTab.path)
            : await this.openForRestore(savedTab.path);
        if (docId === null) continue;
        const id = tabIdFor(docId, savedTab.kind);
        if (tabs.some((tab) => tab.id === id)) continue;
        tabs.push({ id, docId, kind: savedTab.kind, preview: savedTab.preview });
        if (tabIndex === savedGroup.activeIndex) activeTabId = id;
      }
      if (tabs.length === 0 && saved.groups.length > 1) {
        // Nothing in this group could be reopened; don't leave an empty pane behind.
        if (index <= activeIndex) activeIndex = Math.max(0, activeIndex - 1);
        continue;
      }
      restored.push({
        id: `group-${String(index + 1)}`,
        tabs,
        activeTabId: activeTabId ?? tabs[tabs.length - 1]?.id ?? null,
        locked: savedGroup.locked,
      });
    }
    const weights = restored.length === saved.groups.length ? saved.weights : undefined;
    this.groups.restore(restored, activeIndex, weights);
  }

  private async restoreFlatSession(): Promise<void> {
    const snapshot = await safely(
      this.events,
      () => this.ipc.sessionLoad(),
      "restore the previous session",
      { openPaths: [], activePath: null },
    );
    const tabs: EditorTab[] = [];
    let activeTabId: string | null = null;
    for (const path of snapshot.openPaths) {
      const docId = (await this.filePreviews.shouldPreview(path))
        ? await this.openPreviewForRestore(path)
        : await this.openForRestore(path);
      if (docId === null) continue;
      const kind: EditorKind = this.filePreviews.has(docId)
        ? "filePreview"
        : this.associations.kindFor(path);
      const id = tabIdFor(docId, kind);
      if (!tabs.some((tab) => tab.id === id)) tabs.push({ id, docId, kind, preview: false });
      if (path === snapshot.activePath) activeTabId = id;
    }
    this.groups.restore(
      [
        {
          id: "group-1",
          tabs,
          activeTabId: activeTabId ?? tabs[tabs.length - 1]?.id ?? null,
          locked: false,
        },
      ],
      0,
    );
  }

  private async openPreviewForRestore(path: string): Promise<string | null> {
    return (await this.filePreviews.exists(path)) ? this.filePreviews.open(path) : null;
  }

  private openForRestore(path: string): Promise<string | null> {
    return safely(this.events, () => this.documents.openFromPath(path), `reopen "${path}"`, null);
  }

  // --- Workspace folder ---

  /** Explicit operations may create a fallback; startup only reads the previously selected folder. */
  async ensureWorkspace(fallback: "documents" | "agent" = "documents"): Promise<WorkspaceInfo | null> {
    if (this.activeWorkspace) return this.activeWorkspace;
    if (!this.defaultWorkspace) {
      this.defaultWorkspace = (async () => {
        const info = await safely(this.events, () => this.ipc.workspaceActiveFolder(fallback), "open the default workspace", null);
        if (!this.activeWorkspace && info) {
          this.activeWorkspace = info;
          this.events.emit("workspaceFolderChanged", { workspace: info });
        }
        return this.activeWorkspace;
      })().finally(() => { this.defaultWorkspace = null; });
    }
    return this.defaultWorkspace;
  }

  async openFolder(path: string): Promise<WorkspaceInfo | null> {
    const info = await safely(
      this.events,
      () => this.ipc.workspaceOpenFolder(path),
      `open folder "${path}"`,
      null,
    );
    if (info) {
      this.activeWorkspace = info;
      this.events.emit("workspaceFolderChanged", { workspace: info });
    }
    return info;
  }

  async closeFolder(): Promise<void> {
    await safely(this.events, () => this.ipc.workspaceCloseFolder(), "close the folder", undefined);
    this.activeWorkspace = null;
    this.events.emit("workspaceFolderChanged", { workspace: null });
  }

  async loadRecentFolders(): Promise<WorkspaceInfo[]> {
    return safely(this.events, () => this.ipc.workspaceRecentFolders(), "load recent folders", []);
  }

  /** Reopens the workspace folder that was active last session, if any. */
  async restoreActiveWorkspace(): Promise<WorkspaceInfo | null> {
    const info = await safely(
      this.events,
      () => this.ipc.workspaceActiveFolder(),
      "restore the last workspace",
      null,
    );
    this.activeWorkspace = info;
    if (info) {
      this.events.emit("workspaceFolderChanged", { workspace: info });
    }
    return info;
  }

  async pinFolder(path: string, label?: string): Promise<void> {
    await safely(this.events, () => this.ipc.pinFolder(path, label), `pin "${path}"`, undefined);
    this.events.emit("pinnedFoldersChanged", undefined);
  }

  async unpinFolder(path: string): Promise<void> {
    await safely(this.events, () => this.ipc.unpinFolder(path), `unpin "${path}"`, undefined);
    this.events.emit("pinnedFoldersChanged", undefined);
  }

  async loadPinnedFolders(): Promise<PinnedFolderEntry[]> {
    return safely(this.events, () => this.ipc.listPinnedFolders(), "load pinned folders", []);
  }

  // --- Internals ---

  /** Finds a tab by id: the active group first, then any group. */
  private findTab(id: string): { group: EditorGroup; tab: EditorTab } | null {
    const active = this.groups.activeGroup();
    const inActive = active.tabs.find((tab) => tab.id === id);
    if (inActive) return { group: active, tab: inActive };
    return this.groups.allTabs().find(({ tab }) => tab.id === id) ?? null;
  }

  /**
   * Runs a change to the groups, then releases every document that no tab
   * shows any more (remembering its path for "Reopen Closed Editor").
   */
  private tracking<T>(change: () => T): T {
    const before = new Set(this.groups.allTabs().map(({ tab }) => tab.docId));
    const result = change();
    const after = new Set(this.groups.allTabs().map(({ tab }) => tab.docId));
    for (const docId of before) {
      if (!after.has(docId) && this.filePreviews.has(docId)) {
        const path = this.filePreviews.path(docId);
        if (path !== null) this.closedPaths.push(path);
        this.filePreviews.release(docId);
      } else if (!after.has(docId) && this.documents.has(docId)) {
        const path = this.documents.snapshot(docId).path;
        if (path !== null) this.closedPaths.push(path);
        this.documents.close(docId);
      }
    }
    if (before.size !== after.size || [...before].some((id) => !after.has(id))) this.recompute();
    return result;
  }

  private async persistSession(): Promise<void> {
    const openPaths: string[] = [];
    for (const { tab } of this.groups.allTabs()) {
      const path = this.docPath(tab.docId);
      if (path !== null && !openPaths.includes(path)) openPaths.push(path);
    }
    const active = this.groups.activeTab();
    const activePath = active ? this.docPath(active.docId) : null;
    await safely(
      this.events,
      () => this.ipc.sessionSave({ openPaths, activePath }),
      "save the session",
      undefined,
    );
  }

  private recompute(): void {
    const state = this.groups.getState();
    const views: EditorGroupView[] = state.groups.map((group) => ({
      id: group.id,
      activeTabId: group.activeTabId,
      locked: group.locked,
      tabs: group.tabs.flatMap((tab) => {
        const preview = tab.kind === "filePreview" ? this.filePreviews.get(tab.docId) : undefined;
        if (preview) {
          return [
            {
              id: tab.id,
              docId: tab.docId,
              kind: tab.kind,
              preview: tab.preview,
              groupId: group.id,
              path: preview.path,
              // A text format (CSV, Markdown, HTML, LaTeX) can also be open as text: tell the two tabs apart.
              title: isPreviewableText(preview.path) ? `Preview ${preview.name}` : preview.name,
              dirty: false,
              encoding: "utf8" as const,
              lineEnding: "lf" as const,
              external: "none" as const,
            },
          ];
        }
        if (!this.documents.has(tab.docId)) return [];
        const snapshot = this.documents.snapshot(tab.docId);
        return [
          {
            ...snapshot,
            id: tab.id,
            docId: tab.docId,
            kind: tab.kind,
            preview: tab.preview,
            groupId: group.id,
            title: tab.kind === "markdownPreview" ? `Preview ${snapshot.title}` : snapshot.title,
          },
        ];
      }),
    }));
    const active = views.find((group) => group.id === state.activeGroupId) ?? views[0];
    this.cachedState = {
      tabs: active?.tabs ?? [],
      activeId: active?.activeTabId ?? null,
      groups: views,
      activeGroupId: state.activeGroupId,
      weights: state.weights,
    };
    this.events.emit("tabsChanged", this.cachedState);
  }

  dispose(): void {
    for (const off of this.unsubscribers.splice(0)) off();
    this.layout.dispose();
  }
}

/** The folder holding a file (`C:\a\b.txt` -> `C:\a`, `C:\b.txt` -> `C:\`); `null` when there is none. */
export function parentFolder(path: string): string | null {
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  if (cut < 0) return null;
  const folder = path.slice(0, cut);
  if (folder === "") return path.slice(0, 1);
  return /^[A-Za-z]:$/.test(folder) ? `${folder}${path[cut]}` : folder;
}
