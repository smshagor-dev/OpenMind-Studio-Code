import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { IpcClient } from "./ipc";
import type { EditorTabView, WorkspaceService } from "./workspaceService";

/** A point in screen coordinates (CSS pixels). */
export interface ScreenPoint {
  x: number;
  y: number;
}

/**
 * Why `tab` can't move into a new window, or `null` if it can. Only a saved,
 * file-backed text editor moves: the new window reopens the file from disk, so
 * unsaved text would be lost on the way.
 */
export function moveToWindowBlocker(tab: EditorTabView): string | null {
  if (tab.path === null) return "Save the file before moving it into a new window.";
  if (tab.dirty) return "Save your changes before moving the file into a new window.";
  if (tab.kind !== "text") return "Only a file's editor can move into a new window.";
  return null;
}

/** Whether a drag ended outside the window's viewport (so the tab was pulled out of it). */
export function droppedOutside(
  client: { x: number; y: number },
  viewport: { width: number; height: number },
): boolean {
  return client.x < 0 || client.y < 0 || client.x > viewport.width || client.y > viewport.height;
}

/**
 * VS Code's "move editor into a new window": a tab dragged out of the tab bar
 * (or the active one, by command) opens its file in a new OpenMind Studio
 * window placed at the drop point, and leaves this window. The new window asks
 * for that file once it has started (`openPending`).
 */
export class EditorWindowService {
  constructor(
    private readonly ipc: IpcClient,
    private readonly workspace: WorkspaceService,
    private readonly events: EventBus<AppEvents>,
  ) {}

  /** Moves the tab `tabId` of group `groupId` into a new window. Resolves `true` if it moved. */
  async moveToNewWindow(groupId: string, tabId: string, at?: ScreenPoint): Promise<boolean> {
    const group = this.workspace.getState().groups.find((g) => g.id === groupId);
    const tab = group?.tabs.find((t) => t.id === tabId);
    if (tab === undefined) return false;
    const blocker = moveToWindowBlocker(tab);
    if (blocker !== null || tab.path === null) {
      this.notice(blocker);
      return false;
    }
    try {
      // Keep the new window's title bar under the pointer.
      await this.ipc.windowNew({
        path: tab.path,
        x: at === undefined ? undefined : Math.max(0, at.x - 120),
        y: at === undefined ? undefined : Math.max(0, at.y - 12),
      });
    } catch (error) {
      this.events.emit("appError", { message: `Couldn't open a new window: ${String(error)}` });
      return false;
    }
    await this.workspace.closeTab(groupId, tabId);
    return true;
  }

  /** Moves the active tab into a new window. */
  async moveActiveToNewWindow(): Promise<boolean> {
    const state = this.workspace.getState();
    const group = state.groups.find((g) => g.id === state.activeGroupId);
    if (!group?.activeTabId) return false;
    return this.moveToNewWindow(group.id, group.activeTabId);
  }

  /** Main only: native creation restores each extra window's folder before its page starts. */
  async restoreWindows(): Promise<void> {
    try {
      for (const message of await this.ipc.windowRestore()) this.notice(message);
    } catch (error) {
      this.events.emit("appError", { message: `Couldn't restore editor windows: ${String(error)}` });
    }
  }

  /** In a window opened for a dragged-out tab: opens that file. */
  async openPending(): Promise<void> {
    const path = await this.ipc.windowTakePendingOpen().catch(() => null);
    if (typeof path === "string") await this.workspace.openPath(path);
  }

  /**
   * In the main window, once: what `OpenMindStudio.exe <folder|file ...>` named (File Explorer's "Open with OpenMind
   * Studio", the `openmind` command). The first folder becomes the workspace, every file opens; the rest is reported.
   */
  async openLaunch(): Promise<void> {
    const request = await this.ipc.launchTake().catch(() => null);
    if (request === null) return;
    if (request.folder !== null) await this.workspace.openFolder(request.folder);
    for (const file of request.files) await this.workspace.openPath(file);
    for (const path of request.missing) {
      this.events.emit("appError", { message: `Couldn't open "${path}": it doesn't exist.` });
    }
    if (request.ignoredFolders.length > 0) {
      this.notice(
        `A window opens one folder: ${request.folder ?? ""} is open; not opened: ${request.ignoredFolders.join(", ")}.`,
      );
    }
  }

  private notice(message: string | null): void {
    if (message !== null) this.events.emit("appNotice", { message });
  }
}

