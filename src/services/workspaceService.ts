import type { DocumentService, DocumentSnapshot } from "./documentService";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { IpcClient, PinnedFolderEntry, RecentFileInfo, WorkspaceInfo } from "./ipc";
import { safely } from "./safely";

export interface WorkspaceState {
  tabs: DocumentSnapshot[];
  activeId: string | null;
}

const EMPTY_STATE: WorkspaceState = { tabs: [], activeId: null };

/**
 * Owns the set of open tabs (order + active tab), the active workspace
 * folder, and session/recent-files/recent-folders persistence. Session
 * state is saved after every mutation rather than only on app close, so it
 * survives a crash or force-quit, not just a clean exit.
 */
export class WorkspaceService {
  private order: string[] = [];
  private activeId: string | null = null;
  private cachedState: WorkspaceState = EMPTY_STATE;
  private activeWorkspace: WorkspaceInfo | null = null;
  /** Paths of closed file-backed tabs, most recent last — backs "Reopen Closed Editor". */
  private readonly closedPaths: string[] = [];
  private readonly unsubscribeDirty: () => void;

  constructor(
    private readonly documents: DocumentService,
    private readonly ipc: IpcClient,
    private readonly events: EventBus<AppEvents>,
  ) {
    this.unsubscribeDirty = this.events.on("documentDirtyChanged", ({ id }) => {
      if (this.order.includes(id)) {
        this.recompute();
      }
    });
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

  createUntitled(): string {
    const id = this.documents.createUntitled();
    this.order.push(id);
    this.activeId = id;
    this.recompute();
    return id;
  }

  /** Opens `path` in a tab; failures (e.g. a binary file, or one deleted outside the app) surface as `appError` rather than throwing. */
  async openPath(path: string): Promise<string | null> {
    const id = await safely(
      this.events,
      () => this.documents.openFromPath(path),
      `open "${path}"`,
      null,
    );
    if (id === null) {
      return null;
    }
    if (!this.order.includes(id)) {
      this.order.push(id);
    }
    this.activeId = id;
    this.recompute();
    await this.persistSession();
    return id;
  }

  setActive(id: string): void {
    if (!this.order.includes(id) || this.activeId === id) {
      return;
    }
    this.activeId = id;
    this.recompute();
  }

  async close(id: string): Promise<void> {
    const index = this.order.indexOf(id);
    if (index === -1) {
      return;
    }
    this.order.splice(index, 1);
    this.rememberClosed(id);
    this.documents.close(id);
    if (this.activeId === id) {
      this.activeId = this.order[index] ?? this.order[index - 1] ?? null;
    }
    this.recompute();
    await this.persistSession();
  }

  /** Activates the tab `delta` positions away from the active one, wrapping around (Ctrl+PageDown/PageUp). */
  cycleActive(delta: number): void {
    if (this.order.length === 0) {
      return;
    }
    const current = this.activeId ? this.order.indexOf(this.activeId) : 0;
    const next = (((current + delta) % this.order.length) + this.order.length) % this.order.length;
    const nextId = this.order[next];
    if (nextId) {
      this.setActive(nextId);
    }
  }

  async closeAll(): Promise<void> {
    if (this.order.length === 0) {
      return;
    }
    for (const id of this.order) {
      this.rememberClosed(id);
      this.documents.close(id);
    }
    this.order = [];
    this.activeId = null;
    this.recompute();
    await this.persistSession();
  }

  /** Reopens the most recently closed file-backed tab, skipping any that no longer open. */
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

  /** Saves every dirty tab in tab order (untitled ones go through Save As, like VS Code). */
  async saveAll(): Promise<void> {
    for (const id of [...this.order]) {
      if (this.documents.isDirty(id)) {
        await this.save(id);
      }
    }
  }

  /** Discards unsaved changes in `id`, restoring its last-saved content. */
  revert(id: string): void {
    if (!this.order.includes(id)) {
      return;
    }
    this.documents.revert(id);
    this.recompute();
  }

  async save(id: string): Promise<void> {
    await safely(this.events, () => this.documents.save(id), "save that file", undefined);
    this.recompute();
  }

  async saveAs(id: string): Promise<void> {
    await safely(this.events, () => this.documents.saveAs(id), "save that file", undefined);
    this.recompute();
    await this.persistSession();
  }

  async loadRecentFiles(): Promise<RecentFileInfo[]> {
    return safely(this.events, () => this.ipc.recentFilesList(), "load recent files", []);
  }

  /** Reopens the previous session's tabs, restoring the active one. Missing/unreadable files are skipped, not fatal. */
  async restoreSession(): Promise<void> {
    const snapshot = await safely(
      this.events,
      () => this.ipc.sessionLoad(),
      "restore the previous session",
      { openPaths: [], activePath: null },
    );

    for (const path of snapshot.openPaths) {
      const id = await safely(
        this.events,
        () => this.documents.openFromPath(path),
        `reopen "${path}"`,
        null,
      );
      if (id !== null && !this.order.includes(id)) {
        this.order.push(id);
      }
    }
    const activeDoc = snapshot.activePath
      ? this.order.find((id) => this.documents.snapshot(id).path === snapshot.activePath)
      : undefined;
    this.activeId = activeDoc ?? this.order[this.order.length - 1] ?? null;
    this.recompute();
  }

  // --- Workspace folder ---

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

  private rememberClosed(id: string): void {
    const path = this.documents.snapshot(id).path;
    if (path !== null) {
      this.closedPaths.push(path);
    }
  }

  private async persistSession(): Promise<void> {
    const openPaths = this.order
      .map((id) => this.documents.snapshot(id).path)
      .filter((path): path is string => path !== null);
    const activePath = this.activeId ? this.documents.snapshot(this.activeId).path : null;
    await safely(
      this.events,
      () => this.ipc.sessionSave({ openPaths, activePath }),
      "save the session",
      undefined,
    );
  }

  private recompute(): void {
    const tabs = this.order.map((id) => this.documents.snapshot(id));
    this.cachedState = { tabs, activeId: this.activeId };
    this.events.emit("tabsChanged", this.cachedState);
  }

  dispose(): void {
    this.unsubscribeDirty();
  }
}
