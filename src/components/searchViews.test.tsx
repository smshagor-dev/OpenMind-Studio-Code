import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeIpc, idleStatus } from "../testUtils/fakeIpcClient";
import { EventBus } from "../services/eventBus";
import type { AppEvents } from "../services/events";
import { FileSearchService } from "../services/fileSearchService";
import type { SearchOutcome } from "../services/ipc";
import { OutputService } from "../services/outputService";
import { QuickOpenService } from "../services/quickOpenService";
import { ReferenceSearchService } from "../services/referenceSearchService";
import type { FileHit, IndexStatus, SymbolHit } from "../services/searchIpc";
import { SearchPanelService } from "../services/searchPanelService";
import { SearchService } from "../services/searchService";
import { SymbolSearchService } from "../services/symbolSearchService";
import { indexSettingsFrom, WorkspaceIndexService } from "../services/workspaceIndexService";

const harness = vi.hoisted((): { current: unknown } => ({ current: null }));

vi.mock("../services/container", () => ({
  get container() {
    return harness.current;
  },
}));

import { QuickOpen } from "./QuickOpen";
import { SearchView } from "./SearchView";

const hit = (relativePath: string, highlights: [number, number][] = []): FileHit => ({
  path: `C:/My Site/${relativePath}`,
  relativePath,
  name: relativePath.split("/").pop() ?? relativePath,
  score: 1,
  highlights,
});

const symbolHit = (name: string, extra: Partial<SymbolHit> = {}): SymbolHit => ({
  name,
  kind: "function",
  line: 3,
  column: 8,
  container: null,
  path: "C:/My Site/src/app.ts",
  relativePath: "src/app.ts",
  language: "typescript",
  score: 1,
  ...extra,
});

const outcome = (files: number, matches = 1): SearchOutcome => ({
  files: Array.from({ length: files }, (_, f) => ({
    path: `C:/My Site/f${String(f)}.ts`,
    relativePath: `f${String(f)}.ts`,
    matches: Array.from({ length: matches }, (_, m) => ({
      line: m + 1,
      column: 1,
      length: 6,
      preview: "needle",
      previewStart: 0,
      previewEnd: 6,
    })),
  })),
  totalMatches: files * matches,
  filesSearched: files,
  skippedBinary: 0,
  skippedLarge: 0,
  truncated: false,
  cancelled: false,
  durationMs: 1,
});

function mount(overrides: Parameters<typeof createFakeIpc>[0] = {}) {
  const pushed: ((status: IndexStatus) => void)[] = [];
  const ipc = createFakeIpc({
    onIndexStatus: vi.fn((listener: (status: IndexStatus) => void) => {
      pushed.push(listener);
      return Promise.resolve(() => undefined);
    }),
    searchFilesIndexed: vi.fn().mockResolvedValue([]),
    searchSymbolsIndexed: vi.fn().mockResolvedValue([]),
    ...overrides,
  });
  const events = new EventBus<AppEvents>();
  const workspace = {
    openPath: vi.fn().mockResolvedValue("tab"),
    openPathAt: vi.fn().mockResolvedValue("tab"),
  };
  const root = () => "C:/My Site";
  const index = new WorkspaceIndexService(ipc, events, root, () =>
    indexSettingsFrom({
      bool: (_id, fallback) => fallback,
      number: (_id, fallback) => fallback,
      string: (_id, fallback) => fallback,
    }),
  );
  const hasFiles = () => index.hasFiles();
  const search = new SearchService(ipc, events, new OutputService(), root, workspace, index);
  const fileSearch = new FileSearchService(ipc, workspace, root, hasFiles);
  const symbolSearch = new SymbolSearchService(ipc, workspace, root, hasFiles);
  const quickOpen = new QuickOpenService(
    new FileSearchService(ipc, workspace, root, hasFiles),
    new SymbolSearchService(ipc, workspace, root, hasFiles),
  );
  const references = new ReferenceSearchService(ipc, workspace, root, () => index.isReady());
  const panel = new SearchPanelService();
  const run = vi.fn();
  harness.current = {
    events,
    search,
    searchPanel: panel,
    workspaceIndex: index,
    fileSearch,
    symbolSearch,
    references,
    quickOpen,
    run,
  };
  return {
    ipc,
    events,
    workspace,
    index,
    search,
    fileSearch,
    symbolSearch,
    references,
    quickOpen,
    panel,
    pushed,
    run,
  };
}

beforeEach(() => {
  harness.current = null;
});

describe("SearchView sections", () => {
  it("shows Text, Files, Symbols and References sections and switches between them", () => {
    const { panel } = mount();
    render(<SearchView />);
    const tabs = within(screen.getByRole("tablist", { name: "Search sections" })).getAllByRole(
      "tab",
    );
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Text", "Files", "Symbols", "References"]);
    expect(screen.getByLabelText("Search")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    expect(panel.getState().tab).toBe("files");
    expect(screen.getByLabelText("Search files by name")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Symbols" }));
    expect(screen.getByLabelText("Search symbols")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "References" }));
    expect(screen.getByText(/Go to References \(Shift\+F12\)/)).toBeTruthy();
  });
});

describe("the index bar", () => {
  it("shows building progress with Cancel, then the ready state with Refresh, Rebuild and Clear", async () => {
    const { index, pushed, ipc } = mount({
      indexStart: vi.fn().mockResolvedValue(idleStatus({ state: "idle", indexed: 120 })),
    });
    render(<SearchView />);
    await index.listen();
    expect(screen.getByRole("status").textContent).toBe("Index: not built");
    pushed[0]?.(idleStatus({ state: "indexing", discovered: 200, processed: 50 }));
    expect(await screen.findByText("Indexing 50/200")).toBeTruthy();
    expect(screen.getByLabelText("Indexing progress")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(ipc.indexCancel).toHaveBeenCalled();
    pushed[0]?.(idleStatus({ state: "idle", indexed: 120, symbols: 300 }));
    expect(await screen.findByText("Index: 120 files")).toBeTruthy();
    expect(screen.getByRole("status").getAttribute("title")).toContain("300 symbols");
    // Each action is sent once and the bar is usable again when it has been answered.
    for (const [name, call] of [
      ["Rebuild", ipc.indexRebuild],
      ["Refresh", ipc.indexStart],
      ["Clear", ipc.indexClear],
    ] as const) {
      await waitFor(() => {
        expect(screen.getByRole<HTMLButtonElement>("button", { name }).disabled).toBe(false);
      });
      fireEvent.click(screen.getByRole("button", { name }));
      await waitFor(() => {
        expect(call).toHaveBeenCalled();
      });
    }
  });

  it("shows an index error as an alert and disables Clear with its reason when the index is empty", async () => {
    const { index, pushed } = mount();
    render(<SearchView />);
    await index.listen();
    const clear = screen.getByRole("button", { name: "Clear" });
    expect((clear as HTMLButtonElement).disabled).toBe(true);
    expect(clear.getAttribute("title")).toBe("The search index is empty.");
    pushed[0]?.(idleStatus({ state: "error", error: "the search index couldn't be used: locked" }));
    expect((await screen.findByRole("alert")).textContent).toContain("locked");
    expect(screen.getByText("Index error")).toBeTruthy();
  });
});

describe("Files section", () => {
  it("lists ranked results with the matched letters highlighted and opens one on click", async () => {
    const { ipc, index, pushed, workspace } = mount({
      searchFilesIndexed: vi
        .fn()
        .mockResolvedValue([hit("src/app.ts", [[4, 7]]), hit("readme.md")]),
    });
    render(<SearchView />);
    await index.listen();
    pushed[0]?.(idleStatus({ state: "idle", indexed: 9 }));
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    fireEvent.change(screen.getByLabelText("Search files by name"), { target: { value: "app" } });
    const list = await screen.findByRole("list", { name: "File results" });
    await waitFor(() => {
      expect(within(list).getAllByRole("button")).toHaveLength(2);
    });
    expect(ipc.searchFilesIndexed).toHaveBeenLastCalledWith("app", null, 100);
    expect(within(list).getByText("app", { selector: "mark" })).toBeTruthy();
    expect(screen.getByText("2 files")).toBeTruthy();
    fireEvent.click(within(list).getAllByRole("button")[0] as HTMLElement);
    await waitFor(() => {
      expect(workspace.openPath).toHaveBeenCalledWith("C:/My Site/src/app.ts");
    });
  });

  it("says when nothing was found, and that the index has no files yet", async () => {
    const { index, pushed } = mount();
    render(<SearchView />);
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    fireEvent.change(screen.getByLabelText("Search files by name"), { target: { value: "x" } });
    expect((await screen.findByRole("alert")).textContent).toContain("no files yet");
    await index.listen();
    pushed[0]?.(idleStatus({ state: "idle", indexed: 3 }));
    fireEvent.change(screen.getByLabelText("Search files by name"), { target: { value: "zzz" } });
    expect(await screen.findByText("No files found.")).toBeTruthy();
  });
});

describe("Symbols section", () => {
  it("lists symbols with their kind, container and path, filters by kind and opens one at its line", async () => {
    const { ipc, index, pushed, workspace } = mount({
      searchSymbolsIndexed: vi
        .fn()
        .mockResolvedValue([
          symbolHit("startServer"),
          symbolHit("handle", { kind: "method", container: "Router", line: 9 }),
        ]),
    });
    render(<SearchView />);
    await index.listen();
    pushed[0]?.(idleStatus({ state: "idle", indexed: 9 }));
    fireEvent.click(screen.getByRole("tab", { name: "Symbols" }));
    const list = await screen.findByRole("list", { name: "Symbol results" });
    await waitFor(() => {
      expect(within(list).getAllByRole("button")).toHaveLength(2);
    });
    expect(screen.getByText("Router · src/app.ts:9")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Symbol kind"), { target: { value: "method" } });
    await waitFor(() => {
      expect(ipc.searchSymbolsIndexed).toHaveBeenLastCalledWith("", "method", 200);
    });
    fireEvent.click(within(list).getAllByRole("button")[1] as HTMLElement);
    await waitFor(() => {
      expect(workspace.openPathAt).toHaveBeenCalledWith("C:/My Site/src/app.ts", {
        line: 9,
        column: 8,
        length: 6,
      });
    });
  });
});

describe("References section", () => {
  it("labels fallback results as text-based, groups them by file and opens a match", async () => {
    const { references, panel, workspace, ipc } = mount();
    vi.mocked(ipc.searchRun).mockResolvedValue(outcome(2, 2));
    panel.setTab("references");
    render(<SearchView />);
    await references.find("needle");
    expect(await screen.findByText("Text-based references")).toBeTruthy();
    expect(screen.getByText(/not semantic references/)).toBeTruthy();
    expect(screen.getByText(/4 matches in 2 files/)).toBeTruthy();
    const list = screen.getByRole("list", { name: "Reference results" });
    fireEvent.click(within(list).getAllByTitle(/Line 1, column 1/)[0] as HTMLElement);
    await waitFor(() => {
      expect(workspace.openPathAt).toHaveBeenCalledWith("C:/My Site/f0.ts", {
        line: 1,
        column: 1,
        length: 6,
      });
    });
  });

  it("shows no-results and error states", async () => {
    const { references, panel } = mount();
    panel.setTab("references");
    render(<SearchView />);
    await references.find("nothing");
    expect(await screen.findByText("No references found.")).toBeTruthy();
    await references.find("two words");
    expect((await screen.findByRole("alert")).textContent).toContain("cursor on a name");
  });
});

describe("Text section results at scale", () => {
  it("draws a page of files with Show more", async () => {
    const { search, ipc, index, pushed } = mount();
    await index.listen();
    pushed[0]?.(idleStatus({ state: "idle", indexed: 9 }));
    vi.mocked(ipc.searchTextIndexed).mockResolvedValue(outcome(90, 1));
    search.setQuery("needle");
    await search.run();
    render(<SearchView />);
    const list = screen.getByRole("list", { name: "Search results" });
    const files = () => list.querySelectorAll(":scope > li");
    expect(files()).toHaveLength(40);
    expect(screen.getByText(/from the index/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Show 40 more files \(50 not shown\)/ }));
    expect(files()).toHaveLength(80);
    fireEvent.click(screen.getByRole("button", { name: /Show 10 more files \(10 not shown\)/ }));
    expect(files()).toHaveLength(90);
    expect(screen.queryByRole("button", { name: /more files/ })).toBeNull();
  });

  it("cuts one file's long match list at 100 until asked to show all", async () => {
    const { search, ipc, index, pushed } = mount();
    await index.listen();
    pushed[0]?.(idleStatus({ state: "idle", indexed: 9 }));
    vi.mocked(ipc.searchTextIndexed).mockResolvedValue(outcome(1, 150));
    search.setQuery("needle");
    await search.run();
    render(<SearchView />);
    const file = screen.getByRole("list", { name: "Search results" }).querySelector(":scope > li");
    const buttons = () => file?.querySelectorAll("button").length ?? 0;
    expect(buttons()).toBe(1 + 100 + 1); // header, 100 matches, "show all"
    fireEvent.click(screen.getByRole("button", { name: "Show all 150 matches in this file" }));
    expect(buttons()).toBe(1 + 150);
  });

  it("offers Cancel while searching and Clear afterwards, and says which source answered", async () => {
    const { search, ipc } = mount();
    let release: (value: SearchOutcome) => void = () => undefined;
    vi.mocked(ipc.searchRun).mockImplementation(
      () =>
        new Promise<SearchOutcome>((resolve) => {
          release = resolve;
        }),
    );
    render(<SearchView />);
    search.setQuery("needle");
    const pending = search.run();
    expect(await screen.findByText("Searching…")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(ipc.searchCancel).toHaveBeenCalled();
    release(outcome(1));
    await pending;
    vi.mocked(ipc.searchRun).mockResolvedValue(outcome(1));
    await search.run();
    expect(await screen.findByText(/read from disk \(no index yet\)/)).toBeTruthy();
    const summary = screen.getByText(/read from disk/).closest("p") as HTMLElement;
    fireEvent.click(within(summary).getByRole("button", { name: "Clear" }));
    expect(screen.getByLabelText<HTMLInputElement>("Search").value).toBe("");
  });
});

describe("QuickOpen", () => {
  it("is hidden until asked, then filters as you type and opens the highlighted file with Enter", async () => {
    const searchFiles = vi.fn().mockResolvedValue([hit("src/app.ts", [[4, 7]]), hit("readme.md")]);
    const { quickOpen, index, pushed, workspace } = mount({ searchFilesIndexed: searchFiles });
    render(<QuickOpen />);
    expect(screen.queryByRole("dialog")).toBeNull();
    await index.listen();
    pushed[0]?.(idleStatus({ state: "idle", indexed: 9 }));
    quickOpen.show("files");
    const dialog = await screen.findByRole("dialog", { name: "Go to File" });
    const input = within(dialog).getByRole("combobox");
    expect(document.activeElement).toBe(input);
    const options = await within(dialog).findAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");
    fireEvent.change(input, { target: { value: "app" } });
    await waitFor(() => {
      expect(searchFiles).toHaveBeenLastCalledWith("app", null, 100);
    });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    await waitFor(() => {
      expect(within(dialog).getAllByRole("option")[1]?.getAttribute("aria-selected")).toBe("true");
    });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(workspace.openPath).toHaveBeenCalledWith("C:/My Site/readme.md");
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Escape and a click outside close it; symbol mode shows the kind badge; an empty result says so", async () => {
    const { quickOpen, index, pushed } = mount({
      searchSymbolsIndexed: vi.fn().mockResolvedValue([symbolHit("startServer")]),
    });
    render(<QuickOpen />);
    await index.listen();
    pushed[0]?.(idleStatus({ state: "idle", indexed: 9 }));
    quickOpen.show("symbols");
    const dialog = await screen.findByRole("dialog", { name: "Go to Symbol in Workspace" });
    expect((await within(dialog).findAllByRole("option"))[0]?.textContent).toContain("function");
    fireEvent.keyDown(within(dialog).getByRole("combobox"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    quickOpen.show("files");
    const again = await screen.findByRole("dialog");
    expect(await within(again).findByText("No matching results.")).toBeTruthy();
    fireEvent.mouseDown(again.parentElement as HTMLElement);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
