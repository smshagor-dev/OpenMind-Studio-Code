import { BufferManager } from "./bufferManager";
import { CommandRegistry } from "./commandRegistry";
import { DocumentService } from "./documentService";
import { EditorAssociationService } from "./editorAssociationService";
import { registerEditorCommands } from "./editorCommands";
import { EditorGroupService } from "./editorGroupService";
import { EditorService } from "./editorService";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import { ExplorerService } from "./explorerService";
import { FileSystemService } from "./fileSystemService";
import { tauriIpcClient } from "./ipc";
import { KeybindingService } from "./keybindings";
import { LayoutService } from "./layoutService";
import { MarkdownPreviewService } from "./markdownPreviewService";
import { MarkerService } from "./markerService";
import { OpenEditorsService } from "./openEditorsService";
import { OutputService, stamped } from "./outputService";
import { PanelService } from "./panelService";
import { PhpServerService } from "./phpServerService";
import { registerPhpCommands } from "./phpCommands";
import { PortsService } from "./portsService";
import { PreviewEditorService } from "./previewEditorService";
import { RunConfigurationService } from "./runConfigurationService";
import { RunCodeService } from "./runCodeService";
import { registerRunCommands } from "./runCommands";
import { RuntimeService } from "./runtimeService";
import { SearchService } from "./searchService";
import { TerminalService } from "./terminalService";
import { ThemeService } from "./themeService";
import { tauriWindowApi, WindowService } from "./windowService";
import { registerRuntimeCommands } from "./runtimeCommands";
import { ComposerService } from "./composerService";
import { MariaDbService } from "./mariaDbService";
import { PhpMyAdminService } from "./phpMyAdminService";
import { PhpRuntimeService } from "./phpRuntimeService";
import { registerTerminalCommands } from "./terminalCommands";
import { registerViewCommands } from "./viewCommands";
import { registerWorkbenchCommands } from "./workbenchCommands";
import { WorkspaceService } from "./workspaceService";

const events = new EventBus<AppEvents>();
const buffers = new BufferManager();
const documents = new DocumentService(tauriIpcClient, buffers, events);
const output = new OutputService();
const log = (channel: string) => (line: string) => {
  output.append(channel, stamped(line));
};
const panel = new PanelService(tauriIpcClient);
const editorGroups = new EditorGroupService();
const associations = new EditorAssociationService(tauriIpcClient);
const previews = new PreviewEditorService(tauriIpcClient);
const workspace = new WorkspaceService(documents, tauriIpcClient, events, {
  groups: editorGroups,
  associations,
  previews,
});
const openEditors = new OpenEditorsService(workspace);
const markdown = new MarkdownPreviewService(workspace, editorGroups, tauriIpcClient, events);
const ports = new PortsService(tauriIpcClient, events);
const fileSystem = new FileSystemService(tauriIpcClient);
const explorer = new ExplorerService(fileSystem, tauriIpcClient, events);
const theme = new ThemeService(tauriIpcClient, events);
const commands = new CommandRegistry();
const editor = new EditorService(tauriIpcClient);
const layout = new LayoutService(tauriIpcClient);
const windowService = new WindowService(tauriWindowApi, tauriIpcClient);
const keybindings = new KeybindingService(commands);
const markers = new MarkerService();
const runtime = new RuntimeService(tauriIpcClient, events, log("Runtime Manager"));
const terminal = new TerminalService(
  tauriIpcClient,
  events,
  () => workspace.getActiveWorkspace()?.path ?? null,
  panel,
  log("Terminal"),
);
const search = new SearchService(
  tauriIpcClient,
  events,
  output,
  () => workspace.getActiveWorkspace()?.path ?? null,
  workspace,
);

const php = new PhpServerService(tauriIpcClient, events, output, runtime, ports, panel);
const mariaDb = new MariaDbService(tauriIpcClient, events, output, runtime, ports, panel);
const phpMyAdmin = new PhpMyAdminService(
  tauriIpcClient,
  events,
  output,
  runtime,
  ports,
  panel,
  php,
  mariaDb,
);
const composer = new ComposerService(tauriIpcClient, events, output, runtime, panel, php);
const phpRuntime = new PhpRuntimeService(runtime, php, { mariadb: mariaDb, pma: phpMyAdmin });
const runConfigs = new RunConfigurationService(tauriIpcClient);
const runCode = new RunCodeService(
  tauriIpcClient,
  events,
  output,
  workspace,
  runConfigs,
  terminal,
  panel,
);
// An interpreter appearing or going (install / delete / switch) changes what can run.
runtime.subscribe(() => {
  runCode.noteRuntimesChanged(
    runtime
      .getState()
      .runtimes.map(
        (r) =>
          `${r.id}:${r.activeVersion ?? "-"}:${String(r.installed.filter((v) => v.healthy).length)}`,
      )
      .join(","),
  );
});

// Problems are labelled with the document each marker belongs to; search results reveal in the editor.
markers.setResourceResolver((uri) => {
  const id = documents.idForModelUri(uri);
  if (id === undefined) return null;
  const snapshot = documents.snapshot(id);
  return { title: snapshot.title, path: snapshot.path };
});
workspace.setRevealer((uri, target) => {
  editor.reveal({ uri, ...target });
});

// The app's own log: caught errors and workspace changes.
const appLog = log("OpenMind Studio");
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

registerTerminalCommands(commands, terminal);
registerViewCommands({ commands, events, layout, panel, output, search });
registerRunCommands({ commands, events, runCode, configs: runConfigs });
registerEditorCommands({
  commands,
  workspace,
  groups: editorGroups,
  openEditors,
  previews,
  associations,
  markdown,
});
registerRuntimeCommands(commands, events);
registerPhpCommands(commands, php, tauriIpcClient);

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
  terminal,
  runtime,
  panel,
  output,
  runCode,
  runConfigs,
  ports,
  php,
  phpRuntime,
  mariaDb,
  phpMyAdmin,
  composer,
  search,
  editorGroups,
  openEditors,
  previews,
  associations,
  markdown,
  ipc: tauriIpcClient,
};
