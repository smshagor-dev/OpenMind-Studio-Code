import { describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { droppedOutside, EditorWindowService, moveToWindowBlocker } from "./editorWindowService";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { EditorTabView, WorkspaceService } from "./workspaceService";

function tab(path: string | null, extra: Partial<EditorTabView> = {}): EditorTabView {
  return {
    id: "doc-1",
    docId: "doc-1",
    kind: "text",
    preview: false,
    groupId: "group-1",
    path,
    title: path?.split("/").pop() ?? "Untitled-1",
    dirty: false,
    encoding: "utf8",
    lineEnding: "lf",
    external: "none",
    ...extra,
  };
}

function rig(tabs: EditorTabView[], ipcOverrides = {}) {
  const ipc = createFakeIpc(ipcOverrides);
  const events = new EventBus<AppEvents>();
  const notices: string[] = [];
  const errors: string[] = [];
  events.on("appNotice", ({ message }) => notices.push(message));
  events.on("appError", ({ message }) => errors.push(message));
  const closeTab = vi.fn().mockResolvedValue(undefined);
  const openPath = vi.fn().mockResolvedValue(undefined);
  const workspace = {
    getState: () => ({
      groups: [{ id: "group-1", tabs, activeTabId: tabs[0]?.id ?? null, locked: false }],
      activeGroupId: "group-1",
    }),
    closeTab,
    openPath,
  } as unknown as WorkspaceService;
  return {
    ipc,
    workspace: { closeTab, openPath },
    notices,
    errors,
    service: new EditorWindowService(ipc, workspace, events),
  };
}

describe("EditorWindowService", () => {
  it("moves a saved file into a new window at the drop point and closes it here", async () => {
    const r = rig([tab("C:/site/index.php")]);

    expect(await r.service.moveToNewWindow("group-1", "doc-1", { x: 900, y: 300 })).toBe(true);

    expect(r.ipc.windowNew).toHaveBeenCalledWith({ path: "C:/site/index.php", x: 780, y: 288 });
    expect(r.workspace.closeTab).toHaveBeenCalledWith("group-1", "doc-1");
  });

  it("keeps an unsaved or untitled tab here and says why", async () => {
    for (const blocked of [tab("C:/a.py", { dirty: true }), tab(null)]) {
      const r = rig([blocked]);
      expect(await r.service.moveToNewWindow("group-1", "doc-1")).toBe(false);
      expect(r.ipc.windowNew).not.toHaveBeenCalled();
      expect(r.workspace.closeTab).not.toHaveBeenCalled();
      expect(r.notices[0]).toMatch(/^Save /);
    }
    expect(moveToWindowBlocker(tab("C:/r.md", { kind: "markdownPreview" }))).toMatch(/Only/);
  });

  it("leaves the tab open when the window can't be created", async () => {
    const r = rig([tab("C:/a.py")], { windowNew: vi.fn().mockRejectedValue("no webview") });
    expect(await r.service.moveToNewWindow("group-1", "doc-1")).toBe(false);
    expect(r.workspace.closeTab).not.toHaveBeenCalled();
    expect(r.errors[0]).toContain("no webview");
  });

  it("moves the active tab by command, and a new window opens its pending file once", async () => {
    const r = rig([tab("C:/a.py")], {
      windowTakePendingOpen: vi.fn().mockResolvedValue("C:/a.py"),
    });
    expect(await r.service.moveActiveToNewWindow()).toBe(true);
    expect(r.ipc.windowNew).toHaveBeenCalledWith({ path: "C:/a.py", x: undefined, y: undefined });

    await r.service.openPending();
    expect(r.workspace.openPath).toHaveBeenCalledWith("C:/a.py");
  });

  it("an ordinary window has no pending file", async () => {
    const r = rig([]);
    await r.service.openPending();
    expect(r.workspace.openPath).not.toHaveBeenCalled();
  });

  it("knows a drag let go outside the window", () => {
    const viewport = { width: 1280, height: 800 };
    expect(droppedOutside({ x: 400, y: 300 }, viewport)).toBe(false);
    expect(droppedOutside({ x: -5, y: 300 }, viewport)).toBe(true);
    expect(droppedOutside({ x: 400, y: 900 }, viewport)).toBe(true);
    expect(droppedOutside({ x: 1300, y: 10 }, viewport)).toBe(true);
  });
});

describe("EditorWindowService.openLaunch (OpenMindStudio.exe <folder|file ...>)", () => {
  function launchRig(request: unknown) {
    const ipc = createFakeIpc({ launchTake: vi.fn().mockResolvedValue(request) });
    const events = new EventBus<AppEvents>();
    const notices: string[] = [];
    const errors: string[] = [];
    events.on("appNotice", ({ message }) => notices.push(message));
    events.on("appError", ({ message }) => errors.push(message));
    const order: string[] = [];
    const workspace = {
      openFolder: vi.fn((path: string) => {
        order.push(`folder ${path}`);
        return Promise.resolve(null);
      }),
      openPath: vi.fn((path: string) => {
        order.push(`file ${path}`);
        return Promise.resolve(null);
      }),
    } as unknown as WorkspaceService;
    return { service: new EditorWindowService(ipc, workspace, events), order, notices, errors };
  }

  it("opens the folder first, then every file; missing paths and extra folders are reported", async () => {
    const r = launchRig({
      folder: "C:\\Projects\\My Site",
      files: ["C:\\Projects\\My Site\\read me.md", "C:\\notes.txt"],
      ignoredFolders: ["C:\\Other"],
      missing: ["C:\\gone.txt"],
    });
    await r.service.openLaunch();
    expect(r.order).toEqual([
      "folder C:\\Projects\\My Site",
      "file C:\\Projects\\My Site\\read me.md",
      "file C:\\notes.txt",
    ]);
    expect(r.errors).toEqual(['Couldn\'t open "C:\\gone.txt": it doesn\'t exist.']);
    expect(r.notices[0]).toContain("C:\\Other");
  });

  it("does nothing without a request (another window, or no arguments)", async () => {
    const r = launchRig(null);
    await r.service.openLaunch();
    expect(r.order).toEqual([]);
    expect(r.errors).toEqual([]);
  });
});
