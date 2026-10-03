import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PY, TXT, rig, type Rig } from "../testUtils/lspFixtures";
import { fileProblem } from "./lspAvailability";
import { LSP_DISABLED_REASON, SYNC_DELAY_MS } from "./lspService";

describe("LspService: the lsp.enabled setting", () => {
  it("with language servers off no file is told to a server and every action says why not", async () => {
    const r = await rig();
    r.enabled.current = false;

    const id = await r.documents.openFromPath(PY);

    expect(r.ipc.lspSyncDocument).not.toHaveBeenCalled();
    expect(r.lsp.available("definition", id)).toEqual({
      enabled: false,
      reason: LSP_DISABLED_REASON,
    });
    r.lsp.dispose();
  });

  it("turning them off stops the running servers and forgets the open files", async () => {
    const r = await rig();
    const id = await r.documents.openFromPath(PY);
    await vi.waitFor(() => {
      expect(r.ipc.lspSyncDocument).toHaveBeenCalledTimes(1);
    });
    r.enabled.current = false;

    await r.lsp.applyEnabled();

    expect(r.ipc.lspStopAll).toHaveBeenCalledTimes(1);
    expect(r.ipc.lspCloseDocument).toHaveBeenCalledWith(PY);
    expect(r.lsp.available("definition", id).enabled).toBe(false);
    r.lsp.dispose();
  });

  it("turning them back on tells the servers about the files that are open", async () => {
    const r = await rig();
    r.enabled.current = false;
    await r.documents.openFromPath(PY);
    expect(r.ipc.lspSyncDocument).not.toHaveBeenCalled();

    r.enabled.current = true;
    await r.lsp.applyEnabled();

    await vi.waitFor(() => {
      expect(r.ipc.lspSyncDocument).toHaveBeenCalledWith(PY, "x = 1\n");
    });
    r.lsp.dispose();
  });
});

describe("LspService: keeping servers told about documents", () => {
  let r: Rig;
  beforeEach(async () => {
    r = await rig();
  });
  afterEach(() => {
    r.lsp.dispose();
    vi.useRealTimers();
  });

  it("opening a supported file gives the server its text; other files are left alone", async () => {
    await r.documents.openFromPath(PY);
    await r.documents.openFromPath(TXT);
    expect(r.ipc.lspSyncDocument).toHaveBeenCalledTimes(1);
    expect(r.ipc.lspSyncDocument).toHaveBeenCalledWith(PY, "x = 1\n");
  });

  it("closing the folder re-asks for every open file and hands views a new snapshot, so the status bar redraws", async () => {
    const id = await r.documents.openFromPath(PY);
    r.active.current = id;
    await vi.waitFor(() => {
      expect(r.lsp.activeFileStatus().outcome?.state).toBe("ready");
    });
    const before = r.lsp.getState();
    r.outcome.current = { state: "noWorkspace" };
    r.events.emit("workspaceFolderChanged", { workspace: null });
    await vi.waitFor(() => {
      expect(fileProblem(r.lsp.activeFileStatus())).toBe("Open a folder to use language servers.");
    });
    // A file with no folder is never "outside the open folder".
    expect(fileProblem(r.lsp.activeFileStatus())).not.toContain("outside");
    expect(r.lsp.getState()).not.toBe(before);
  });

  it("a file's new outcome alone (no status re-read) still gives views a new snapshot", async () => {
    r.outcome.current = { state: "noWorkspace" };
    const before = r.lsp.getState();
    const reads = vi.mocked(r.ipc.lspStatus).mock.calls.length;
    const id = await r.documents.openFromPath(PY);
    await vi.waitFor(() => {
      expect(r.lsp.fileStatus(id).outcome?.state).toBe("noWorkspace");
    });
    expect(r.ipc.lspStatus).toHaveBeenCalledTimes(reads); // the status isn't read again
    expect(r.lsp.getState()).not.toBe(before);
  });

  it("edits are sent after a short delay, one message for a burst; flush sends at once", async () => {
    const id = await r.documents.openFromPath(PY);
    await vi.waitFor(() => {
      expect(r.ipc.lspSyncDocument).toHaveBeenCalledTimes(1);
    });
    vi.useFakeTimers();
    r.buffers.setValue(id, "x = 2\n");
    r.buffers.setValue(id, "x = 3\n");
    expect(r.ipc.lspSyncDocument).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SYNC_DELAY_MS + 10);
    expect(r.ipc.lspSyncDocument).toHaveBeenCalledTimes(2);
    expect(r.ipc.lspSyncDocument).toHaveBeenLastCalledWith(PY, "x = 3\n");

    r.buffers.setValue(id, "x = 4\n");
    await r.lsp.flush(id);
    expect(r.ipc.lspSyncDocument).toHaveBeenLastCalledWith(PY, "x = 4\n");
  });

  it("saving tells the server; closing the document closes it there", async () => {
    const id = await r.documents.openFromPath(PY);
    r.buffers.setValue(id, "x = 2\n");
    await r.documents.save(id);
    expect(r.ipc.lspSaveDocument).toHaveBeenCalledWith(PY);
    r.documents.close(id);
    expect(r.ipc.lspCloseDocument).toHaveBeenCalledWith(PY);
  });

  it("a clean file reloaded from disk is announced as saved, so save-only servers check it again", async () => {
    const id = await r.documents.openFromPath(PY);
    await vi.waitFor(() => {
      expect(r.ipc.lspSyncDocument).toHaveBeenCalledTimes(1);
    });
    vi.mocked(r.ipc.documentRead).mockResolvedValue({
      state: "file",
      content: "x = 9\n",
      encoding: "utf8",
      lineEnding: "lf",
    });
    expect(await r.documents.checkDisk(id)).toBe("reloaded");
    await vi.waitFor(() => {
      expect(r.ipc.lspSaveDocument).toHaveBeenCalledWith(PY);
    });
    expect(r.ipc.lspSyncDocument).toHaveBeenLastCalledWith(PY, "x = 9\n");
  });

  it("unsaved edits that conflict with the disk are never announced as saved", async () => {
    const id = await r.documents.openFromPath(PY);
    await vi.waitFor(() => {
      expect(r.ipc.lspSyncDocument).toHaveBeenCalledTimes(1);
    });
    r.buffers.setValue(id, "x = 2  # mine\n");
    vi.mocked(r.ipc.documentRead).mockResolvedValue({
      state: "file",
      content: "x = 9\n",
      encoding: "utf8",
      lineEnding: "lf",
    });
    expect(await r.documents.checkDisk(id)).toBe("conflict");
    await r.lsp.flush(id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(r.ipc.lspSaveDocument).not.toHaveBeenCalled();
  });

  it("a file deleted on disk is closed in the server, and reopened when it is back", async () => {
    const id = await r.documents.openFromPath(PY);
    await vi.waitFor(() => {
      expect(r.ipc.lspSyncDocument).toHaveBeenCalledTimes(1);
    });
    await r.documents.checkDisk(id); // documentRead says "missing"
    expect(r.documents.externalState(id)).toBe("deleted");
    expect(r.ipc.lspCloseDocument).toHaveBeenCalledWith(PY);

    vi.mocked(r.ipc.documentRead).mockResolvedValue({
      state: "file",
      content: "x = 1\n",
      encoding: "utf8",
      lineEnding: "lf",
    });
    await r.documents.checkDisk(id);
    await vi.waitFor(() => {
      expect(r.ipc.lspSyncDocument).toHaveBeenCalledTimes(2);
    });
  });

  it("a file replaced on disk while clean reaches the server with the new text", async () => {
    const id = await r.documents.openFromPath(PY);
    await vi.waitFor(() => {
      expect(r.ipc.lspSyncDocument).toHaveBeenCalledTimes(1);
    });
    vi.mocked(r.ipc.documentRead).mockResolvedValue({
      state: "file",
      content: "y = 9\n",
      encoding: "utf8",
      lineEnding: "lf",
    });
    expect(await r.documents.checkDisk(id)).toBe("reloaded");
    await r.lsp.flush(id);
    await vi.waitFor(() => {
      expect(r.ipc.lspSyncDocument).toHaveBeenLastCalledWith(PY, "y = 9\n");
    });
  });

  it("a dirty file that changed on disk keeps sending the editor's text, never the disk's", async () => {
    const id = await r.documents.openFromPath(PY);
    r.buffers.setValue(id, "mine = 1\n");
    vi.mocked(r.ipc.documentRead).mockResolvedValue({
      state: "file",
      content: "theirs = 1\n",
      encoding: "utf8",
      lineEnding: "lf",
    });
    expect(await r.documents.checkDisk(id)).toBe("conflict");
    await r.lsp.flush(id);
    await vi.waitFor(() => {
      expect(r.ipc.lspSyncDocument).toHaveBeenLastCalledWith(PY, "mine = 1\n");
    });
  });

  it("a workspace change stops the servers and tells them about the open files again", async () => {
    await r.documents.openFromPath(PY);
    await vi.waitFor(() => {
      expect(r.ipc.lspSyncDocument).toHaveBeenCalledTimes(1);
    });
    r.events.emit("workspaceFolderChanged", { workspace: null });
    await vi.waitFor(() => {
      expect(r.ipc.lspStopAll).toHaveBeenCalled();
      expect(r.ipc.lspSyncDocument).toHaveBeenCalledTimes(2);
    });
  });
});
