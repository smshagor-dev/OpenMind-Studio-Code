import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { ExplorerService } from "./explorerService";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import { FileSystemService } from "./fileSystemService";
import type { DirEntryInfo } from "./ipc";

function entry(path: string, name: string, isDir: boolean): DirEntryInfo {
  return { path, name, isDir, isSymlink: false };
}

describe("ExplorerService", () => {
  let events: EventBus<AppEvents>;

  beforeEach(() => {
    events = new EventBus<AppEvents>();
  });

  it("setRoot loads the root directory's children", async () => {
    const ipc = createFakeIpc({
      fsReadDir: vi
        .fn()
        .mockResolvedValue([
          entry("C:/proj/src", "src", true),
          entry("C:/proj/README.md", "README.md", false),
        ]),
    });
    const service = new ExplorerService(new FileSystemService(ipc), ipc, events);

    await service.setRoot("C:/proj", "proj");

    const snapshot = service.getSnapshot();
    expect(snapshot.rootPath).toBe("C:/proj");
    expect(snapshot.childrenByPath.get("C:/proj")).toEqual(["C:/proj/src", "C:/proj/README.md"]);
  });

  it("setRoot restores persisted expanded/selected state and loads those children too", async () => {
    const ipc = createFakeIpc({
      explorerStateLoad: vi
        .fn()
        .mockResolvedValue({ expandedPaths: ["C:/proj/src"], selectedPath: "C:/proj/src/a.ts" }),
      fsReadDir: vi.fn().mockImplementation((path: string) => {
        if (path === "C:/proj") return Promise.resolve([entry("C:/proj/src", "src", true)]);
        if (path === "C:/proj/src")
          return Promise.resolve([entry("C:/proj/src/a.ts", "a.ts", false)]);
        return Promise.resolve([]);
      }),
    });
    const service = new ExplorerService(new FileSystemService(ipc), ipc, events);

    await service.setRoot("C:/proj", "proj");

    const snapshot = service.getSnapshot();
    expect(snapshot.expandedPaths.has("C:/proj/src")).toBe(true);
    expect(snapshot.selectedPath).toBe("C:/proj/src/a.ts");
    expect(snapshot.childrenByPath.get("C:/proj/src")).toEqual(["C:/proj/src/a.ts"]);
  });

  it("toggleExpand loads children on expand and persists state", async () => {
    const ipc = createFakeIpc({
      fsReadDir: vi.fn().mockImplementation((path: string) => {
        if (path === "C:/proj") return Promise.resolve([entry("C:/proj/src", "src", true)]);
        return Promise.resolve([entry("C:/proj/src/a.ts", "a.ts", false)]);
      }),
    });
    const service = new ExplorerService(new FileSystemService(ipc), ipc, events);
    await service.setRoot("C:/proj", "proj");

    await service.toggleExpand("C:/proj/src");

    expect(service.getSnapshot().expandedPaths.has("C:/proj/src")).toBe(true);
    expect(service.getSnapshot().childrenByPath.get("C:/proj/src")).toEqual(["C:/proj/src/a.ts"]);
    expect(ipc.explorerStateSave).toHaveBeenCalled();
  });

  it("toggleExpand collapses an already-expanded directory", async () => {
    const ipc = createFakeIpc({ fsReadDir: vi.fn().mockResolvedValue([]) });
    const service = new ExplorerService(new FileSystemService(ipc), ipc, events);
    await service.setRoot("C:/proj", "proj");
    await service.toggleExpand("C:/proj/src");

    await service.toggleExpand("C:/proj/src");

    expect(service.getSnapshot().expandedPaths.has("C:/proj/src")).toBe(false);
  });

  it("collapseAll clears every expanded path", async () => {
    const ipc = createFakeIpc({ fsReadDir: vi.fn().mockResolvedValue([]) });
    const service = new ExplorerService(new FileSystemService(ipc), ipc, events);
    await service.setRoot("C:/proj", "proj");
    await service.toggleExpand("C:/proj/a");
    await service.toggleExpand("C:/proj/b");

    await service.collapseAll();

    expect(service.getSnapshot().expandedPaths.size).toBe(0);
  });

  it("select sets the selected path and persists it", async () => {
    const ipc = createFakeIpc({ fsReadDir: vi.fn().mockResolvedValue([]) });
    const service = new ExplorerService(new FileSystemService(ipc), ipc, events);
    await service.setRoot("C:/proj", "proj");

    await service.select("C:/proj/a.ts");

    expect(service.getSnapshot().selectedPath).toBe("C:/proj/a.ts");
    expect(ipc.explorerStateSave).toHaveBeenCalled();
  });

  it("revealPath expands ancestor directories and selects the target", async () => {
    const ipc = createFakeIpc({
      fsReadDir: vi.fn().mockImplementation((path: string) => {
        if (path === "C:/proj") return Promise.resolve([entry("C:/proj/src", "src", true)]);
        if (path === "C:/proj/src")
          return Promise.resolve([entry("C:/proj/src/deep", "deep", true)]);
        if (path === "C:/proj/src/deep")
          return Promise.resolve([entry("C:/proj/src/deep/a.ts", "a.ts", false)]);
        return Promise.resolve([]);
      }),
    });
    const service = new ExplorerService(new FileSystemService(ipc), ipc, events);
    await service.setRoot("C:/proj", "proj");

    await service.revealPath("C:/proj/src/deep/a.ts");

    const snapshot = service.getSnapshot();
    expect(snapshot.expandedPaths.has("C:/proj/src")).toBe(true);
    expect(snapshot.expandedPaths.has("C:/proj/src/deep")).toBe(true);
    expect(snapshot.selectedPath).toBe("C:/proj/src/deep/a.ts");
  });

  it("createFile picks a unique name and refreshes the parent directory", async () => {
    const readDir = vi.fn().mockImplementation((path: string) => {
      if (path === "C:/proj")
        return Promise.resolve([entry("C:/proj/Untitled", "Untitled", false)]);
      return Promise.resolve([]);
    });
    const ipc = createFakeIpc({
      fsReadDir: readDir,
      fsCreateFile: vi.fn().mockResolvedValue("C:/proj/Untitled 2"),
    });
    const service = new ExplorerService(new FileSystemService(ipc), ipc, events);
    await service.setRoot("C:/proj", "proj");

    const created = await service.createFile("C:/proj");

    expect(ipc.fsCreateFile).toHaveBeenCalledWith("C:/proj", "C:/proj", "Untitled 2");
    expect(created).toBe("C:/proj/Untitled 2");
  });

  it("createNamed creates exactly the typed name, refuses a name already there, and ignores an empty one", async () => {
    const ipc = createFakeIpc({
      fsReadDir: vi.fn().mockImplementation((path: string) =>
        Promise.resolve(path === "C:/proj" ? [entry("C:/proj/README.md", "README.md", false)] : []),
      ),
      fsCreateFile: vi.fn().mockResolvedValue("C:/proj/main.f90"),
      fsCreateFolder: vi.fn().mockResolvedValue("C:/proj/lib"),
    });
    const errors: string[] = [];
    events.on("appError", ({ message }) => errors.push(message));
    const service = new ExplorerService(new FileSystemService(ipc), ipc, events);
    await service.setRoot("C:/proj", "proj");

    expect(await service.createNamed("C:/proj", "main.f90", "file")).toBe("C:/proj/main.f90");
    expect(ipc.fsCreateFile).toHaveBeenCalledWith("C:/proj", "C:/proj", "main.f90");
    expect(await service.createNamed("C:/proj", "lib", "folder")).toBe("C:/proj/lib");
    expect(ipc.fsCreateFolder).toHaveBeenCalledWith("C:/proj", "C:/proj", "lib");

    expect(await service.createNamed("C:/proj", "readme.md", "file")).toBeNull();
    expect(errors[0]).toContain('"readme.md" already exists');
    expect(await service.createNamed("C:/proj", "", "file")).toBeNull();
    expect(ipc.fsCreateFile).toHaveBeenCalledTimes(1);
  });

  it("prepareCreate opens a closed folder so its name box shows inside it", async () => {
    const ipc = createFakeIpc({
      fsReadDir: vi.fn().mockImplementation((path: string) =>
        Promise.resolve(path === "C:/proj" ? [entry("C:/proj/src", "src", true)] : []),
      ),
    });
    const service = new ExplorerService(new FileSystemService(ipc), ipc, events);
    await service.setRoot("C:/proj", "proj");
    await service.prepareCreate("C:/proj/src");
    expect(service.getSnapshot().expandedPaths.has("C:/proj/src")).toBe(true);
    expect(service.getSnapshot().childrenByPath.has("C:/proj/src")).toBe(true);
  });

  it("rename, delete, move, and duplicate refresh the affected directories", async () => {
    const ipc = createFakeIpc({
      fsReadDir: vi.fn().mockResolvedValue([]),
      fsRename: vi.fn().mockResolvedValue("C:/proj/b.ts"),
      fsDelete: vi.fn().mockResolvedValue(undefined),
      fsMove: vi.fn().mockResolvedValue("C:/proj/dest/a.ts"),
      fsDuplicate: vi.fn().mockResolvedValue("C:/proj/a copy.ts"),
    });
    const service = new ExplorerService(new FileSystemService(ipc), ipc, events);
    await service.setRoot("C:/proj", "proj");
    const readDirCallsBefore = (ipc.fsReadDir as ReturnType<typeof vi.fn>).mock.calls.length;

    await service.rename("C:/proj", "C:/proj/a.ts", "b.ts");
    await service.deleteEntry("C:/proj", "C:/proj/b.ts");
    await service.moveEntry("C:/proj", "C:/proj/a.ts", "C:/proj/dest");
    await service.duplicate("C:/proj", "C:/proj/a.ts");

    expect(ipc.fsRename).toHaveBeenCalledWith("C:/proj", "C:/proj/a.ts", "b.ts");
    expect(ipc.fsDelete).toHaveBeenCalledWith("C:/proj", "C:/proj/b.ts");
    expect(ipc.fsMove).toHaveBeenCalledWith("C:/proj", "C:/proj/a.ts", "C:/proj/dest");
    expect(ipc.fsDuplicate).toHaveBeenCalledWith("C:/proj", "C:/proj/a.ts", "a copy.ts");
    // rename(1) + delete(1) + move(2 dirs) + duplicate(1 sibling lookup + 1 refresh) = 6 reads
    expect((ipc.fsReadDir as ReturnType<typeof vi.fn>).mock.calls.length - readDirCallsBefore).toBe(
      6,
    );
  });

  it("emits appError and keeps working when a read fails instead of throwing", async () => {
    const ipc = createFakeIpc({
      fsReadDir: vi.fn().mockRejectedValue(new Error("permission denied")),
    });
    const service = new ExplorerService(new FileSystemService(ipc), ipc, events);
    const errors: string[] = [];
    events.on("appError", ({ message }) => errors.push(message));

    await expect(service.setRoot("C:/proj", "proj")).resolves.toBeUndefined();

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("permission denied");
  });

  it("notifies subscribers when the tree changes", async () => {
    const ipc = createFakeIpc({ fsReadDir: vi.fn().mockResolvedValue([]) });
    const service = new ExplorerService(new FileSystemService(ipc), ipc, events);
    const listener = vi.fn();
    service.subscribe(listener);

    await service.setRoot("C:/proj", "proj");

    expect(listener).toHaveBeenCalled();
  });

  it("clear resets to the empty snapshot", async () => {
    const ipc = createFakeIpc({ fsReadDir: vi.fn().mockResolvedValue([]) });
    const service = new ExplorerService(new FileSystemService(ipc), ipc, events);
    await service.setRoot("C:/proj", "proj");

    service.clear();

    expect(service.getSnapshot().rootPath).toBeNull();
  });

  describe("clipboard", () => {
    function setup() {
      const ipc = createFakeIpc({
        fsReadDir: vi.fn().mockImplementation((path: string) => {
          if (path === "C:/proj")
            return Promise.resolve([
              entry("C:/proj/src", "src", true),
              entry("C:/proj/a.ts", "a.ts", false),
            ]);
          return Promise.resolve([]);
        }),
        fsMove: vi.fn().mockResolvedValue("C:/proj/src/a.ts"),
        fsCopy: vi.fn().mockResolvedValue("C:/proj/src/a.ts"),
        fsDuplicate: vi.fn().mockResolvedValue("C:/proj/a copy.ts"),
      });
      return { ipc, service: new ExplorerService(new FileSystemService(ipc), ipc, events) };
    }

    it("paste after cut moves the entry and clears the clipboard", async () => {
      const { ipc, service } = setup();
      await service.setRoot("C:/proj", "proj");

      service.setClipboard("C:/proj/a.ts", "cut");
      await service.paste("C:/proj/src");

      expect(ipc.fsMove).toHaveBeenCalledWith("C:/proj", "C:/proj/a.ts", "C:/proj/src");
      expect(service.hasClipboard()).toBe(false);
    });

    it("paste after copy into another folder copies, and keeps the clipboard", async () => {
      const { ipc, service } = setup();
      await service.setRoot("C:/proj", "proj");

      service.setClipboard("C:/proj/a.ts", "copy");
      await service.paste("C:/proj/src");

      expect(ipc.fsCopy).toHaveBeenCalledWith("C:/proj", "C:/proj/a.ts", "C:/proj/src");
      expect(service.hasClipboard()).toBe(true);
    });

    it("paste after copy into the same folder duplicates instead of colliding", async () => {
      const { ipc, service } = setup();
      await service.setRoot("C:/proj", "proj");

      service.setClipboard("C:/proj/a.ts", "copy");
      await service.paste("C:/proj");

      expect(ipc.fsCopy).not.toHaveBeenCalled();
      expect(ipc.fsDuplicate).toHaveBeenCalledWith("C:/proj", "C:/proj/a.ts", "a copy.ts");
    });
  });

  it("refreshLoaded re-reads only folders already loaded, in either slash style, and shows external creates and deletes", async () => {
    let files = [entry("C:/proj/a.txt", "a.txt", false)];
    const readDir = vi.fn().mockImplementation((path: string) => {
      if (path === "C:/proj") return Promise.resolve(files);
      return Promise.resolve([]);
    });
    const ipc = createFakeIpc({ fsReadDir: readDir });
    const service = new ExplorerService(new FileSystemService(ipc), ipc, events);
    await service.setRoot("C:/proj", "proj");
    expect(service.getSnapshot().childrenByPath.get("C:/proj")).toEqual(["C:/proj/a.txt"]);

    // A file created from a terminal, and one deleted; the event spells the path with backslashes.
    files = [entry("C:/proj/new file.txt", "new file.txt", false)];
    readDir.mockClear();
    const backslashed = ["c:", "proj"].join(String.fromCharCode(92));
    const refreshed = await service.refreshLoaded([backslashed, "C:/proj/never opened/deep"]);
    expect(refreshed).toBe(1);
    expect(readDir).toHaveBeenCalledTimes(1);
    expect(service.getSnapshot().childrenByPath.get("C:/proj")).toEqual(["C:/proj/new file.txt"]);
  });

  it("refreshLoaded does not toast for a folder that vanished", async () => {
    const readDir = vi.fn().mockResolvedValue([]);
    const ipc = createFakeIpc({ fsReadDir: readDir });
    const service = new ExplorerService(new FileSystemService(ipc), ipc, events);
    await service.setRoot("C:/proj", "proj");
    const errors: string[] = [];
    events.on("appError", (event) => errors.push(event.message));
    readDir.mockRejectedValue("C:/proj does not exist");
    expect(await service.refreshLoaded(["C:/proj"])).toBe(0);
    expect(errors).toEqual([]);
    expect(service.loadedFolders()).toEqual(["C:/proj", "C:/proj"]);
  });
});
