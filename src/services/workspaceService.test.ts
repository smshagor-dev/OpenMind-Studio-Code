import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { BufferManager } from "./bufferManager";
import { DocumentService } from "./documentService";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { OpenedDocument, PinnedFolderEntry, SessionSnapshot, WorkspaceInfo } from "./ipc";
import { parentFolder, WorkspaceService } from "./workspaceService";

function openedDocFor(path: string): OpenedDocument {
  return { path, content: `content of ${path}`, encoding: "utf8", lineEnding: "lf" };
}

function requireNonNull<T>(value: T | null): T {
  if (value === null) {
    throw new Error("expected a non-null value");
  }
  return value;
}

describe("WorkspaceService", () => {
  let buffers: BufferManager;
  let events: EventBus<AppEvents>;

  beforeEach(() => {
    buffers = new BufferManager();
    events = new EventBus<AppEvents>();
  });

  it("createUntitled adds a tab and makes it active", () => {
    const ipc = createFakeIpc();
    const documents = new DocumentService(ipc, buffers, events);
    const workspace = new WorkspaceService(documents, ipc, events);

    const id = workspace.createUntitled();

    expect(workspace.getState().activeId).toBe(id);
    expect(workspace.getState().tabs).toHaveLength(1);
  });

  it("openPath opens the document, activates it, and persists the session", async () => {
    const ipc = createFakeIpc({
      documentOpen: vi
        .fn()
        .mockImplementation((path: string) => Promise.resolve(openedDocFor(path))),
    });
    const documents = new DocumentService(ipc, buffers, events);
    const workspace = new WorkspaceService(documents, ipc, events);

    const id = await workspace.openPath("a.rs");

    expect(workspace.getState().activeId).toBe(id);
    expect(workspace.getState().tabs.map((tab) => tab.path)).toEqual(["a.rs"]);
    expect(ipc.sessionSave).toHaveBeenCalledWith({ openPaths: ["a.rs"], activePath: "a.rs" });
  });

  it("notifies subscribers when the tab list changes", () => {
    const ipc = createFakeIpc();
    const documents = new DocumentService(ipc, buffers, events);
    const workspace = new WorkspaceService(documents, ipc, events);
    const listener = vi.fn();
    workspace.subscribe(listener);

    workspace.createUntitled();

    expect(listener).toHaveBeenCalled();
  });

  it("recomputes tabs when a document's dirty state changes", () => {
    const ipc = createFakeIpc();
    const documents = new DocumentService(ipc, buffers, events);
    const workspace = new WorkspaceService(documents, ipc, events);
    const id = workspace.createUntitled();

    buffers.setValue(id, "edited");

    expect(workspace.getState().tabs[0]?.dirty).toBe(true);
  });

  it("setActive switches the active tab", () => {
    const ipc = createFakeIpc();
    const documents = new DocumentService(ipc, buffers, events);
    const workspace = new WorkspaceService(documents, ipc, events);
    const first = workspace.createUntitled();
    const second = workspace.createUntitled();

    workspace.setActive(first);

    expect(workspace.getState().activeId).toBe(first);
    expect(second).not.toBe(first);
  });

  it("close removes the tab and falls back to a neighboring tab as active", async () => {
    const ipc = createFakeIpc();
    const documents = new DocumentService(ipc, buffers, events);
    const workspace = new WorkspaceService(documents, ipc, events);
    const first = workspace.createUntitled();
    const second = workspace.createUntitled();

    await workspace.close(second);

    expect(workspace.getState().tabs.map((tab) => tab.id)).toEqual([first]);
    expect(workspace.getState().activeId).toBe(first);
  });

  it("close persists the session with the remaining open paths", async () => {
    const ipc = createFakeIpc({
      documentOpen: vi
        .fn()
        .mockImplementation((path: string) => Promise.resolve(openedDocFor(path))),
    });
    const documents = new DocumentService(ipc, buffers, events);
    const workspace = new WorkspaceService(documents, ipc, events);
    const a = requireNonNull(await workspace.openPath("a.rs"));
    await workspace.openPath("b.rs");

    await workspace.close(a);

    expect(ipc.sessionSave).toHaveBeenLastCalledWith({ openPaths: ["b.rs"], activePath: "b.rs" });
  });

  it("restoreSession reopens the previous tabs and restores the active one", async () => {
    const snapshot: SessionSnapshot = { openPaths: ["a.rs", "b.rs"], activePath: "a.rs" };
    const ipc = createFakeIpc({
      sessionLoad: vi.fn().mockResolvedValue(snapshot),
      documentOpen: vi
        .fn()
        .mockImplementation((path: string) => Promise.resolve(openedDocFor(path))),
    });
    const documents = new DocumentService(ipc, buffers, events);
    const workspace = new WorkspaceService(documents, ipc, events);

    await workspace.restoreSession();

    expect(workspace.getState().tabs.map((tab) => tab.path)).toEqual(["a.rs", "b.rs"]);
    expect(
      workspace.getState().tabs.find((tab) => tab.id === workspace.getState().activeId)?.path,
    ).toBe("a.rs");
  });

  it("openPath emits appError and returns null instead of throwing when the file can't be opened", async () => {
    const ipc = createFakeIpc({
      documentOpen: vi.fn().mockRejectedValue(new Error("not found")),
    });
    const documents = new DocumentService(ipc, buffers, events);
    const workspace = new WorkspaceService(documents, ipc, events);
    const errors: string[] = [];
    events.on("appError", ({ message }) => errors.push(message));

    const id = await workspace.openPath("missing.rs");

    expect(id).toBeNull();
    expect(errors.length).toBe(1);
    expect(workspace.getState().tabs).toHaveLength(0);
  });

  it("restoreSession skips a file that fails to reopen instead of aborting the whole restore", async () => {
    const snapshot: SessionSnapshot = { openPaths: ["missing.rs", "b.rs"], activePath: "b.rs" };
    const ipc = createFakeIpc({
      sessionLoad: vi.fn().mockResolvedValue(snapshot),
      documentOpen: vi.fn().mockImplementation((path: string) => {
        if (path === "missing.rs") return Promise.reject(new Error("not found"));
        return Promise.resolve(openedDocFor(path));
      }),
    });
    const documents = new DocumentService(ipc, buffers, events);
    const workspace = new WorkspaceService(documents, ipc, events);
    const errors: string[] = [];
    events.on("appError", ({ message }) => errors.push(message));

    await workspace.restoreSession();

    expect(workspace.getState().tabs.map((tab) => tab.path)).toEqual(["b.rs"]);
    expect(errors.length).toBe(1);
  });

  it("openFolder records the active workspace and notifies subscribers", async () => {
    const info: WorkspaceInfo = { id: 1, path: "C:/proj", name: "proj" };
    const ipc = createFakeIpc({ workspaceOpenFolder: vi.fn().mockResolvedValue(info) });
    const documents = new DocumentService(ipc, buffers, events);
    const workspace = new WorkspaceService(documents, ipc, events);
    const listener = vi.fn();
    workspace.subscribeWorkspace(listener);

    const result = await workspace.openFolder("C:/proj");

    expect(result).toEqual(info);
    expect(workspace.getActiveWorkspace()).toEqual(info);
    expect(listener).toHaveBeenCalled();
  });

  it("closeFolder clears the active workspace", async () => {
    const info: WorkspaceInfo = { id: 1, path: "C:/proj", name: "proj" };
    const ipc = createFakeIpc({ workspaceOpenFolder: vi.fn().mockResolvedValue(info) });
    const documents = new DocumentService(ipc, buffers, events);
    const workspace = new WorkspaceService(documents, ipc, events);
    await workspace.openFolder("C:/proj");

    await workspace.closeFolder();

    expect(workspace.getActiveWorkspace()).toBeNull();
  });

  it("restoreActiveWorkspace loads and records the previously active workspace", async () => {
    const info: WorkspaceInfo = { id: 1, path: "C:/proj", name: "proj" };
    const ipc = createFakeIpc({ workspaceActiveFolder: vi.fn().mockResolvedValue(info) });
    const documents = new DocumentService(ipc, buffers, events);
    const workspace = new WorkspaceService(documents, ipc, events);

    const result = await workspace.restoreActiveWorkspace();

    expect(result).toEqual(info);
    expect(workspace.getActiveWorkspace()).toEqual(info);
  });

  it("loadRecentFolders returns the folders from IPC", async () => {
    const folders: WorkspaceInfo[] = [{ id: 1, path: "C:/proj", name: "proj" }];
    const ipc = createFakeIpc({ workspaceRecentFolders: vi.fn().mockResolvedValue(folders) });
    const documents = new DocumentService(ipc, buffers, events);
    const workspace = new WorkspaceService(documents, ipc, events);

    expect(await workspace.loadRecentFolders()).toEqual(folders);
  });

  it("pinFolder calls IPC with the path and label, then notifies pinnedFoldersChanged", async () => {
    const ipc = createFakeIpc();
    const documents = new DocumentService(ipc, buffers, events);
    const workspace = new WorkspaceService(documents, ipc, events);
    const listener = vi.fn();
    events.on("pinnedFoldersChanged", listener);

    await workspace.pinFolder("C:/proj", "proj");

    expect(ipc.pinFolder).toHaveBeenCalledWith("C:/proj", "proj");
    expect(listener).toHaveBeenCalled();
  });

  it("unpinFolder calls IPC with the path, then notifies pinnedFoldersChanged", async () => {
    const ipc = createFakeIpc();
    const documents = new DocumentService(ipc, buffers, events);
    const workspace = new WorkspaceService(documents, ipc, events);
    const listener = vi.fn();
    events.on("pinnedFoldersChanged", listener);

    await workspace.unpinFolder("C:/proj");

    expect(ipc.unpinFolder).toHaveBeenCalledWith("C:/proj");
    expect(listener).toHaveBeenCalled();
  });

  it("loadPinnedFolders returns the pinned folders from IPC", async () => {
    const pinned: PinnedFolderEntry[] = [{ path: "C:/proj", label: "proj" }];
    const ipc = createFakeIpc({ listPinnedFolders: vi.fn().mockResolvedValue(pinned) });
    const documents = new DocumentService(ipc, buffers, events);
    const workspace = new WorkspaceService(documents, ipc, events);

    expect(await workspace.loadPinnedFolders()).toEqual(pinned);
  });

  it("loadPinnedFolders emits appError and returns an empty list instead of throwing when IPC fails", async () => {
    const ipc = createFakeIpc({
      listPinnedFolders: vi.fn().mockRejectedValue(new Error("db unavailable")),
    });
    const documents = new DocumentService(ipc, buffers, events);
    const workspace = new WorkspaceService(documents, ipc, events);
    const errors: string[] = [];
    events.on("appError", ({ message }) => errors.push(message));

    expect(await workspace.loadPinnedFolders()).toEqual([]);
    expect(errors.length).toBe(1);
  });

  it("dispose stops reacting to dirty-state changes", () => {
    const ipc = createFakeIpc();
    const documents = new DocumentService(ipc, buffers, events);
    const workspace = new WorkspaceService(documents, ipc, events);
    const id = workspace.createUntitled();
    const listener = vi.fn();
    workspace.subscribe(listener);
    listener.mockClear();

    workspace.dispose();
    buffers.setValue(id, "edited after dispose");

    expect(listener).not.toHaveBeenCalled();
  });
  it("saving an untitled file with no folder open opens the file's folder", async () => {
    const info: WorkspaceInfo = { id: 1, path: "C:\\notes", name: "notes" };
    const workspaceOpenFolder = vi.fn().mockResolvedValue(info);
    const ipc = createFakeIpc({
      saveDocumentDialog: vi.fn().mockResolvedValue("C:\\notes\\a.txt"),
      workspaceOpenFolder,
    });
    const documents = new DocumentService(ipc, buffers, events);
    const workspace = new WorkspaceService(documents, ipc, events);
    const id = workspace.createUntitled();

    await workspace.save(id);

    expect(workspaceOpenFolder).toHaveBeenCalledWith("C:\\notes");
    expect(workspace.getActiveWorkspace()).toEqual(info);
  });

  it("saving an untitled file never replaces an open folder", async () => {
    const info: WorkspaceInfo = { id: 1, path: "C:/proj", name: "proj" };
    const workspaceOpenFolder = vi.fn().mockResolvedValue(info);
    const ipc = createFakeIpc({
      saveDocumentDialog: vi.fn().mockResolvedValue("D:/other/a.txt"),
      workspaceOpenFolder,
    });
    const documents = new DocumentService(ipc, buffers, events);
    const workspace = new WorkspaceService(documents, ipc, events);
    await workspace.openFolder("C:/proj");
    const id = workspace.createUntitled();

    await workspace.saveAs(id);

    expect(workspaceOpenFolder).toHaveBeenCalledTimes(1);
    expect(workspace.getActiveWorkspace()).toEqual(info);
  });

  it("a cancelled save dialog opens no folder", async () => {
    const workspaceOpenFolder = vi.fn();
    const ipc = createFakeIpc({ workspaceOpenFolder });
    const documents = new DocumentService(ipc, buffers, events);
    const workspace = new WorkspaceService(documents, ipc, events);
    const id = workspace.createUntitled();

    await workspace.saveAs(id);

    expect(workspaceOpenFolder).not.toHaveBeenCalled();
  });

  it("parentFolder keeps a drive root", () => {
    expect(parentFolder("C:\\a\\b.txt")).toBe("C:\\a");
    expect(parentFolder("C:\\b.txt")).toBe("C:\\");
    expect(parentFolder("D:/x/y.ts")).toBe("D:/x");
    expect(parentFolder("/home/u/f.py")).toBe("/home/u");
    expect(parentFolder("f.py")).toBeNull();
  });
});


it("shares a single Documents lookup when several operations need a default workspace", async () => {
  const folder = { path: "C:/Users/Student/Documents", name: "Documents" } as WorkspaceInfo;
  const ipc = createFakeIpc({ workspaceActiveFolder: vi.fn(async () => folder) });
  const events = new EventBus<AppEvents>();
  const workspace = new WorkspaceService(new DocumentService(ipc, new BufferManager(), events), ipc, events);
  const changed = vi.fn();
  events.on("workspaceFolderChanged", changed);
  const results = await Promise.all([workspace.ensureWorkspace(), workspace.ensureWorkspace()]);
  expect(results).toEqual([folder, folder]);
  expect(ipc.workspaceActiveFolder).toHaveBeenCalledOnce();
  expect(changed).toHaveBeenCalledOnce();
  expect(await workspace.ensureWorkspace()).toEqual(folder);
  expect(ipc.workspaceActiveFolder).toHaveBeenCalledOnce();
});

it("never replaces an explicitly opened project with the Documents fallback", async () => {
  const folder = { path: "D:/Project", name: "Project" } as WorkspaceInfo;
  const ipc = createFakeIpc({ workspaceOpenFolder: vi.fn(async () => folder) });
  const events = new EventBus<AppEvents>();
  const workspace = new WorkspaceService(new DocumentService(ipc, new BufferManager(), events), ipc, events);
  await workspace.openFolder(folder.path);
  expect(await workspace.ensureWorkspace()).toEqual(folder);
  expect(ipc.workspaceActiveFolder).not.toHaveBeenCalled();
});
