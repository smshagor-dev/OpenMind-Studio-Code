import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BookmarkService,
  inScope,
  neighbour,
  SAVE_DELAY_MS,
  type Bookmark,
} from "./bookmarkService";
import type { BookmarkRow, BookmarksIpc } from "./bookmarksIpc";

function fakeIpc(rows: BookmarkRow[] = []) {
  return {
    load: vi.fn(() => Promise.resolve(rows)),
    save: vi.fn<(rows: BookmarkRow[]) => Promise<void>>(() => Promise.resolve()),
  } satisfies BookmarksIpc;
}

const bm = (path: string, line: number): Bookmark => ({
  id: `${path}:${String(line)}`,
  path,
  line,
  label: null,
});

describe("bookmark navigation", () => {
  const list = [bm("C:/p/b.ts", 4), bm("C:/p/a.ts", 10), bm("C:/p/a.ts", 2)];

  it("goes to the next one in the file, then the next file, then wraps", () => {
    expect(neighbour(list, { path: "C:/p/a.ts", line: 2 }, 1)?.line).toBe(10);
    expect(neighbour(list, { path: "c:\\p\\a.ts", line: 11 }, 1)?.path).toBe("C:/p/b.ts");
    expect(neighbour(list, { path: "C:/p/b.ts", line: 4 }, 1)).toEqual(bm("C:/p/a.ts", 2));
  });

  it("goes back the same way and wraps to the last", () => {
    expect(neighbour(list, { path: "C:/p/b.ts", line: 4 }, -1)?.line).toBe(10);
    expect(neighbour(list, { path: "C:/p/a.ts", line: 2 }, -1)).toEqual(bm("C:/p/b.ts", 4));
  });

  it("starts at the first or last one with no place, and finds nothing in an empty list", () => {
    expect(neighbour(list, null, 1)?.line).toBe(2);
    expect(neighbour(list, null, -1)?.path).toBe("C:/p/b.ts");
    expect(neighbour([], null, 1)).toBeUndefined();
  });

  it("knows what is inside a folder", () => {
    expect(inScope("C:/My Site/src/a.ts", "c:\\my site")).toBe(true);
    expect(inScope("C:/My Site 2/a.ts", "C:/My Site")).toBe(false);
    expect(inScope("D:/x.ts", null)).toBe(true);
  });
});

describe("BookmarkService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads the saved bookmarks", async () => {
    const service = new BookmarkService(
      fakeIpc([{ filePath: "C:/p/a.ts", line: 3, label: " todo " }]),
    );
    await service.initialize();
    expect(service.forFile("c:/p/a.ts")).toMatchObject([{ line: 3, label: "todo" }]);
  });

  it("toggles on and off and saves once after a pause", async () => {
    const ipc = fakeIpc();
    const service = new BookmarkService(ipc);
    expect(service.toggle("C:/p/a.ts", 5, "  login  ")).toBe(true);
    expect(service.toggle("C:/p/a.ts", 9)).toBe(true);
    expect(service.toggle("C:/p/a.ts", 9)).toBe(false);
    expect(ipc.save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    expect(ipc.save).toHaveBeenCalledTimes(1);
    expect(ipc.save).toHaveBeenCalledWith([{ filePath: "C:/p/a.ts", line: 5, label: "login" }]);
  });

  it("labels, removes, clears a file and clears a folder", () => {
    const service = new BookmarkService(fakeIpc());
    service.toggle("C:/p/a.ts", 1);
    service.toggle("C:/p/b.ts", 2);
    service.toggle("C:/q/c.ts", 3);
    const first = service.at("C:/p/a.ts", 1)?.id ?? "";
    service.setLabel(first, "entry");
    expect(service.at("C:/p/a.ts", 1)?.label).toBe("entry");
    service.setLabel(first, "   ");
    expect(service.at("C:/p/a.ts", 1)?.label).toBeNull();
    service.clearFile("c:\\p\\b.ts");
    expect(service.scoped("C:/p").map((b) => b.path)).toEqual(["C:/p/a.ts"]);
    service.clearScope("C:/p");
    expect(service.getState().bookmarks.map((b) => b.path)).toEqual(["C:/q/c.ts"]);
    service.remove(service.at("C:/q/c.ts", 3)?.id ?? "");
    expect(service.getState().bookmarks).toEqual([]);
  });

  it("follows a moved line and merges two squeezed onto one line", () => {
    const service = new BookmarkService(fakeIpc());
    service.toggle("C:/p/a.ts", 4);
    service.toggle("C:/p/a.ts", 6);
    const [a, b] = service.forFile("C:/p/a.ts").map((x) => x.id);
    service.moveLines([
      { id: a ?? "", line: 7 },
      { id: b ?? "", line: 9 },
    ]);
    expect(service.forFile("C:/p/a.ts").map((x) => x.line)).toEqual([7, 9]);
    service.moveLines([
      { id: a ?? "", line: 3 },
      { id: b ?? "", line: 3 },
    ]);
    expect(service.forFile("C:/p/a.ts").map((x) => x.line)).toEqual([3]);
  });

  it("follows a renamed file and a moved folder", () => {
    const service = new BookmarkService(fakeIpc());
    service.toggle("C:/p/lib/a.ts", 1);
    service.toggle("C:/p/b.ts", 2);
    service.retarget("C:\\p\\b.ts", "C:/p/c.ts");
    service.retarget("C:/p/lib", "C:/p/src/lib");
    const paths = service.getState().bookmarks.map((x) => x.path);
    expect(paths.sort()).toEqual(["C:/p/c.ts", "C:/p/src/lib/a.ts"]);
  });

  it("keeps working when loading or saving fails", async () => {
    const ipc: BookmarksIpc = {
      load: () => Promise.reject(new Error("db")),
      save: () => Promise.reject(new Error("db")),
    };
    const service = new BookmarkService(ipc);
    await service.initialize();
    service.toggle("C:/p/a.ts", 1);
    await expect(service.saveNow()).resolves.toBeUndefined();
    expect(service.forFile("C:/p/a.ts")).toHaveLength(1);
  });
});
