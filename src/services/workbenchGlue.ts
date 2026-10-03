import type { CommandRegistry } from "./commandRegistry";
import type { DocumentService } from "./documentService";
import type { EditorService } from "./editorService";
import type { EditorWindowService } from "./editorWindowService";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { ExplorerService } from "./explorerService";
import type { FileSyncService } from "./fileSyncService";
import { hasActiveTab } from "./fileCommands";
import type { IpcClient } from "./ipc";
import type { MarkerService } from "./markerService";
import type { SecondarySideBarService } from "./secondarySideBarService";
import type { WelcomeService } from "./welcomeService";
import type { WorkspaceService } from "./workspaceService";

export interface WorkbenchGlueDeps {
  ipc: IpcClient;
  events: EventBus<AppEvents>;
  workspace: WorkspaceService;
  documents: DocumentService;
  explorer: ExplorerService;
  fileSync: FileSyncService;
  editor: EditorService;
  markers: MarkerService;
  /** The app's own Output channel ("OpenMind Studio"). */
  appLog: (line: string) => void;
}

/**
 * The connections between the workbench's core services that belong to none of them: Problems name their documents,
 * search results reveal in the editor, the app's own log, and the Explorer following the open folder and telling the
 * open tabs about its own operations.
 */
export function connectWorkbench(deps: WorkbenchGlueDeps): void {
  const { events, workspace, documents, explorer, appLog } = deps;
  // What the Explorer's own operations mean for the rest of the app, applied as soon as the backend answers.
  explorer.setHost({
    openFile: (path) => workspace.openPath(path),
    pathMoved: (from, to) => {
      documents.retargetPath(from, to);
      void deps.ipc.recentFilesRename(from, to).catch(() => undefined);
    },
    pathDeleted: (path) => deps.fileSync.deletedByUser(path),
  });
  // Problems are labelled with the document each marker belongs to; search results reveal in the editor.
  deps.markers.setResourceResolver((uri) => {
    const id = documents.idForModelUri(uri);
    if (id === undefined) return null;
    const snapshot = documents.snapshot(id);
    return { title: snapshot.title, path: snapshot.path };
  });
  workspace.setRevealer((uri, target) => {
    deps.editor.reveal({ uri, ...target });
  });

  // The app's own log: caught errors and workspace changes.
  appLog("OpenMind Studio started.");
  events.on("appError", ({ message }) => {
    appLog(`Error: ${message}`);
  });
  events.on("workspaceFolderChanged", ({ workspace: opened }) => {
    appLog(opened ? `Opened folder ${opened.path}` : "Closed the folder.");
  });

  // Keep the explorer tree in sync with whichever folder is currently open.
  workspace.subscribeWorkspace(() => {
    const info = workspace.getActiveWorkspace();
    if (info) {
      void explorer.setRoot(info.path, info.name);
    } else {
      explorer.clear();
    }
  });
}

export interface WindowCommandDeps {
  commands: CommandRegistry;
  ipc: IpcClient;
  workspace: WorkspaceService;
  welcome: WelcomeService;
  editorWindows: EditorWindowService;
  secondarySideBar: SecondarySideBarService;
}

/** Help > Welcome, File > New Window, moving a tab to a new window and the secondary side bar toggle. */
export function registerWindowCommands(deps: WindowCommandDeps): void {
  const { commands, workspace, secondarySideBar } = deps;
  commands.register("help.welcome", () => {
    deps.welcome.open();
  });
  commands.register("workbench.newWindow", async () => {
    await deps.ipc.windowNew();
  });
  commands.register(
    "workbench.moveEditorToNewWindow",
    async () => {
      await deps.editorWindows.moveActiveToNewWindow();
    },
    { enabled: () => hasActiveTab(workspace) },
  );
  commands.register("view.toggleSecondarySidebar", () => secondarySideBar.toggle(), {
    checked: () => secondarySideBar.getState().visible,
  });
}
