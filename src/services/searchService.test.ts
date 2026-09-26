import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { IpcClient, SearchOutcome } from "./ipc";
import { OutputService } from "./outputService";
import { parsePatterns, SearchService } from "./searchService";

function outcome(overrides: Partial<SearchOutcome> = {}): SearchOutcome {
  return {
    files: [
      {
        path: "C:/p/src/a.rs",
        relativePath: "src/a.rs",
        matches: [
          {
            line: 3,
            column: 5,
            length: 6,
            preview: "let needle = 1;",
            previewStart: 4,
            previewEnd: 10,
          },
        ],
      },
    ],
    totalMatches: 1,
    filesSearched: 4,
    skippedBinary: 0,
    skippedLarge: 0,
    truncated: false,
    cancelled: false,
    durationMs: 12,
    ...overrides,
  };
}

describe("SearchService", () => {
  let ipc: IpcClient;
  let output: OutputService;
  let events: EventBus<AppEvents>;
  let root: string | null;
  const opener = { openPathAt: vi.fn().mockResolvedValue("tab") };
  let service: SearchService;

  function make(overrides: Partial<IpcClient> = {}) {
    ipc = createFakeIpc({ searchRun: vi.fn().mockResolvedValue(outcome()), ...overrides });
    service = new SearchService(ipc, events, output, () => root, opener);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    output = new OutputService();
    events = new EventBus<AppEvents>();
    root = "C:/p";
    opener.openPathAt.mockClear();
    make();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs a search against the open folder with the chosen options and patterns", async () => {
    service.setQuery("needle");
    service.toggleOption("caseSensitive");
    service.toggleOption("useRegex");
    service.setInclude("*.rs, src/**");
    service.setExclude(" docs ,");

    await service.run();

    expect(ipc.searchRun).toHaveBeenLastCalledWith(expect.stringMatching(/^search-\d+$/), {
      root: "C:/p",
      text: "needle",
      caseSensitive: true,
      wholeWord: false,
      useRegex: true,
      include: ["*.rs", "src/**"],
      exclude: ["docs"],
      maxResults: 10000,
    });
    expect(service.getState()).toMatchObject({ status: "done", error: null });
    expect(service.getState().outcome?.totalMatches).toBe(1);
  });

  it("typing searches after a short pause, once, with the latest text", async () => {
    service.setQuery("n");
    service.setQuery("ne");
    service.setQuery("needle");
    expect(ipc.searchRun).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(400);

    expect(ipc.searchRun).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ipc.searchRun).mock.calls[0]?.[1].text).toBe("needle");
  });

  it("an empty query clears the results instead of searching", async () => {
    service.setQuery("x");
    await service.run();

    service.setQuery("");

    expect(service.getState()).toMatchObject({ status: "idle", outcome: null });
    expect(ipc.searchRun).toHaveBeenCalledTimes(1);
  });

  it("without an open folder it explains instead of searching", async () => {
    root = null;
    service.setQuery("x");

    await service.run();

    expect(service.getState()).toMatchObject({
      status: "error",
      error: "Open a folder to search in it.",
    });
    expect(ipc.searchRun).not.toHaveBeenCalled();
  });

  it("a newer search cancels the one in flight and its late answer is ignored", async () => {
    let finishFirst: (value: SearchOutcome) => void = () => undefined;
    const searchRun = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<SearchOutcome>((resolve) => (finishFirst = resolve)),
      )
      .mockResolvedValueOnce(outcome({ totalMatches: 7 }));
    make({ searchRun });
    service.setQuery("first");
    const first = service.run();
    service.setQuery("second");

    await service.run();
    finishFirst(outcome({ totalMatches: 1 }));
    await first;

    expect(ipc.searchCancel).toHaveBeenCalledTimes(1);
    expect(service.getState().outcome?.totalMatches).toBe(7);
  });

  it("a failing search shows the error and logs it, without throwing", async () => {
    make({ searchRun: vi.fn().mockRejectedValue("the search text isn't a valid pattern") });
    service.setQuery("(");

    await service.run();

    expect(service.getState()).toMatchObject({
      status: "error",
      error: "the search text isn't a valid pattern",
    });
    expect(output.getLines("Search").join("\n")).toContain("failed");
  });

  it("logs a summary to the Search output channel, including limits and skipped files", async () => {
    make({
      searchRun: vi
        .fn()
        .mockResolvedValue(outcome({ truncated: true, skippedBinary: 2, skippedLarge: 1 })),
    });
    service.setQuery("needle");

    await service.run();

    const line = output.getLines("Search").join("\n");
    expect(line).toContain('Searched (files) for "needle": 1 match in 1 file');
    expect(line).toContain("result limit");
    expect(line).toContain("2 binary and 1 large");
  });

  it("cancel stops a running search", () => {
    make({ searchRun: vi.fn(() => new Promise<SearchOutcome>(() => undefined)) });
    service.setQuery("x");
    void service.run();

    service.cancel();

    expect(ipc.searchCancel).toHaveBeenCalled();
    expect(service.getState().status).toBe("idle");
  });

  it("folds and unfolds result files", async () => {
    service.setQuery("needle");
    await service.run();

    service.toggleFile("src/a.rs");
    expect(service.getState().collapsed).toEqual(["src/a.rs"]);
    service.toggleFile("src/a.rs");
    expect(service.getState().collapsed).toEqual([]);
    service.collapseAll();
    expect(service.getState().collapsed).toEqual(["src/a.rs"]);
    service.expandAll();
    expect(service.getState().collapsed).toEqual([]);
  });

  it("opening a match opens the file at its position", async () => {
    service.setQuery("needle");
    await service.run();
    const file = service.getState().outcome?.files[0];
    const match = file?.matches[0];

    if (file && match) await service.openMatch(file, match);

    expect(opener.openPathAt).toHaveBeenCalledWith("C:/p/src/a.rs", {
      line: 3,
      column: 5,
      length: 6,
    });
  });

  it("clear resets the query and the results", async () => {
    service.setQuery("needle");
    await service.run();

    service.clear();

    expect(service.getState()).toMatchObject({ query: "", outcome: null, status: "idle" });
  });

  it("parsePatterns splits on commas and drops blanks", () => {
    expect(parsePatterns(" *.ts , , src/** ")).toEqual(["*.ts", "src/**"]);
    expect(parsePatterns("")).toEqual([]);
  });
});
