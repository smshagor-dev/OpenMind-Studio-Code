import { beforeEach, describe, expect, it, vi } from "vitest";

import { BufferManager } from "./bufferManager";
import { DocumentService } from "./documentService";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { IpcClient, OpenedDocument, SessionSnapshot } from "./ipc";
import { WorkspaceService } from "./workspaceService";

function createFakeIpc(overrides: Partial<IpcClient> = {}): IpcClient {
  return {
    openDocumentDialog: vi.fn().mockResolvedValue(null),
    saveDocumentDialog: vi.fn().mockResolvedValue(null),
    documentOpen: vi.fn(),
    documentSave: vi.fn().mockResolvedValue(undefined),
    recentFilesList: vi.fn().mockResolvedValue([]),
    recentFilesClear: vi.fn().mockResolvedValue(undefined),
    sessionLoad: vi.fn().mockResolvedValue({ openPaths: [], activePath: null }),
    sessionSave: vi.fn().mockResolvedValue(undefined),
    themeGet: vi.fn().mockResolvedValue("dark"),
    themeSet: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function openedDocFor(path: string): OpenedDocument {
  return { path, content: `content of ${path}`, encoding: "utf8", lineEnding: "lf" };
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
      documentOpen: vi.fn().mockImplementation((path: string) => Promise.resolve(openedDocFor(path))),
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
      documentOpen: vi.fn().mockImplementation((path: string) => Promise.resolve(openedDocFor(path))),
    });
    const documents = new DocumentService(ipc, buffers, events);
    const workspace = new WorkspaceService(documents, ipc, events);
    const a = await workspace.openPath("a.rs");
    await workspace.openPath("b.rs");

    await workspace.close(a);

    expect(ipc.sessionSave).toHaveBeenLastCalledWith({ openPaths: ["b.rs"], activePath: "b.rs" });
  });

  it("restoreSession reopens the previous tabs and restores the active one", async () => {
    const snapshot: SessionSnapshot = { openPaths: ["a.rs", "b.rs"], activePath: "a.rs" };
    const ipc = createFakeIpc({
      sessionLoad: vi.fn().mockResolvedValue(snapshot),
      documentOpen: vi.fn().mockImplementation((path: string) => Promise.resolve(openedDocFor(path))),
    });
    const documents = new DocumentService(ipc, buffers, events);
    const workspace = new WorkspaceService(documents, ipc, events);

    await workspace.restoreSession();

    expect(workspace.getState().tabs.map((tab) => tab.path)).toEqual(["a.rs", "b.rs"]);
    expect(workspace.getState().tabs.find((tab) => tab.id === workspace.getState().activeId)?.path).toBe(
      "a.rs",
    );
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
