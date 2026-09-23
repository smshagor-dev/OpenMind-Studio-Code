import { BufferManager } from "./bufferManager";
import { CommandRegistry } from "./commandRegistry";
import { DocumentService } from "./documentService";
import { EditorService } from "./editorService";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import { ExplorerService } from "./explorerService";
import { FileSystemService } from "./fileSystemService";
import { tauriIpcClient } from "./ipc";
import { KeybindingService } from "./keybindings";
import { LayoutService } from "./layoutService";
import { MarkerService } from "./markerService";
import { ThemeService } from "./themeService";
import { tauriWindowApi, WindowService } from "./windowService";
import { registerWorkbenchCommands } from "./workbenchCommands";
import { WorkspaceService } from "./workspaceService";

const events = new EventBus<AppEvents>();
const buffers = new BufferManager();
const documents = new DocumentService(tauriIpcClient, buffers, events);
const workspace = new WorkspaceService(documents, tauriIpcClient, events);
const fileSystem = new FileSystemService(tauriIpcClient);
const explorer = new ExplorerService(fileSystem, tauriIpcClient, events);
const theme = new ThemeService(tauriIpcClient, events);
const commands = new CommandRegistry();
const editor = new EditorService(tauriIpcClient);
const layout = new LayoutService(tauriIpcClient);
const windowService = new WindowService(tauriWindowApi, tauriIpcClient);
const keybindings = new KeybindingService(commands);
const markers = new MarkerService();

// Keep the explorer tree in sync with whichever folder is currently open.
workspace.subscribeWorkspace(() => {
  const info = workspace.getActiveWorkspace();
  if (info) {
    void explorer.setRoot(info.path, info.name);
  } else {
    explorer.clear();
  }
});

const hasActiveTab = () => workspace.getState().activeId !== null;

commands.register("file.new", () => {
  workspace.createUntitled();
});

commands.register("file.open", async () => {
  const path = await tauriIpcClient.openDocumentDialog();
  if (path) {
    await workspace.openPath(path);
  }
});

commands.register("file.openFolder", async () => {
  const path = await tauriIpcClient.openFolderDialog();
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
  { enabled: hasActiveTab },
);

commands.register(
  "file.saveAs",
  async () => {
    const { activeId } = workspace.getState();
    if (activeId) {
      await workspace.saveAs(activeId);
    }
  },
  { enabled: hasActiveTab },
);

commands.register(
  "file.closeActiveTab",
  async () => {
    const { activeId } = workspace.getState();
    if (activeId) {
      await workspace.close(activeId);
    }
  },
  { enabled: hasActiveTab },
);

commands.register("view.toggleTheme", async () => {
  const next = theme.getTheme() === "dark" ? "light" : "dark";
  await theme.setTheme(next);
});

commands.register("explorer.newFile", async () => {
  const root = explorer.getSnapshot().rootPath;
  if (root) {
    await explorer.createFile(root);
  }
});

commands.register("explorer.newFolder", async () => {
  const root = explorer.getSnapshot().rootPath;
  if (root) {
    await explorer.createFolder(root);
  }
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

registerWorkbenchCommands({
  commands,
  events,
  ipc: tauriIpcClient,
  documents,
  workspace,
  editor,
  layout,
  window: windowService,
  theme,
});

/**
 * Fire-and-forget command execution for UI event handlers: a failing command
 * surfaces as an `appError` toast instead of an unhandled rejection.
 */
function run(id: string, ...args: unknown[]): void {
  commands.execute(id, ...args).catch((error: unknown) => {
    events.emit("appError", { message: `Command "${id}" failed: ${String(error)}` });
  });
}

/** The app's single composition root: one instance of each service, wired together. */
export const container = {
  events,
  buffers,
  documents,
  workspace,
  fileSystem,
  explorer,
  theme,
  commands,
  keybindings,
  run,
  markers,
  editor,
  layout,
  window: windowService,
  ipc: tauriIpcClient,
};
