import type { DocumentService, DocumentSnapshot } from "./documentService";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { IpcClient, RecentFileInfo } from "./ipc";

export interface WorkspaceState {
  tabs: DocumentSnapshot[];
  activeId: string | null;
}

const EMPTY_STATE: WorkspaceState = { tabs: [], activeId: null };

/**
 * Owns the set of open tabs (order + active tab) and session/recent-files
 * persistence. Session state is saved after every mutation rather than only
 * on app close, so it survives a crash or force-quit, not just a clean
 * exit.
 */
export class WorkspaceService {
  private order: string[] = [];
  private activeId: string | null = null;
  private cachedState: WorkspaceState = EMPTY_STATE;
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

  subscribe(listener: () => void): () => void {
    return this.events.on("tabsChanged", listener);
  }

  createUntitled(): string {
    const id = this.documents.createUntitled();
    this.order.push(id);
    this.activeId = id;
    this.recompute();
    return id;
  }

  async openPath(path: string): Promise<string> {
    const id = await this.documents.openFromPath(path);
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
    await this.documents.save(id);
    this.recompute();
  }

  async saveAs(id: string): Promise<void> {
    await this.documents.saveAs(id);
    this.recompute();
    await this.persistSession();
  }

  async loadRecentFiles(): Promise<RecentFileInfo[]> {
    return this.ipc.recentFilesList();
  }

  /** Reopens the previous session's tabs, restoring the active one. */
  async restoreSession(): Promise<void> {
    const snapshot = await this.ipc.sessionLoad();
    for (const path of snapshot.openPaths) {
      await this.documents.openFromPath(path).then((id) => {
        if (!this.order.includes(id)) {
          this.order.push(id);
        }
      });
    }
    const activeDoc = snapshot.activePath
      ? this.order.find((id) => this.documents.snapshot(id).path === snapshot.activePath)
      : undefined;
    this.activeId = activeDoc ?? this.order[this.order.length - 1] ?? null;
    this.recompute();
  }

  private async persistSession(): Promise<void> {
    const openPaths = this.order
      .map((id) => this.documents.snapshot(id).path)
      .filter((path): path is string => path !== null);
    const activePath = this.activeId ? this.documents.snapshot(this.activeId).path : null;
    await this.ipc.sessionSave({ openPaths, activePath });
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
