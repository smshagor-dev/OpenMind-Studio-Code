import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { BufferManager } from "./bufferManager";
import { DocumentService } from "./documentService";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import { FileSyncService } from "./fileSyncService";
import { GitService } from "./gitService";
import { GitStashService } from "./gitStashService";
import type { DiskRead, FsChange, IpcClient } from "./ipc";
import { OutputService } from "./outputService";
import { minimalEdit, pathKey, parentOf, sameText } from "./textSync";

// Plain-text files only: no language service has to start in the test.
const PATH = "C:/My Site/notes.txt";

function file(content: string): DiskRead {
  return { state: "file", content, encoding: "utf8", lineEnding: "lf" };
}

interface Rig {
  ipc: IpcClient;
  documents: DocumentService;
  buffers: BufferManager;
  events: EventBus<AppEvents>;
  sync: FileSyncService;
  notices: string[];
  refreshLoaded: ReturnType<typeof vi.fn>;
  disk: { current: DiskRead };
  id: string;
}

async function rig(text = "one\ntwo\n"): Promise<Rig> {
  const disk = { current: file(text) };
  const ipc = createFakeIpc({
    documentOpen: vi
      .fn()
      .mockResolvedValue({ path: PATH, content: text, encoding: "utf8", lineEnding: "lf" }),
    documentRead: vi.fn().mockImplementation(() => Promise.resolve(disk.current)),
  });
  const buffers = new BufferManager();
  const events = new EventBus<AppEvents>();
  const documents = new DocumentService(ipc, buffers, events);
  const id = await documents.openFromPath(PATH);
  const refreshLoaded = vi.fn().mockResolvedValue(0);
  const sync = new FileSyncService(ipc, events, documents, { refreshLoaded } as never, {
    workspacePath: () => "C:/My Site",
    loadedFolders: () => ["C:/My Site"],
  });
  const notices: string[] = [];
  events.on("appNotice", ({ message }) => notices.push(message));
  return {
    ipc,
    documents,
    buffers,
    events,
    sync,
    notices,
    refreshLoaded,
    disk,
    id,
  };
}

const batch = (...changes: FsChange[]) => ({ changes, overflow: false });
const modified = (path: string): FsChange => ({ path, kind: "modified", from: null });

describe("text helpers", () => {
  it("minimalEdit keeps the common start and end", () => {
    expect(minimalEdit("abc", "abc")).toBeNull();
    expect(minimalEdit("one\ntwo\nthree", "one\nTWO\nthree")).toEqual({
      start: 4,
      end: 7,
      text: "TWO",
    });
    expect(minimalEdit("", "new")).toEqual({ start: 0, end: 0, text: "new" });
    expect(minimalEdit("old", "")).toEqual({ start: 0, end: 3, text: "" });
  });

  it("compares text ignoring line endings, and paths ignoring slash style and drive-letter case", () => {
    expect(sameText("a\r\nb", "a\nb")).toBe(true);
    expect(sameText("a\nb", "a\nc")).toBe(false);
    expect(pathKey("C:\\My Site\\A.txt")).toBe(pathKey("c:/my site/a.txt"));
    expect(pathKey("/home/Me/a.txt")).not.toBe(pathKey("/home/me/a.txt"));
    expect(parentOf("C:\\My Site\\src\\a.txt")).toBe("C:\\My Site\\src");
    expect(parentOf("a.txt")).toBe("");
  });
});

describe("an open file changes on disk", () => {
  let r: Rig;
  beforeEach(async () => {
    r = await rig();
  });

  it("a clean document is reloaded, with one notice, and stays clean", async () => {
    r.disk.current = file("one\nTWO\nthree\n");
    const result = await r.sync.handleBatch(batch(modified("C:\\My Site\\notes.txt")));
    expect(result.reloaded).toBe(1);
    expect(r.documents.contentOf(r.id)).toBe("one\nTWO\nthree\n");
    expect(r.documents.isDirty(r.id)).toBe(false);
    expect(r.documents.externalState(r.id)).toBe("none");
    expect(r.notices).toEqual(["notes.txt reloaded from disk."]);
  });

  it("our own save (disk equals what we saved) does nothing", async () => {
    const result = await r.sync.handleBatch(batch(modified(PATH)));
    expect(result).toEqual({ reloaded: 0, conflicts: 0, deleted: 0 });
    expect(r.notices).toEqual([]);
  });

  it("a document with unsaved edits is never overwritten: it is marked changed, with one warning", async () => {
    r.buffers.setValue(r.id, "my unsaved edit\n");
    r.disk.current = file("changed elsewhere\n");
    const result = await r.sync.handleBatch(batch(modified(PATH)));
    expect(result.conflicts).toBe(1);
    expect(r.documents.contentOf(r.id)).toBe("my unsaved edit\n");
    expect(r.documents.externalState(r.id)).toBe("changed");
    expect(r.documents.snapshot(r.id).external).toBe("changed");
    expect(r.notices).toEqual(["notes.txt: File changed on disk while you have unsaved changes."]);

    // The same change again does not repeat the warning.
    await r.sync.handleBatch(batch(modified(PATH)));
    expect(r.notices).toHaveLength(1);
  });

  it("Compare shows the disk text and the edits; Keep My Changes keeps the edits and takes the disk as the base", async () => {
    r.buffers.setValue(r.id, "mine\n");
    r.disk.current = file("theirs\n");
    await r.sync.handleBatch(batch(modified(PATH)));

    expect(r.sync.compare(r.id)).toBe(true);
    expect(r.sync.getState().compare).toMatchObject({
      disk: "theirs\n",
      buffer: "mine\n",
      title: "notes.txt",
    });
    r.sync.closeCompare();
    expect(r.sync.getState().compare).toBeNull();

    r.sync.keepMine(r.id);
    expect(r.documents.externalState(r.id)).toBe("none");
    expect(r.documents.contentOf(r.id)).toBe("mine\n");
    expect(r.documents.isDirty(r.id)).toBe(true);
    // Nothing changed on disk since: no new warning.
    await r.sync.handleBatch(batch(modified(PATH)));
    expect(r.documents.externalState(r.id)).toBe("none");
  });

  it("Reload from Disk drops the edits on purpose", async () => {
    r.buffers.setValue(r.id, "mine\n");
    r.disk.current = file("theirs\n");
    await r.sync.handleBatch(batch(modified(PATH)));
    expect(await r.sync.reloadFromDisk(r.id)).toBe(true);
    expect(r.documents.contentOf(r.id)).toBe("theirs\n");
    expect(r.documents.isDirty(r.id)).toBe(false);
    expect(r.documents.externalState(r.id)).toBe("none");
  });

  it("nothing is ever written to disk by a sync", async () => {
    r.buffers.setValue(r.id, "mine\n");
    r.disk.current = file("theirs\n");
    await r.sync.handleBatch(batch(modified(PATH)));
    await r.sync.syncAll();
    expect(r.ipc.documentSave).not.toHaveBeenCalled();
  });

  it("a deleted file is marked deleted, keeps its text, and is announced once", async () => {
    r.disk.current = { state: "missing" };
    const removed: FsChange = { path: PATH, kind: "removed", from: null };
    await r.sync.handleBatch(batch(removed));
    expect(r.documents.externalState(r.id)).toBe("deleted");
    expect(r.documents.contentOf(r.id)).toBe("one\ntwo\n");
    expect(r.notices).toEqual(["notes.txt was deleted on disk."]);
    await r.sync.handleBatch(batch(removed));
    expect(r.notices).toHaveLength(1);
    // Saving writes it back and clears the state.
    await r.documents.save(r.id);
    expect(r.documents.externalState(r.id)).toBe("none");
  });

  it("a file that comes back is picked up again", async () => {
    r.disk.current = { state: "missing" };
    await r.sync.handleBatch(batch({ path: PATH, kind: "removed", from: null }));
    r.disk.current = file("one\ntwo\n");
    await r.sync.handleBatch(batch({ path: PATH, kind: "created", from: null }));
    expect(r.documents.externalState(r.id)).toBe("none");
    r.disk.current = { state: "missing" };
    await r.sync.handleBatch(batch({ path: PATH, kind: "removed", from: null }));
    r.disk.current = file("brand new\n");
    await r.sync.handleBatch(batch({ path: PATH, kind: "created", from: null }));
    expect(r.documents.contentOf(r.id)).toBe("brand new\n");
    expect(r.documents.externalState(r.id)).toBe("none");
  });

  it("a rename or move makes the tab follow the file", async () => {
    const newPath = "C:/My Site/renamed notes.txt";
    r.disk.current = file("one\ntwo\n");
    await r.sync.handleBatch(batch({ path: newPath, kind: "renamed", from: PATH }));
    expect(r.documents.snapshot(r.id).path).toBe(newPath);
    expect(r.documents.snapshot(r.id).title).toBe("renamed notes.txt");
    expect(r.notices[0]).toContain("renamed or moved");
    expect(r.documents.idForPath("C:\\My Site\\Renamed Notes.txt")).toBe(r.id);
  });

  it("an unreadable file (locked, binary) changes nothing and says nothing", async () => {
    r.disk.current = { state: "unreadable", reason: "locked" };
    const result = await r.sync.handleBatch(batch(modified(PATH)));
    expect(result).toEqual({ reloaded: 0, conflicts: 0, deleted: 0 });
    expect(r.notices).toEqual([]);
    expect(r.documents.externalState(r.id)).toBe("none");
  });
});

describe("what is not looked at", () => {
  it("changes to files that are not open read nothing", async () => {
    const r = await rig();
    vi.mocked(r.ipc.documentRead).mockClear();
    await r.sync.handleBatch(
      batch(modified("C:/My Site/other.txt"), modified("C:/My Site/src/x.php")),
    );
    expect(r.ipc.documentRead).not.toHaveBeenCalled();
  });

  it("paths under ignored folders never reach the frontend, and a stray one is not an open file", async () => {
    const r = await rig();
    vi.mocked(r.ipc.documentRead).mockClear();
    await r.sync.handleBatch(batch(modified("C:/My Site/node_modules/pkg/index.js")));
    expect(r.ipc.documentRead).not.toHaveBeenCalled();
  });

  it("an empty batch does nothing at all", async () => {
    const r = await rig();
    await r.sync.handleBatch(batch());
    expect(r.refreshLoaded).not.toHaveBeenCalled();
  });
});

describe("the Explorer follows", () => {
  it("created and removed files refresh their folders (both slash styles); plain edits do not", async () => {
    const r = await rig();
    await r.sync.handleBatch(
      batch(
        { path: "C:\\My Site\\src\\new file.php", kind: "created", from: null },
        { path: "C:\\My Site\\old.txt", kind: "removed", from: null },
        modified("C:\\My Site\\edited.txt"),
      ),
    );
    const folders = r.refreshLoaded.mock.calls[0]?.[0] as string[];
    expect([...folders].sort()).toEqual(["C:\\My Site", "C:\\My Site\\src"].sort());

    r.refreshLoaded.mockClear();
    await r.sync.handleBatch(batch(modified("C:/My Site/edited.txt")));
    expect(r.refreshLoaded).not.toHaveBeenCalled();
  });

  it("a renamed file refreshes both its old and new folders", async () => {
    const r = await rig();
    await r.sync.handleBatch(
      batch({ path: "C:/My Site/b/moved.txt", kind: "renamed", from: "C:/My Site/a/moved.txt" }),
    );
    const folders = r.refreshLoaded.mock.calls[0]?.[0] as string[];
    expect(folders).toEqual(expect.arrayContaining(["C:/My Site/a", "C:/My Site/b"]));
  });

  it("an overflow batch re-checks every open file and every loaded folder", async () => {
    const r = await rig();
    r.disk.current = file("changed by a big checkout\n");
    await r.sync.handleBatch({ changes: [], overflow: true });
    expect(r.documents.contentOf(r.id)).toBe("changed by a big checkout\n");
    expect(r.refreshLoaded).toHaveBeenCalledWith(["C:/My Site"]);
  });
});

describe("Git operations refresh the editors", () => {
  it("afterGitOperation reloads clean buffers, reports it once and refreshes the Explorer", async () => {
    const r = await rig();
    r.disk.current = file("restored by git\n");
    const result = await r.sync.afterGitOperation();
    expect(result.reloaded).toBe(1);
    expect(r.documents.contentOf(r.id)).toBe("restored by git\n");
    expect(r.notices).toEqual(["Git operation changed files; editor buffers refreshed."]);
    expect(r.refreshLoaded).toHaveBeenCalledWith(["C:/My Site"]);
  });

  it("a Git operation that changes nothing open stays silent", async () => {
    const r = await rig();
    await r.sync.afterGitOperation();
    expect(r.notices).toEqual([]);
  });

  it("stash apply reloads an open clean file; on a dirty one it warns and keeps the edits", async () => {
    const clean = await rig();
    const output = new OutputService();
    const git = new GitService(clean.ipc, output);
    const stash = new GitStashService(
      git,
      clean.events,
      () => clean.sync.afterGitOperation().then(() => undefined),
      () => ({
        tracked: 1,
        untracked: 0,
      }),
    );
    clean.disk.current = file("after stash apply\n");
    await stash.apply(0);
    expect(clean.ipc.gitStashApply).toHaveBeenCalledWith(0);
    expect(clean.documents.contentOf(clean.id)).toBe("after stash apply\n");
    expect(clean.notices).toContain("Git operation changed files; editor buffers refreshed.");

    const dirty = await rig();
    const dirtyStash = new GitStashService(
      new GitService(dirty.ipc, output),
      dirty.events,
      () => dirty.sync.afterGitOperation().then(() => undefined),
      () => ({ tracked: 1, untracked: 0 }),
    );
    dirty.buffers.setValue(dirty.id, "unsaved\n");
    dirty.disk.current = file("stash content\n");
    await dirtyStash.pop(0);
    expect(dirty.documents.contentOf(dirty.id)).toBe("unsaved\n");
    expect(dirty.documents.externalState(dirty.id)).toBe("changed");
    expect(dirty.notices.join("\n")).toContain(
      "File changed on disk while you have unsaved changes.",
    );
  });
});

describe("the watcher lifecycle", () => {
  it("starts on the open workspace, restarts when it changes and stops when it closes", async () => {
    const r = await rig();
    let workspace: string | null = "C:/My Site";
    const sync = new FileSyncService(
      r.ipc,
      r.events,
      r.documents,
      { refreshLoaded: vi.fn() } as never,
      {
        workspacePath: () => workspace,
        loadedFolders: () => [],
      },
    );
    await sync.initialize();
    expect(r.ipc.fileWatchStart).toHaveBeenCalledWith("C:/My Site");
    workspace = "C:/Other Site";
    r.events.emit("workspaceFolderChanged", { workspace: null });
    await vi.waitFor(() => {
      expect(r.ipc.fileWatchStart).toHaveBeenCalledWith("C:/Other Site");
    });
    workspace = null;
    r.events.emit("workspaceFolderChanged", { workspace: null });
    await vi.waitFor(() => {
      expect(r.ipc.fileWatchStop).toHaveBeenCalled();
    });
    sync.dispose();
  });

  it("batches from the backend are handled in order", async () => {
    const r = await rig();
    let deliver: (batch: { changes: FsChange[]; overflow: boolean }) => void = () => undefined;
    vi.mocked(r.ipc.onFsChanged).mockImplementation((handler) => {
      deliver = handler;
      return Promise.resolve(() => undefined);
    });
    await r.sync.initialize();
    r.disk.current = file("from a batch\n");
    deliver(batch(modified(PATH)));
    await vi.waitFor(() => {
      expect(r.documents.contentOf(r.id)).toBe("from a batch\n");
    });
    r.sync.dispose();
  });
});
