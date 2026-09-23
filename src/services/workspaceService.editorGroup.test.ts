import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { BufferManager } from "./bufferManager";
import { DocumentService } from "./documentService";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { IpcClient, OpenedDocument } from "./ipc";
import { WorkspaceService } from "./workspaceService";

function openedDocFor(path: string): OpenedDocument {
  return { path, content: `content of ${path}`, encoding: "utf8", lineEnding: "lf" };
}

describe("WorkspaceService editor-group operations", () => {
  let buffers: BufferManager;
  let events: EventBus<AppEvents>;
  let ipc: IpcClient;
  let workspace: WorkspaceService;

  beforeEach(() => {
    buffers = new BufferManager();
    events = new EventBus<AppEvents>();
    ipc = createFakeIpc({
      documentOpen: vi
        .fn()
        .mockImplementation((path: string) => Promise.resolve(openedDocFor(path))),
    });
    workspace = new WorkspaceService(new DocumentService(ipc, buffers, events), ipc, events);
  });

  it("cycleActive moves forward and backward with wrap-around", async () => {
    const a = await workspace.openPath("a.rs");
    const b = await workspace.openPath("b.rs");

    workspace.cycleActive(1);
    expect(workspace.getState().activeId).toBe(a);
    workspace.cycleActive(-1);
    expect(workspace.getState().activeId).toBe(b);
  });

  it("closeAll closes every tab and persists an empty session", async () => {
    await workspace.openPath("a.rs");
    await workspace.openPath("b.rs");

    await workspace.closeAll();

    expect(workspace.getState()).toEqual({ tabs: [], activeId: null });
    expect(ipc.sessionSave).toHaveBeenLastCalledWith({ openPaths: [], activePath: null });
  });

  it("reopenClosed reopens the most recently closed file", async () => {
    const a = await workspace.openPath("a.rs");
    await workspace.openPath("b.rs");
    expect(workspace.canReopenClosed()).toBe(false);

    await workspace.close(a ?? "");
    expect(workspace.canReopenClosed()).toBe(true);
    await workspace.reopenClosed();

    expect(workspace.getState().tabs.map((tab) => tab.path)).toEqual(["b.rs", "a.rs"]);
    expect(workspace.canReopenClosed()).toBe(false);
  });

  it("reopenClosed never remembers untitled tabs", async () => {
    const id = workspace.createUntitled();

    await workspace.close(id);

    expect(workspace.canReopenClosed()).toBe(false);
  });

  it("saveAll saves only dirty tabs", async () => {
    const a = await workspace.openPath("a.rs");
    await workspace.openPath("b.rs");
    buffers.setValue(a ?? "", "edited");

    await workspace.saveAll();

    expect(ipc.documentSave).toHaveBeenCalledTimes(1);
    expect(ipc.documentSave).toHaveBeenCalledWith("a.rs", "edited", "utf8");
  });

  it("revert restores the saved content and clears dirty state", async () => {
    const a = (await workspace.openPath("a.rs")) ?? "";
    buffers.setValue(a, "edited");
    expect(workspace.getState().tabs[0]?.dirty).toBe(true);

    workspace.revert(a);

    expect(buffers.getValue(a)).toBe("content of a.rs");
    expect(workspace.getState().tabs[0]?.dirty).toBe(false);
  });
});
