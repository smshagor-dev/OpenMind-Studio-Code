import type { CommandRegistry } from "./commandRegistry";
import type { DocumentService } from "./documentService";
import type { EditorService, EditorViewOptions } from "./editorService";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { IpcClient } from "./ipc";
import type { LayoutService } from "./layoutService";
import type { ThemeService } from "./themeService";
import type { WindowService } from "./windowService";
import type { WorkspaceService } from "./workspaceService";

export interface WorkbenchDeps {
  commands: CommandRegistry;
  events: EventBus<AppEvents>;
  ipc: IpcClient;
  documents: DocumentService;
  workspace: WorkspaceService;
  editor: EditorService;
  layout: LayoutService;
  window: WindowService;
  theme: ThemeService;
}

/**
 * Menu command id → the Monaco action/command it runs. Monaco already
 * implements all of these (and binds their default keys itself while the
 * editor has focus); the menu just needs a way to invoke them.
 */
export const EDITOR_ACTIONS: Record<string, string> = {
  "edit.undo": "undo",
  "edit.redo": "redo",
  "edit.cut": "editor.action.clipboardCutAction",
  "edit.copy": "editor.action.clipboardCopyAction",
  "edit.paste": "editor.action.clipboardPasteAction",
  "edit.find": "actions.find",
  "edit.replace": "editor.action.startFindReplaceAction",
  "edit.toggleLineComment": "editor.action.commentLine",
  "edit.toggleBlockComment": "editor.action.blockComment",
  "selection.selectAll": "editor.action.selectAll",
  "selection.expand": "editor.action.smartSelect.expand",
  "selection.shrink": "editor.action.smartSelect.shrink",
  "selection.copyLineUp": "editor.action.copyLinesUpAction",
  "selection.copyLineDown": "editor.action.copyLinesDownAction",
  "selection.moveLineUp": "editor.action.moveLinesUpAction",
  "selection.moveLineDown": "editor.action.moveLinesDownAction",
  "selection.duplicate": "editor.action.duplicateSelection",
  "selection.addCursorAbove": "editor.action.insertCursorAbove",
  "selection.addCursorBelow": "editor.action.insertCursorBelow",
  "selection.addCursorsToLineEnds": "editor.action.insertCursorAtEndOfEachLineSelected",
  "selection.addNextOccurrence": "editor.action.addSelectionToNextFindMatch",
  "selection.addPreviousOccurrence": "editor.action.addSelectionToPreviousFindMatch",
  "selection.selectAllOccurrences": "editor.action.selectHighlights",
  "go.toSymbolInEditor": "editor.action.quickOutline",
  "go.toLine": "editor.action.gotoLine",
  "go.toBracket": "editor.action.jumpToBracket",
  "go.nextProblem": "editor.action.marker.nextInFiles",
  "go.previousProblem": "editor.action.marker.prevInFiles",
  "workbench.commandPalette": "editor.action.quickCommand",
};

/** Menu command id → the editor view option it toggles. */
export const EDITOR_TOGGLES: Record<string, keyof EditorViewOptions> = {
  "view.toggleWordWrap": "wordWrap",
  "view.toggleMinimap": "minimap",
  "view.toggleStickyScroll": "stickyScroll",
  "view.toggleRenderWhitespace": "renderWhitespace",
  "view.toggleRenderControlCharacters": "renderControlCharacters",
  "selection.toggleColumnSelection": "columnSelection",
  "selection.toggleMultiCursorModifier": "ctrlClickMultiCursor",
};

export function registerWorkbenchCommands(deps: WorkbenchDeps): void {
  registerFileCommands(deps);
  registerEditorCommands(deps);
  registerViewCommands(deps);
}

function activeId(deps: WorkbenchDeps): string | null {
  return deps.workspace.getState().activeId;
}

function registerFileCommands(deps: WorkbenchDeps): void {
  const { commands, workspace, documents, ipc, events } = deps;
  commands.register("file.openRecentFolder", async (path) => {
    if (typeof path === "string") await workspace.openFolder(path);
  });
  commands.register("file.openRecentFile", async (path) => {
    if (typeof path === "string") await workspace.openPath(path);
  });
  commands.register("file.reopenClosed", () => workspace.reopenClosed(), {
    enabled: () => workspace.canReopenClosed(),
  });
  commands.register("file.clearRecent", () => ipc.recentFilesClear());
  commands.register("file.saveAll", () => workspace.saveAll(), {
    enabled: () => workspace.getState().tabs.some((tab) => tab.dirty),
  });
  commands.register(
    "file.revert",
    () => {
      const id = activeId(deps);
      if (id) workspace.revert(id);
    },
    {
      enabled: () => {
        const id = activeId(deps);
        return id !== null && documents.isDirty(id);
      },
    },
  );
  commands.register("workbench.closeAllEditors", () => workspace.closeAll(), {
    enabled: () => workspace.getState().tabs.length > 0,
  });
  commands.register("file.closeWindow", () => deps.window.close());
  commands.register("workbench.exit", () => deps.window.close());
  commands.register("help.about", () => {
    events.emit("showAbout", undefined);
  });
}

function registerEditorCommands(deps: WorkbenchDeps): void {
  const { commands, editor, workspace } = deps;
  const hasEditor = () => editor.hasEditor();
  for (const [id, action] of Object.entries(EDITOR_ACTIONS)) {
    commands.register(
      id,
      () => {
        editor.run(action);
      },
      { enabled: hasEditor },
    );
  }
  for (const [id, option] of Object.entries(EDITOR_TOGGLES)) {
    commands.register(id, () => editor.toggleOption(option), {
      checked: () => editor.getOptions()[option],
    });
  }
  const multipleTabs = () => workspace.getState().tabs.length > 1;
  commands.register(
    "go.nextEditor",
    () => {
      workspace.cycleActive(1);
    },
    { enabled: multipleTabs },
  );
  commands.register(
    "go.previousEditor",
    () => {
      workspace.cycleActive(-1);
    },
    { enabled: multipleTabs },
  );
}

function registerViewCommands(deps: WorkbenchDeps): void {
  const { commands, layout, theme } = deps;
  const win = deps.window;
  commands.register("view.toggleFullScreen", () => win.toggleFullscreen(), {
    checked: () => win.getState().fullscreen,
  });
  commands.register("view.zoomIn", () => win.zoomIn());
  commands.register("view.zoomOut", () => win.zoomOut());
  commands.register("view.zoomReset", () => win.zoomReset());

  commands.register("view.toggleSidebar", () => layout.toggle("sidebarVisible"), {
    checked: () => layout.getState().sidebarVisible,
  });
  commands.register("view.toggleStatusBar", () => layout.toggle("statusBarVisible"), {
    checked: () => layout.getState().statusBarVisible,
  });
  commands.register("view.toggleBreadcrumbs", () => layout.toggle("breadcrumbsVisible"), {
    checked: () => layout.getState().breadcrumbsVisible,
  });
  commands.register("view.toggleSidebarPosition", () => layout.toggleSidebarPosition(), {
    checked: () => layout.getState().sidebarPosition === "right",
  });
  commands.register("explorer.toggleOpenEditors", () => layout.toggle("openEditorsVisible"), {
    checked: () => layout.getState().openEditorsVisible,
  });
  commands.register("theme.setDark", () => theme.setTheme("dark"), {
    checked: () => theme.getTheme() === "dark",
  });
  commands.register("theme.setLight", () => theme.setTheme("light"), {
    checked: () => theme.getTheme() === "light",
  });
}
