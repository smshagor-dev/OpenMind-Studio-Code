import { describe, expect, it, vi } from "vitest";

import { createFakeIpc, idleStatus } from "../testUtils/fakeIpcClient";
import { CommandRegistry } from "./commandRegistry";
import type { EditorService } from "./editorService";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { LayoutService } from "./layoutService";
import type { LspService } from "./lspService";
import type { SearchService } from "./searchService";
import { wireSearch } from "./searchWiring";
import type { SettingsService } from "./settingsService";
import type { WorkspaceService } from "./workspaceService";
import { WorkspaceIndexService, indexSettingsFrom } from "./workspaceIndexService";
import type { IndexStatus } from "./searchIpc";

function rig(
  options: { lsp?: boolean; word?: string | null; hasEditor?: boolean; root?: string | null } = {},
) {
  const { lsp = false, word = "startServer", hasEditor = true, root = "C:/My Site" } = options;
  const pushed: ((status: IndexStatus) => void)[] = [];
  const ipc = createFakeIpc({
    onIndexStatus: vi.fn((listener: (status: IndexStatus) => void) => {
      pushed.push(listener);
      return Promise.resolve(() => undefined);
    }),
    searchRun: vi.fn().mockResolvedValue({
      files: [],
      totalMatches: 0,
      filesSearched: 1,
      skippedBinary: 0,
      skippedLarge: 0,
      truncated: false,
      cancelled: false,
      durationMs: 1,
    }),
  });
  const events = new EventBus<AppEvents>();
  const commands = new CommandRegistry();
  const changeHandlers: [string[], () => void][] = [];
  const settings = {
    onChange: (ids: string[], handler: () => void) => {
      changeHandlers.push([ids, handler]);
      return () => undefined;
    },
    bool: (_id: string, fallback: boolean) => fallback,
    number: (_id: string, fallback: number) => fallback,
    string: (_id: string, fallback: string) => fallback,
  } as unknown as SettingsService;
  const workspace = {
    getActiveWorkspace: () => (root === null ? null : { path: root, name: "My Site" }),
    openPath: vi.fn(),
    openPathAt: vi.fn(),
  } as unknown as WorkspaceService;
  const editorRun = vi.fn();
  const editor = {
    hasEditor: () => hasEditor,
    run: editorRun,
    wordAtCursor: () => word,
  } as unknown as EditorService;
  const lspService = {
    activeAvailable: () => ({
      enabled: lsp,
      reason: lsp ? undefined : "Language server is not installed yet.",
    }),
  } as unknown as LspService;
  const showView = vi.fn().mockResolvedValue(undefined);
  const layout = { showView } as unknown as LayoutService;
  const index = new WorkspaceIndexService(
    ipc,
    events,
    () => (root === null ? null : root),
    () => indexSettingsFrom(settings),
  );
  const wiring = wireSearch({
    ipc,
    events,
    commands,
    settings,
    workspace,
    editor,
    lsp: lspService,
    layout,
    search: {} as SearchService,
    index,
  });
  return { ipc, events, commands, editorRun, showView, index, wiring, changeHandlers, pushed };
}

describe("wireSearch: quick open and the Search view", () => {
  it("Go to File and Go to Symbol in Workspace open the picker in their mode", async () => {
    const { commands, wiring, ipc, index, pushed } = rig();
    await index.listen();
    pushed[0]?.(idleStatus({ state: "idle", indexed: 5 }));
    await commands.execute("go.toFile");
    expect(wiring.quickOpen.getState()).toMatchObject({ open: true, mode: "files" });
    await vi.waitFor(() => {
      expect(ipc.searchFilesIndexed).toHaveBeenCalled();
    });
    await commands.execute("go.toSymbolInWorkspace");
    expect(wiring.quickOpen.getState()).toMatchObject({ open: true, mode: "symbols" });
  });

  it("the section commands show the Search view on the right tab and focus it", async () => {
    const { commands, wiring, showView, events } = rig();
    const focus = vi.fn();
    events.on("focusSearch", focus);
    for (const [id, tab] of [
      ["search.showFiles", "files"],
      ["search.showSymbols", "symbols"],
      ["search.showReferences", "references"],
      ["search.showText", "text"],
    ] as const) {
      await commands.execute(id);
      expect(wiring.panel.getState().tab).toBe(tab);
    }
    expect(showView).toHaveBeenCalledWith("search");
    expect(focus).toHaveBeenCalledTimes(4);
  });
});

describe("wireSearch: Find References", () => {
  it("uses the editor's language-server references when a server is running", async () => {
    const { commands, editorRun, ipc, wiring } = rig({ lsp: true });
    for (const id of ["go.toReferences", "lsp.findReferences"]) {
      await commands.execute(id);
      expect(editorRun).toHaveBeenLastCalledWith("editor.action.referenceSearch.trigger");
    }
    expect(ipc.searchRun).not.toHaveBeenCalled();
    expect(wiring.references.getState().status).toBe("idle");
  });

  it("falls back to a labelled text search in the References section when there is no server", async () => {
    const { commands, editorRun, ipc, wiring } = rig({ lsp: false });
    await commands.execute("go.toReferences");
    expect(editorRun).not.toHaveBeenCalled();
    expect(wiring.panel.getState().tab).toBe("references");
    expect(ipc.searchRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ text: "startServer", wholeWord: true, caseSensitive: true }),
    );
    expect(wiring.references.getState()).toMatchObject({
      word: "startServer",
      kind: "text",
      source: "disk",
    });
  });

  it("with no name under the cursor it says so, and without an editor the command is disabled with a reason", async () => {
    const noWord = rig({ word: null });
    await noWord.commands.execute("go.toReferences");
    expect(noWord.wiring.references.getState().error).toContain("cursor on a name");
    const noEditor = rig({ hasEditor: false });
    expect(noEditor.commands.isEnabled("go.toReferences")).toBe(false);
    expect(noEditor.commands.reasonFor("go.toReferences")).toBe("Open a file first.");
  });
});

describe("wireSearch: index commands and events", () => {
  it("the index commands run and every disabled one carries its reason", async () => {
    const { commands, ipc, index, pushed } = rig();
    await index.listen();
    expect(commands.isEnabled("search.rebuildIndex")).toBe(true);
    expect(commands.isEnabled("search.clearIndex")).toBe(false);
    expect(commands.reasonFor("search.clearIndex")).toBe("The search index is empty.");
    expect(commands.reasonFor("search.cancelIndexing")).toBe("Nothing is being indexed.");
    await commands.execute("search.rebuildIndex");
    expect(ipc.indexRebuild).toHaveBeenCalled();
    await commands.execute("search.refreshIndex");
    expect(ipc.indexStart).toHaveBeenCalled();
    pushed[0]?.(idleStatus({ state: "indexing" }));
    expect(commands.isEnabled("search.cancelIndexing")).toBe(true);
    await commands.execute("search.cancelIndexing");
    expect(ipc.indexCancel).toHaveBeenCalled();
    pushed[0]?.(idleStatus({ state: "idle", indexed: 2 }));
    await commands.execute("search.clearIndex");
    expect(ipc.indexClear).toHaveBeenCalled();
    const noFolder = rig({ root: null });
    expect(noFolder.commands.reasonFor("search.rebuildIndex")).toBe("Open a folder first.");
  });

  it("opening a folder starts indexing, a saved file is touched, and an indexing setting restarts a pass", async () => {
    const { events, ipc, changeHandlers, pushed, index } = rig();
    await index.listen();
    pushed[0]?.(idleStatus({ state: "idle", indexed: 4 }));
    events.emit("workspaceFolderChanged", {
      workspace: { id: 1, path: "C:/My Site", name: "My Site" },
    });
    await vi.waitFor(() => {
      expect(ipc.indexStart).toHaveBeenCalledWith(expect.anything(), false);
    });
    pushed[0]?.(idleStatus({ state: "idle", indexed: 4 }));
    events.emit("documentSaved", { id: "d1", path: "C:/My Site/src/a.ts" });
    await vi.waitFor(() => {
      expect(ipc.indexTouch).toHaveBeenCalledWith(["C:/My Site/src/a.ts"]);
    });
    const [ids, handler] = changeHandlers[0] ?? [[], () => undefined];
    expect(ids).toContain("search.indexing.maxFileSizeKb");
    handler();
    await vi.waitFor(() => {
      expect(ipc.indexStart).toHaveBeenLastCalledWith(expect.anything(), true);
    });
  });
});
