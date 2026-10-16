import type { CommandRegistry } from "./commandRegistry";
import type { DocumentService } from "./documentService";
import type { ExplorerService } from "./explorerService";
import type { IpcClient } from "./ipc";
import type { LayoutService } from "./layoutService";
import type { ThemeService } from "./themeService";
import type { WorkspaceService } from "./workspaceService";
import { t } from "../i18n";

export interface FileCommandDeps {
  commands: CommandRegistry;
  ipc: IpcClient;
  workspace: WorkspaceService;
  documents: DocumentService;
  explorer: ExplorerService;
  layout: LayoutService;
  theme: ThemeService;
}

/** Whether the window has a tab in front. */
export function hasActiveTab(workspace: WorkspaceService): boolean {
  return workspace.getState().activeId !== null;
}

/** A file preview is read-only: Save and Save As only apply to a text tab (they never pretend to save a preview). */
function activeTabIsText(workspace: WorkspaceService): boolean {
  const state = workspace.getState();
  const tab = state.tabs.find((candidate) => candidate.id === state.activeId);
  return tab !== undefined && tab.kind !== "filePreview";
}

/** File > New / Open / Open Folder / Close Folder / Save / Save As / Close, the theme toggle and the Explorer's own commands. */
export function registerFileCommands(deps: FileCommandDeps): void {
  const { commands, ipc, workspace, documents, explorer, layout, theme } = deps;
  const isText = () => activeTabIsText(workspace);
  const notTextReason = () =>
    hasActiveTab(workspace) && !isText() ? t("editor.previewNothingToSave") : undefined;

  commands.register("file.new", async () => {
    await workspace.ensureWorkspace();
    workspace.createUntitled();
  });

  commands.register("file.open", async () => {
    const path = await ipc.openDocumentDialog();
    if (path) {
      await workspace.openPath(path);
    }
  });

  commands.register("file.openFolder", async () => {
    const path = await ipc.openFolderDialog();
    if (path) {
      await workspace.openFolder(path);
    }
  });

  commands.register(
    "file.closeFolder",
    async () => {
      await workspace.closeFolder();
    },
    { enabled: () => workspace.getActiveWorkspace() !== null },
  );

  commands.register(
    "file.save",
    async () => {
      const { activeId } = workspace.getState();
      if (activeId) {
        await workspace.save(activeId);
      }
    },
    { enabled: isText, disabledReason: notTextReason },
  );

  commands.register(
    "file.saveAs",
    async () => {
      const { activeId } = workspace.getState();
      if (activeId) {
        await workspace.saveAs(activeId);
      }
    },
    { enabled: isText, disabledReason: notTextReason },
  );

  commands.register(
    "file.closeActiveTab",
    async () => {
      const { activeId } = workspace.getState();
      if (activeId) {
        await workspace.close(activeId);
      }
    },
    { enabled: () => hasActiveTab(workspace) },
  );

  commands.register("view.toggleTheme", async () => {
    // Toggles between the dark and light themes (from High Contrast it goes to dark).
    await theme.setMode(theme.getTheme() === "dark" ? "light" : "dark");
  });

  registerExplorerCommands(commands, workspace, documents, explorer, layout);
}

function registerExplorerCommands(
  commands: CommandRegistry,
  workspace: WorkspaceService,
  documents: DocumentService,
  explorer: ExplorerService,
  layout: LayoutService,
): void {
  // As in VS Code: the Explorer asks for the name in the tree; nothing is created until one is given.
  commands.register("explorer.newFile", async () => {
    if (!explorer.getSnapshot().rootPath && !await workspace.ensureWorkspace()) return;
    await layout.showView("explorer");
    await explorer.beginCreate("file");
  });

  commands.register("explorer.newFolder", async () => {
    if (!explorer.getSnapshot().rootPath && !await workspace.ensureWorkspace()) return;
    await layout.showView("explorer");
    await explorer.beginCreate("folder");
  });

  commands.register("explorer.refresh", async () => {
    await explorer.refresh();
  });

  commands.register("explorer.collapseAll", async () => {
    await explorer.collapseAll();
  });

  commands.register("explorer.revealActiveFile", async () => {
    const { activeId } = workspace.getState();
    if (!activeId) {
      return;
    }
    const path = documents.snapshot(activeId).path;
    if (path) {
      await explorer.revealPath(path);
    }
  });
}

