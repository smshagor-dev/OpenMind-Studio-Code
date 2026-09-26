import { describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import { FileSearchService } from "./fileSearchService";
import type { SearchOutcome } from "./ipc";
import { OutputService } from "./outputService";
import { QuickOpenService } from "./quickOpenService";
import { ReferenceSearchService } from "./referenceSearchService";
import type { FileHit, SymbolHit } from "./searchIpc";
import { RESULT_PAGE, SearchService } from "./searchService";
import { SymbolSearchService } from "./symbolSearchService";

const file = (relativePath: string, highlights: [number, number][] = []): FileHit => ({
  path: `C:/My Site/${relativePath}`,
  relativePath,
  name: relativePath.split("/").pop() ?? relativePath,
  score: 1,
  highlights,
});

const symbol = (name: string, line = 1, extra: Partial<SymbolHit> = {}): SymbolHit => ({
  name,
  kind: "function",
  line,
  column: 8,
  container: null,
  path: "C:/My Site/src/app.ts",
  relativePath: "src/app.ts",
  language: "typescript",
  score: 1,
  ...extra,
});

const outcome = (files = 1, matchesPerFile = 1): SearchOutcome => ({
  files: Array.from({ length: files }, (_, f) => ({
    path: `C:/My Site/f${String(f)}.ts`,
    relativePath: `f${String(f)}.ts`,
    matches: Array.from({ length: matchesPerFile }, (_, m) => ({
      line: m + 1,
      column: 1,
      length: 3,
      preview: "foo",
      previewStart: 0,
      previewEnd: 3,
    })),
  })),
  totalMatches: files * matchesPerFile,
  filesSearched: files,
  skippedBinary: 0,
  skippedLarge: 0,
  truncated: false,
  cancelled: false,
  durationMs: 1,
});

describe("FileSearchService", () => {
  const rig = (hasFiles = true, root: string | null = "C:/My Site") => {
    const ipc = createFakeIpc({
      searchFilesIndexed: vi.fn().mockResolvedValue([file("src/app.ts")]),
    });
    const opener = { openPath: vi.fn().mockResolvedValue("tab") };
    const service = new FileSearchService(
      ipc,
      opener,
      () => root,
      () => hasFiles,
    );
    return { ipc, opener, service };
  };

  it("searches the index by name, opens a result, and says when nothing matched", async () => {
    const { ipc, opener, service } = rig();
    service.setQuery("app.ts");
    await vi.waitFor(() => {
      expect(service.getState().status).toBe("done");
    });
    expect(ipc.searchFilesIndexed).toHaveBeenCalledWith("app.ts", null, 100);
    expect(service.getState().results).toHaveLength(1);
    const first = service.getState().results[0];
    if (first) await service.open(first);
    expect(opener.openPath).toHaveBeenCalledWith("C:/My Site/src/app.ts");
    vi.mocked(ipc.searchFilesIndexed).mockResolvedValue([]);
    await service.run();
    expect(service.getState()).toMatchObject({ status: "done", results: [] });
  });

  it("gives clear errors without a folder or before the index has files, and drops a stale answer", async () => {
    await expect(rig(true, null).service.run()).resolves.toBeUndefined();
    const noFolder = rig(true, null);
    await noFolder.service.run();
    expect(noFolder.service.getState().error).toBe("Open a folder to search for files.");
    const early = rig(false);
    await early.service.run();
    expect(early.service.getState().error).toContain("no files yet");
    expect(early.ipc.searchFilesIndexed).not.toHaveBeenCalled();

    const { ipc, service } = rig();
    let release: (hits: FileHit[]) => void = () => undefined;
    vi.mocked(ipc.searchFilesIndexed)
      .mockImplementationOnce(
        () =>
          new Promise<FileHit[]>((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValue([file("newer.ts")]);
    const slow = service.run();
    await service.run();
    release([file("stale.ts")]);
    await slow;
    expect(service.getState().results.map((r) => r.name)).toEqual(["newer.ts"]);
  });

  it("a backend error becomes the error state and clear resets everything", async () => {
    const { ipc, service } = rig();
    vi.mocked(ipc.searchFilesIndexed).mockRejectedValue('"[" isn\'t a valid file pattern');
    service.setQuery("[");
    await vi.waitFor(() => {
      expect(service.getState().status).toBe("error");
    });
    expect(service.getState().error).toContain("isn't a valid file pattern");
    service.clear();
    expect(service.getState()).toMatchObject({ query: "", status: "idle", results: [] });
  });
});

describe("SymbolSearchService", () => {
  const rig = () => {
    const ipc = createFakeIpc({
      searchSymbolsIndexed: vi
        .fn()
        .mockResolvedValue([symbol("startServer"), symbol("Router", 4, { kind: "class" })]),
    });
    const opener = { openPathAt: vi.fn().mockResolvedValue("tab") };
    const service = new SymbolSearchService(
      ipc,
      opener,
      () => "C:/My Site",
      () => true,
    );
    return { ipc, opener, service };
  };

  it("searches by name and kind and opens a symbol with its name selected", async () => {
    const { ipc, opener, service } = rig();
    service.setQuery("start");
    service.setKind("function");
    await vi.waitFor(() => {
      expect(service.getState().status).toBe("done");
    });
    expect(ipc.searchSymbolsIndexed).toHaveBeenLastCalledWith("start", "function", 200);
    const hit = service.getState().results[0];
    if (hit) await service.open(hit);
    expect(opener.openPathAt).toHaveBeenCalledWith("C:/My Site/src/app.ts", {
      line: 1,
      column: 8,
      length: "startServer".length,
    });
  });

  it("errors are shown and an empty answer is a normal state", async () => {
    const { ipc, service } = rig();
    vi.mocked(ipc.searchSymbolsIndexed).mockResolvedValue([]);
    await service.run();
    expect(service.getState()).toMatchObject({ status: "done", results: [] });
    vi.mocked(ipc.searchSymbolsIndexed).mockRejectedValue("the search index couldn't be used: x");
    await service.run();
    expect(service.getState().status).toBe("error");
  });
});

describe("ReferenceSearchService", () => {
  const rig = (ready: boolean) => {
    const ipc = createFakeIpc({
      searchTextIndexed: vi.fn().mockResolvedValue(outcome(2, 2)),
      searchRun: vi.fn().mockResolvedValue(outcome(1, 1)),
    });
    const opener = { openPathAt: vi.fn().mockResolvedValue("tab") };
    const service = new ReferenceSearchService(
      ipc,
      opener,
      () => "C:/My Site",
      () => ready,
    );
    return { ipc, opener, service };
  };

  it("looks the word up as whole-word, case-sensitive text — from the index when it is ready, else from disk", async () => {
    const indexed = rig(true);
    await indexed.service.find("startServer");
    expect(indexed.ipc.searchTextIndexed).toHaveBeenCalledWith(
      expect.stringContaining("refs-"),
      expect.objectContaining({
        text: "startServer",
        wholeWord: true,
        caseSensitive: true,
        useRegex: false,
      }),
    );
    expect(indexed.service.getState()).toMatchObject({
      status: "done",
      source: "index",
      kind: "text",
    });
    const disk = rig(false);
    await disk.service.find("startServer");
    expect(disk.ipc.searchRun).toHaveBeenCalled();
    expect(disk.service.getState().source).toBe("disk");
  });

  it("refuses something that is not a name and opens a match at its position", async () => {
    const { opener, service } = rig(true);
    await service.find("two words");
    expect(service.getState().status).toBe("error");
    expect(service.getState().error).toContain("cursor on a name");
    await service.find("");
    expect(service.getState().status).toBe("error");
    expect(ReferenceSearchService.isLookupWord("$scope")).toBe(true);
    expect(ReferenceSearchService.isLookupWord("naïve_1")).toBe(true);
    expect(ReferenceSearchService.isLookupWord("1abc")).toBe(false);
    await service.find("foo");
    const state = service.getState();
    const result = state.outcome?.files[0];
    if (result?.matches[0]) await service.open(result, result.matches[0]);
    expect(opener.openPathAt).toHaveBeenCalledWith("C:/My Site/f0.ts", {
      line: 1,
      column: 1,
      length: 3,
    });
    service.clear();
    expect(service.getState().status).toBe("idle");
  });
});

describe("QuickOpenService", () => {
  const rig = () => {
    const ipc = createFakeIpc({
      searchFilesIndexed: vi
        .fn()
        .mockResolvedValue([file("src/app.ts", [[4, 7]]), file("readme.md", [[0, 6]])]),
      searchSymbolsIndexed: vi
        .fn()
        .mockResolvedValue([symbol("startServer", 3, { container: "Server" })]),
    });
    const opener = {
      openPath: vi.fn().mockResolvedValue("tab"),
      openPathAt: vi.fn().mockResolvedValue("tab"),
    };
    const files = new FileSearchService(
      ipc,
      opener,
      () => "C:/My Site",
      () => true,
    );
    const symbols = new SymbolSearchService(
      ipc,
      opener,
      () => "C:/My Site",
      () => true,
    );
    const quick = new QuickOpenService(files, symbols);
    return { ipc, opener, quick };
  };

  it("lists files at once, moves with wrap-around, and opens the highlighted row", async () => {
    const { opener, quick } = rig();
    quick.show("files");
    await vi.waitFor(() => {
      expect(quick.items()).toHaveLength(2);
    });
    expect(quick.getState()).toMatchObject({ open: true, mode: "files", selected: 0 });
    expect(quick.items()[0]).toMatchObject({
      label: "app.ts",
      description: "src",
      highlights: [[4, 7]],
    });
    expect(quick.items()[1]).toMatchObject({ label: "readme.md", description: "" });
    quick.move(1);
    expect(quick.getState().selected).toBe(1);
    quick.move(1);
    expect(quick.getState().selected).toBe(0);
    quick.move(-1);
    expect(quick.getState().selected).toBe(1);
    expect(await quick.accept()).toBe(true);
    expect(opener.openPath).toHaveBeenCalledWith("C:/My Site/readme.md");
    expect(quick.getState().open).toBe(false);
  });

  it("symbol mode lists symbols with their kind and container and opens at the symbol", async () => {
    const { opener, quick } = rig();
    quick.show("symbols");
    await vi.waitFor(() => {
      expect(quick.items()).toHaveLength(1);
    });
    expect(quick.items()[0]).toMatchObject({
      label: "startServer",
      kind: "function",
      description: "Server · src/app.ts:3",
    });
    await quick.accept(0);
    expect(opener.openPathAt).toHaveBeenCalledWith("C:/My Site/src/app.ts", {
      line: 3,
      column: 8,
      length: 11,
    });
    expect(await quick.accept(9)).toBe(false);
  });

  it("says why it is empty, and Escape closes without opening anything", async () => {
    const { ipc, opener, quick } = rig();
    vi.mocked(ipc.searchFilesIndexed).mockResolvedValue([]);
    quick.show("files");
    await vi.waitFor(() => {
      expect(quick.emptyMessage()).toBe("No matching results.");
    });
    quick.close();
    expect(quick.getState().open).toBe(false);
    expect(opener.openPath).not.toHaveBeenCalled();
  });
});

describe("SearchService with the index", () => {
  const rig = (ready: boolean) => {
    const ipc = createFakeIpc({
      searchTextIndexed: vi.fn().mockResolvedValue(outcome(3, 2)),
      searchRun: vi.fn().mockResolvedValue(outcome(1, 1)),
    });
    const events = new EventBus<AppEvents>();
    const service = new SearchService(
      ipc,
      events,
      new OutputService(),
      () => "C:/My Site",
      { openPathAt: vi.fn().mockResolvedValue("tab") },
      { isReady: () => ready },
    );
    return { ipc, service };
  };

  it("uses the index when it is ready and reads the disk when it is not", async () => {
    const indexed = rig(true);
    indexed.service.setQuery("foo");
    await indexed.service.run();
    expect(indexed.ipc.searchTextIndexed).toHaveBeenCalled();
    expect(indexed.ipc.searchRun).not.toHaveBeenCalled();
    expect(indexed.service.getState().source).toBe("index");
    const disk = rig(false);
    disk.service.setQuery("foo");
    await disk.service.run();
    expect(disk.ipc.searchRun).toHaveBeenCalled();
    expect(disk.service.getState().source).toBe("disk");
  });

  it("an index failure falls back to the disk, but a bad pattern is the user's to fix", async () => {
    const { ipc, service } = rig(true);
    vi.mocked(ipc.searchTextIndexed).mockRejectedValueOnce(
      "the search index couldn't be used: locked",
    );
    service.setQuery("foo");
    await service.run();
    expect(service.getState()).toMatchObject({ status: "done", source: "disk" });
    vi.mocked(ipc.searchTextIndexed).mockRejectedValueOnce(
      "the search text isn't a valid pattern: (",
    );
    await service.run();
    expect(service.getState().status).toBe("error");
    expect(service.getState().error).toContain("isn't a valid pattern");
  });

  it("result files are drawn a page at a time and long match lists are expanded on request", async () => {
    const { ipc, service } = rig(true);
    vi.mocked(ipc.searchTextIndexed).mockResolvedValue(outcome(100, 1));
    service.setQuery("foo");
    await service.run();
    expect(service.getState().visibleFiles).toBe(RESULT_PAGE);
    service.showMoreFiles();
    expect(service.getState().visibleFiles).toBe(RESULT_PAGE * 2);
    service.expandMatches("f0.ts");
    service.expandMatches("f0.ts");
    expect(service.getState().expandedFiles).toEqual(["f0.ts"]);
    await service.run();
    expect(service.getState()).toMatchObject({ visibleFiles: RESULT_PAGE, expandedFiles: [] });
  });
});
