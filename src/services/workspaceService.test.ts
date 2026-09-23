import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { BufferManager } from "./bufferManager";
import { DocumentService } from "./documentService";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { OpenedDocument, SessionSnapshot, WorkspaceInfo } from "./ipc";
import { WorkspaceService } from "./workspaceService";

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
});
