import { BufferManager } from "./bufferManager";
import { CommandRegistry } from "./commandRegistry";
import { DocumentService } from "./documentService";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import { ExplorerService } from "./explorerService";
import { FileSystemService } from "./fileSystemService";
import { tauriIpcClient } from "./ipc";
import { ThemeService } from "./themeService";
import { WorkspaceService } from "./workspaceService";

const events = new EventBus<AppEvents>();
const buffers = new BufferManager();
const documents = new DocumentService(tauriIpcClient, buffers, events);
const workspace = new WorkspaceService(documents, tauriIpcClient, events);
const fileSystem = new FileSystemService(tauriIpcClient);
const explorer = new ExplorerService(fileSystem, tauriIpcClient, events);
const theme = new ThemeService(tauriIpcClient, events);
const commands = new CommandRegistry();

// Keep the explorer tree in sync with whichever folder is currently open.
workspace.subscribeWorkspace(() => {
  const info = workspace.getActiveWorkspace();
  if (info) {
    void explorer.setRoot(info.path, info.name);
  } else {
    explorer.clear();
  }
});

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

commands.register("file.closeFolder", async () => {
  await workspace.closeFolder();
});

commands.register("file.save", async () => {
  const { activeId } = workspace.getState();
  if (activeId) {
    await workspace.save(activeId);
  }
});

commands.register("file.saveAs", async () => {
  const { activeId } = workspace.getState();
  if (activeId) {
    await workspace.saveAs(activeId);
  }
});

commands.register("file.closeActiveTab", async () => {
  const { activeId } = workspace.getState();
  if (activeId) {
    await workspace.close(activeId);
  }
});

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
  ipc: tauriIpcClient,
};
