import type { CommandRegistry } from "./commandRegistry";
import type { EditorService } from "./editorService";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import { FileSearchService } from "./fileSearchService";
import type { IpcClient } from "./ipc";
import type { LayoutService } from "./layoutService";
import type { LspService } from "./lspService";
import { QuickOpenService } from "./quickOpenService";
import { ReferenceSearchService } from "./referenceSearchService";
import { SearchPanelService, type SearchTab } from "./searchPanelService";
import type { SearchService } from "./searchService";
import type { SettingsService } from "./settingsService";
import { SymbolSearchService } from "./symbolSearchService";
import type { WorkspaceService } from "./workspaceService";
import { INDEX_SETTING_IDS, type WorkspaceIndexService } from "./workspaceIndexService";

export interface SearchWiringDeps {
  ipc: IpcClient;
  events: EventBus<AppEvents>;
  commands: CommandRegistry;
  settings: SettingsService;
  workspace: WorkspaceService;
  editor: EditorService;
  lsp: LspService;
  layout: LayoutService;
  search: SearchService;
  index: WorkspaceIndexService;
}

/**
 * Connects the workspace index to everything around it: the file, symbol and reference searches, the quick picker
 * (Go to File, Go to Symbol in Workspace), the Search view's sections, the index follows the open folder, the
 * settings and saved files, and the commands (index actions, references). Called once by the composition root.
 */
export function wireSearch(deps: SearchWiringDeps) {
  const { ipc, events, commands, settings, workspace, editor, lsp, layout, search, index } = deps;
  const getRoot = () => workspace.getActiveWorkspace()?.path ?? null;
  const panel = new SearchPanelService();
  const fileSearch = new FileSearchService(ipc, workspace, getRoot, () => index.hasFiles());
  const serverSymbols = (query: string, limit: number) => ipc.lspWorkspaceSymbols(query, limit);
  const symbolSearch = new SymbolSearchService(ipc, workspace, getRoot, () => index.hasFiles(), serverSymbols);
  const quickOpen = new QuickOpenService(
    new FileSearchService(ipc, workspace, getRoot, () => index.hasFiles()),
    new SymbolSearchService(ipc, workspace, getRoot, () => index.hasFiles(), serverSymbols),
  );
  const references = new ReferenceSearchService(ipc, workspace, getRoot, () => index.isReady());

  const showTab = async (tab: SearchTab) => {
    await layout.showView("search");
    panel.setTab(tab);
    events.emit("focusSearch", undefined);
  };

  // The index follows the folder, the settings and saved files.
  events.on("workspaceFolderChanged", () => {
    void index.onWorkspaceChanged();
  });
  events.on("documentSaved", ({ path }) => {
    void index.touch(path);
  });
  settings.onChange(INDEX_SETTING_IDS, () => {
    void index.start(true);
  });

  commands.register("go.toFile", () => {
    quickOpen.show("files");
  });
  commands.register("go.toSymbolInWorkspace", () => {
    quickOpen.show("symbols");
  });
  commands.register("search.showText", () => showTab("text"));
  commands.register("search.showFiles", () => showTab("files"));
  commands.register("search.showSymbols", () => showTab("symbols"));
  commands.register("search.showReferences", () => showTab("references"));

  const indexAction = (
    id: string,
    action: "start" | "rebuild" | "clear" | "cancel",
    run: () => Promise<void>,
  ) => {
    commands.register(id, run, {
      enabled: () => index.actionReason(action) === null,
      disabledReason: () => index.actionReason(action) ?? undefined,
    });
  };
  indexAction("search.refreshIndex", "start", () => index.refresh());
  indexAction("search.rebuildIndex", "rebuild", () => index.rebuild());
  indexAction("search.clearIndex", "clear", () => index.clear());
  indexAction("search.cancelIndexing", "cancel", () => index.cancel());

  // Find References: the language server's own answer (shown by the editor) when one is running, otherwise
  // the text-based fallback in the Search view, labelled as such.
  const findReferences = async () => {
    if (lsp.activeAvailable("references").enabled) {
      editor.run("editor.action.referenceSearch.trigger");
      return;
    }
    const word = editor.wordAtCursor() ?? "";
    await showTab("references");
    await references.find(word);
  };
  const referencesReason = () => (editor.hasEditor() ? undefined : "Open a file first.");
  for (const id of ["go.toReferences", "lsp.findReferences"]) {
    commands.register(id, findReferences, {
      enabled: () => editor.hasEditor(),
      disabledReason: referencesReason,
    });
  }

  return { panel, fileSearch, symbolSearch, quickOpen, references, showTab, search };
}
