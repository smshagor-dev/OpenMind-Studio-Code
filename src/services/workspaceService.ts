import type { DocumentService, DocumentSnapshot } from "./documentService";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { IpcClient, RecentFileInfo, WorkspaceInfo } from "./ipc";
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
    this.documents.close(id);
    if (this.activeId === id) {
      this.activeId = this.order[index] ?? this.order[index - 1] ?? null;
    }
    this.recompute();
    await this.persistSession();
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
