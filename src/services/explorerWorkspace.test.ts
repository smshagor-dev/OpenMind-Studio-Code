import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { BufferManager } from "./bufferManager";
import { DocumentService } from "./documentService";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import { ExplorerService } from "./explorerService";
import { FileSyncService } from "./fileSyncService";
import { FileSystemService } from "./fileSystemService";
import type { DirEntryInfo, DiskRead, FsChange } from "./ipc";

/**
 * The Explorer, the open documents and the watcher together, over an in-memory disk that behaves like the Rust
 * commands (create/rename/move/delete answer with the new path). Only Python, Rust and plain-text files are opened: no
 * Monaco language worker has to start in the test.
 */
const ROOT = "C:/Projects/Demo";

class MemoryDisk {
  /** path -> file content (`null` = folder). */
  readonly entries = new Map<string, string | null>([[ROOT, null]]);

  readDir(dir: string): DirEntryInfo[] {
    if (this.entries.get(dir) !== null) throw new Error(`${dir} is not a folder`);
    return [...this.entries.keys()]
      .filter((path) => parentOf(path) === dir)
      .sort()
      .map((path) => ({
        path,
        name: path.slice(dir.length + 1),
        isDir: this.entries.get(path) === null,
        isSymlink: false,
      }));
  }

  create(parent: string, name: string, folder: boolean): string {
    let path = parent;
    const segments = name.split(/[\\/]/);
    segments.forEach((segment, index) => {
      path = `${path}/${segment}`;
      const last = index === segments.length - 1;
      if (last && this.entries.has(path)) throw new Error(`${path} already exists`);
      if (!this.entries.has(path)) this.entries.set(path, last && !folder ? "" : null);
    });
    return path;
  }

  moveTree(from: string, to: string): string {
    for (const [path, content] of [...this.entries]) {
      if (path === from || path.startsWith(`${from}/`)) {
        this.entries.delete(path);
        this.entries.set(to + path.slice(from.length), content);
      }
    }
    return to;
  }

  remove(target: string): void {
    for (const path of [...this.entries.keys()]) {
      if (path === target || path.startsWith(`${target}/`)) this.entries.delete(path);
    }
  }

  read(path: string): DiskRead {
    const content = this.entries.get(path);
    if (content === undefined || content === null) return { state: "missing" };
    return { state: "file", content, encoding: "utf8", lineEnding: "lf" };
  }
}

function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

function rig() {
  const disk = new MemoryDisk();
  const ipc = createFakeIpc({
    fsReadDir: vi.fn((dir: string) => Promise.resolve(disk.readDir(dir))),
    fsCreateFile: vi.fn((_root: string, parent: string, name: string) => Promise.resolve(disk.create(parent, name, false))),
    fsCreateFolder: vi.fn((_root: string, parent: string, name: string) => Promise.resolve(disk.create(parent, name, true))),
    fsRename: vi.fn((_root: string, path: string, name: string) => Promise.resolve(disk.moveTree(path, `${parentOf(path)}/${name}`))),
    fsMove: vi.fn((_root: string, source: string, dest: string) =>
      Promise.resolve(disk.moveTree(source, `${dest}/${source.slice(parentOf(source).length + 1)}`)),
    ),
    fsDelete: vi.fn((_root: string, path: string) => {
      disk.remove(path);
      return Promise.resolve();
    }),
    documentOpen: vi.fn((path: string) => {
      const read = disk.read(path);
      if (read.state !== "file") return Promise.reject(new Error("missing"));
      return Promise.resolve({ path, content: read.content, encoding: "utf8" as const, lineEnding: "lf" as const });
    }),
    documentRead: vi.fn((path: string) => Promise.resolve(disk.read(path))),
  });
  const events = new EventBus<AppEvents>();
  const errors: string[] = [];
  const notices: string[] = [];
  events.on("appError", ({ message }) => errors.push(message));
  events.on("appNotice", ({ message }) => notices.push(message));
  const documents = new DocumentService(ipc, new BufferManager(), events);
  const explorer = new ExplorerService(new FileSystemService(ipc), ipc, events);
  const sync = new FileSyncService(ipc, events, documents, explorer, {
    workspacePath: () => ROOT,
    loadedFolders: () => explorer.loadedFolders(),
  });
  const opened: string[] = [];
  // The same wiring as container.ts.
  explorer.setHost({
    openFile: async (path) => {
      opened.push(await documents.openFromPath(path));
    },
    pathMoved: (from, to) => {
      documents.retargetPath(from, to);
      void ipc.recentFilesRename(from, to);
    },
    pathDeleted: (path) => sync.deletedByUser(path),
  });
  const children = (dir: string) =>
    (explorer.getSnapshot().childrenByPath.get(dir) ?? []).map((path) => explorer.getSnapshot().nodesByPath.get(path)?.name);
  const watcher = (changes: FsChange[]) => sync.handleBatch({ changes, overflow: false });
  return { disk, ipc, events, errors, notices, documents, explorer, sync, opened, children, watcher };
}

async function created(r: ReturnType<typeof rig>, kind: "file" | "folder", name: string, node: { path: string } | null = null) {
  const target = node ? (r.explorer.getSnapshot().nodesByPath.get(node.path) ?? null) : null;
  await r.explorer.beginCreate(kind, target);
  return r.explorer.commitCreate(name);
}

describe("Explorer + editor + watcher (VS Code behaviour)", () => {
  let r: ReturnType<typeof rig>;
  beforeEach(async () => {
    r = rig();
    await r.explorer.setRoot(ROOT, "Demo");
  });

  it("A/O/Q/N: New File at the root appears at once, selected, opened as Python — no refresh, no watcher", async () => {
    const readsBefore = vi.mocked(r.ipc.fsReadDir).mock.calls.length;
    const path = await created(r, "file", "hello.py");

    expect(path).toBe(`${ROOT}/hello.py`);
    expect(r.children(ROOT)).toEqual(["hello.py"]);
    expect(r.explorer.getSnapshot().selectedPath).toBe(`${ROOT}/hello.py`);
    expect(r.explorer.getSnapshot().pendingCreate).toBeNull();
    // One read of the folder the file went into, nothing else.
    expect(vi.mocked(r.ipc.fsReadDir).mock.calls.length - readsBefore).toBe(1);
    const id = r.opened[0] ?? "";
    expect(r.documents.snapshot(id).title).toBe("hello.py");
    expect(r.documents.languageOf(id)).toBe("python");
  });

  it("B/Q: a file selected in a folder means New File goes into that folder; nested names make sub-folders", async () => {
    r.disk.create(ROOT, "src/main.rs", false);
    await r.explorer.refresh();
    await r.explorer.toggleExpand(`${ROOT}/src`);

    await created(r, "file", "lib.rs", { path: `${ROOT}/src/main.rs` });
    expect(r.children(`${ROOT}/src`)).toEqual(["lib.rs", "main.rs"]);
    expect(r.documents.languageOf(r.opened[0] ?? "")).toBe("rust");

    const nested = await created(r, "file", "components/Button.rs", { path: `${ROOT}/src` });
    expect(nested).toBe(`${ROOT}/src/components/Button.rs`);
    const snapshot = r.explorer.getSnapshot();
    expect(snapshot.expandedPaths.has(`${ROOT}/src/components`)).toBe(true);
    expect(snapshot.selectedPath).toBe(nested);
  });

  it("C: New Folder is created, shown and selected, and nothing opens in the editor", async () => {
    const path = await created(r, "folder", "docs");
    expect(r.children(ROOT)).toEqual(["docs"]);
    expect(r.explorer.getSnapshot().selectedPath).toBe(path);
    expect(r.opened).toEqual([]);
  });

  it("an invalid or taken name creates nothing and keeps the tree as it was", async () => {
    await created(r, "file", "a.py");
    expect(await created(r, "file", "A.PY")).toBeNull();
    expect(await created(r, "file", "bad?.py")).toBeNull();
    expect(await created(r, "file", "../out.py")).toBeNull();
    expect(r.errors).toHaveLength(3);
    expect(r.children(ROOT)).toEqual(["a.py"]);
    expect(r.ipc.fsCreateFile).toHaveBeenCalledTimes(1);
    expect(r.explorer.renameProblem(`${ROOT}/a.py`, "b/c.py")).toContain('"/"');
  });

  it("D/R/S: renaming an open file renames its tab and language at once and keeps the unsaved text and undo", async () => {
    const path = await created(r, "file", "notes.txt");
    const id = r.opened[0] ?? "";
    const model = r.documents.modelUri(id);
    const buffers = (r.documents as unknown as { buffers: BufferManager }).buffers;
    buffers.get(id)?.setValue("print('hi')");
    expect(r.documents.isDirty(id)).toBe(true);
    const moved: string[] = [];
    r.events.on("documentPathChanged", ({ to }) => moved.push(to));

    await r.explorer.rename(ROOT, path ?? "", "script.py");

    expect(r.children(ROOT)).toEqual(["script.py"]);
    expect(r.documents.snapshot(id)).toMatchObject({ title: "script.py", path: `${ROOT}/script.py`, dirty: true });
    expect(r.documents.languageOf(id)).toBe("python");
    expect(r.documents.contentOf(id)).toBe("print('hi')");
    expect(r.documents.modelUri(id)).toBe(model);
    expect(moved).toEqual([`${ROOT}/script.py`]);
    expect(r.ipc.recentFilesRename).toHaveBeenCalledWith(`${ROOT}/notes.txt`, `${ROOT}/script.py`);
    expect(r.explorer.getSnapshot().selectedPath).toBe(`${ROOT}/script.py`);

    // The watcher's report of the same rename changes nothing and says nothing.
    await r.watcher([{ kind: "renamed", from: `${ROOT}/notes.txt`, path: `${ROOT}/script.py` }]);
    expect(r.documents.snapshot(id).path).toBe(`${ROOT}/script.py`);
    expect(r.notices).toEqual([]);
    expect(r.children(ROOT)).toEqual(["script.py"]);
  });

  it("E: renaming a folder moves its open files, its expanded state and the selection", async () => {
    await created(r, "file", "src/app.py");
    const id = r.opened[0] ?? "";
    await r.explorer.rename(ROOT, `${ROOT}/src`, "lib");
    expect(r.children(ROOT)).toEqual(["lib"]);
    expect(r.documents.snapshot(id).path).toBe(`${ROOT}/lib/app.py`);
    expect(r.explorer.getSnapshot().selectedPath).toBe(`${ROOT}/lib/app.py`);
    expect(r.explorer.getSnapshot().expandedPaths.has(`${ROOT}/lib`)).toBe(true);
    expect([...r.explorer.getSnapshot().nodesByPath.keys()].some((p) => p.includes("/src"))).toBe(false);
  });

  it("F/G: deleting a file or a folder updates the tree and shows open tabs as deleted, with no 'deleted on disk' notice", async () => {
    await created(r, "file", "src/a.py");
    const inFolder = r.opened[0] ?? "";
    // The new file is selected, so the next New File would go next to it (into src); pick the root first.
    await r.explorer.select(ROOT);
    await created(r, "file", "b.py");
    const single = r.opened[1] ?? "";

    await r.explorer.deleteEntry(ROOT, `${ROOT}/b.py`);
    expect(r.children(ROOT)).toEqual(["src"]);
    expect(r.documents.externalState(single)).toBe("deleted");

    await r.explorer.deleteEntry(ROOT, `${ROOT}/src`);
    expect(r.children(ROOT)).toEqual([]);
    expect(r.documents.externalState(inFolder)).toBe("deleted");
    expect(r.explorer.getSnapshot().childrenByPath.has(`${ROOT}/src`)).toBe(false);

    await r.watcher([{ kind: "removed", from: null, path: `${ROOT}/src` }]);
    expect(r.notices).toEqual([]);
  });

  it("H/I/J: changes made outside the app arrive through the watcher, only for the folders they touch", async () => {
    r.disk.create(ROOT, "outside.py", false);
    await r.watcher([{ kind: "created", from: null, path: `${ROOT}/outside.py` }]);
    expect(r.children(ROOT)).toEqual(["outside.py"]);

    const id = await r.documents.openFromPath(`${ROOT}/outside.py`);
    r.disk.moveTree(`${ROOT}/outside.py`, `${ROOT}/moved.py`);
    await r.watcher([{ kind: "renamed", from: `${ROOT}/outside.py`, path: `${ROOT}/moved.py` }]);
    expect(r.children(ROOT)).toEqual(["moved.py"]);
    expect(r.documents.snapshot(id).title).toBe("moved.py");

    r.disk.remove(`${ROOT}/moved.py`);
    await r.watcher([{ kind: "removed", from: null, path: `${ROOT}/moved.py` }]);
    expect(r.children(ROOT)).toEqual([]);
    expect(r.documents.externalState(id)).toBe("deleted");
    // An unloaded folder's change costs nothing.
    const reads = vi.mocked(r.ipc.fsReadDir).mock.calls.length;
    await r.watcher([{ kind: "created", from: null, path: `${ROOT}/never/opened.py` }]);
    expect(vi.mocked(r.ipc.fsReadDir).mock.calls.length).toBe(reads);
  });

  it("P: the watcher reporting a file the app just created never makes a second node", async () => {
    await created(r, "file", "once.py");
    await r.watcher([
      { kind: "created", from: null, path: `${ROOT}/once.py` },
      { kind: "created", from: null, path: `${ROOT}\\once.py` },
      { kind: "modified", from: null, path: `c:/projects/demo/once.py` },
    ]);
    expect(r.children(ROOT)).toEqual(["once.py"]);
  });

  it("S: unsaved text survives the Explorer re-reading folders (watcher, refresh, a sibling created)", async () => {
    await created(r, "file", "keep.py");
    const id = r.opened[0] ?? "";
    const buffers = (r.documents as unknown as { buffers: BufferManager }).buffers;
    buffers.get(id)?.setValue("x = 1\n");
    const model = buffers.get(id);
    await created(r, "file", "other.py");
    await r.explorer.refresh();
    await r.watcher([{ kind: "created", from: null, path: `${ROOT}/other.py` }]);
    expect(buffers.get(id)).toBe(model);
    expect(r.documents.contentOf(id)).toBe("x = 1\n");
    expect(r.documents.isDirty(id)).toBe(true);
  });
});

describe("no folder open", () => {
  it("K: a new text file is an untitled editor named Untitled-1, written nowhere and absent from the Explorer", () => {
    const r = rig();
    const first = r.documents.createUntitled();
    const second = r.documents.createUntitled();
    expect(r.documents.snapshot(first)).toMatchObject({ title: "Untitled-1", path: null });
    expect(r.documents.snapshot(second).title).toBe("Untitled-2");
    expect(r.ipc.fsCreateFile).not.toHaveBeenCalled();
    expect(r.ipc.documentSave).not.toHaveBeenCalled();
    expect(r.explorer.getSnapshot().rootPath).toBeNull();
  });

  it("K: Save As gives the untitled editor its real name and the language of that name", async () => {
    const r = rig();
    vi.mocked(r.ipc.saveDocumentDialog).mockResolvedValue("C:/Users/Me/Documents/test.py");
    const id = r.documents.createUntitled();
    await r.documents.save(id);
    expect(r.ipc.documentSave).toHaveBeenCalledWith("C:/Users/Me/Documents/test.py", "", "utf8");
    expect(r.documents.snapshot(id).title).toBe("test.py");
    expect(r.documents.languageOf(id)).toBe("python");
    expect(r.explorer.getSnapshot().rootPath).toBeNull();
  });

  it("L: a file opened on its own opens in an editor and the Explorer keeps no root and no nodes", async () => {
    const r = rig();
    r.disk.entries.set("C:/Users/Me/Documents", null);
    r.disk.entries.set("C:/Users/Me/Documents/test.py", "print(1)");
    const id = await r.documents.openFromPath("C:/Users/Me/Documents/test.py");
    expect(r.documents.languageOf(id)).toBe("python");
    expect(r.explorer.getSnapshot()).toMatchObject({ rootPath: null, selectedPath: null });
    expect(r.explorer.getSnapshot().nodesByPath.size).toBe(0);
    await r.explorer.revealPath("C:/Users/Me/Documents/test.py");
    expect(r.explorer.getSnapshot().selectedPath).toBeNull();
  });

  it("M: a file outside an open folder opens, and revealing it leaves the tree alone", async () => {
    const r = rig();
    await r.explorer.setRoot(ROOT, "Demo");
    r.disk.entries.set("D:/Elsewhere", null);
    r.disk.entries.set("D:/Elsewhere/x.py", "");
    await r.documents.openFromPath("D:/Elsewhere/x.py");
    await r.explorer.revealPath("D:/Elsewhere/x.py");
    expect(r.explorer.getSnapshot().selectedPath).toBeNull();
  });

  it("one file is one document whatever slash style or drive-letter case it is opened with", async () => {
    const r = rig();
    r.disk.entries.set(`${ROOT}/a.py`, "");
    const id = await r.documents.openFromPath(`${ROOT}/a.py`);
    expect(await r.documents.openFromPath("c:\\Projects\\Demo\\a.py")).toBe(id);
  });

  it("a file deep in a large, collapsed tree is revealed: folders opened, row selected, scrolled each time", async () => {
    const r = rig();
    // 3 levels of folders, 400 files in each: the target row is collapsed away and far down the list.
    let dir = ROOT;
    for (const name of ["src", "features", "editor"]) {
      for (let i = 0; i < 400; i += 1) r.disk.entries.set(`${dir}/file${String(i).padStart(3, "0")}.txt`, "");
      dir = `${dir}/${name}`;
      r.disk.entries.set(dir, null);
    }
    r.disk.entries.set(`${dir}/Target.py`, "");
    await r.explorer.setRoot(ROOT, "Demo");
    expect(r.explorer.getSnapshot().expandedPaths.size).toBe(0);

    // The editor spells the path differently from the tree (backslashes, drive-letter case, file-name case).
    await r.explorer.revealPath("c:\\Projects\\Demo\\src\\features\\editor\\target.py");
    const snapshot = r.explorer.getSnapshot();
    expect([...snapshot.expandedPaths].sort()).toEqual([
      `${ROOT}/src`,
      `${ROOT}/src/features`,
      `${ROOT}/src/features/editor`,
    ]);
    expect(snapshot.selectedPath).toBe(`${ROOT}/src/features/editor/Target.py`); // the tree's own spelling
    const seq = snapshot.revealSeq ?? 0;

    // Revealing the same file again (the user scrolled away, then came back to its tab) still asks for a scroll.
    await r.explorer.revealPath(`${ROOT}/src/features/editor/Target.py`);
    expect(r.explorer.getSnapshot().revealSeq).toBe(seq + 1);
  });
});
