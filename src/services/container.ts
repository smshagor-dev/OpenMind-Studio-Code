import { BufferManager } from "./bufferManager";
import { CommandRegistry } from "./commandRegistry";
import { DocumentService } from "./documentService";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import { tauriIpcClient } from "./ipc";
import { ThemeService } from "./themeService";
import { WorkspaceService } from "./workspaceService";

const events = new EventBus<AppEvents>();
const buffers = new BufferManager();
const documents = new DocumentService(tauriIpcClient, buffers, events);
const workspace = new WorkspaceService(documents, tauriIpcClient, events);
const theme = new ThemeService(tauriIpcClient, events);
const commands = new CommandRegistry();

commands.register("file.new", () => {
  workspace.createUntitled();
});

commands.register("file.open", async () => {
  const path = await tauriIpcClient.openDocumentDialog();
  if (path) {
    await workspace.openPath(path);
  }
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

/** The app's single composition root: one instance of each service, wired together. */
export const container = {
  events,
  buffers,
  documents,
  workspace,
  theme,
  commands,
};
