import type { CommandRegistry } from "./commandRegistry";
import type { DocumentService } from "./documentService";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { ExtensionFormatterRegistry } from "./extensionFormatters";
import { ExtensionIconThemeService, type IconThemeServiceDeps } from "./extensionIconThemeService";
import { ExtensionTaskService } from "./extensionTasks";
import { ExtensionTerminalService } from "./extensionTerminals";
import { containerKey } from "./extensionViewsService";
import type { wireExtensions } from "./extensionsWiring";
import type { FsChangeBatch, IpcClient } from "./ipc";
import type { LayoutService } from "./layoutService";
import { type OutputService, stamped } from "./outputService";
import type { PanelService } from "./panelService";
import type { TerminalService } from "./terminalService";
import type { WorkspaceService } from "./workspaceService";

export interface ExtensionApiWiringDeps {
  extensions: ReturnType<typeof wireExtensions>;
  ipc: IpcClient;
  events: EventBus<AppEvents>;
  commands: CommandRegistry;
  terminal: TerminalService;
  panel: PanelService;
  workspace: WorkspaceService;
  documents: DocumentService;
  layout: LayoutService;
  output: OutputService;
  formatters: ExtensionFormatterRegistry;
  /** `workbench.iconTheme` and friends (the icon theme follows the setting). */
  settings: IconThemeServiceDeps["settings"];
  /** The language of a file name, for icon themes that pick icons by language. */
  languageOf: (name: string) => string | null;
}

/** A file watcher batch as the host's `createFileSystemWatcher` wants it. */
export function filesChanged(batch: FsChangeBatch): {
  created: string[];
  changed: string[];
  deleted: string[];
} {
  const created: string[] = [];
  const changed: string[] = [];
  const deleted: string[] = [];
  for (const change of batch.changes) {
    if (change.kind === "created") created.push(change.path);
    else if (change.kind === "modified") changed.push(change.path);
    else if (change.kind === "removed") deleted.push(change.path);
    else {
      if (change.from !== null) deleted.push(change.from);
      created.push(change.path);
    }
  }
  return { created, changed, deleted };
}

/**
 * The Extension API v2 parts (Milestone 18) connected to the app: terminals and tasks of extensions, documents they
 * show or save, custom-scheme documents, formatters, webview view reveal, and file watcher events. Everything an
 * extension would run is confirmed by the user first (see `ExtensionTerminalService`, `ExtensionTaskService`).
 */
export function wireExtensionApis(deps: ExtensionApiWiringDeps) {
  const { extensions, ipc, events, terminal, panel, workspace, documents } = deps;
  const { host, bridge, prompts, registry, webviews } = extensions;
  const log = (line: string) => {
    deps.output.append("Extensions", stamped(line));
  };
  const notice = (message: string) => {
    events.emit("appNotice", { message });
  };
  const notifyHost = (method: string, params: unknown) => {
    if (host.isRunning()) void ipc.extHostNotify(method, params).catch(() => undefined);
  };
  const confirm = prompts.confirm.bind(prompts);

  const terminals = new ExtensionTerminalService({
    terminals: terminal,
    showPanel: () => panel.show("terminal"),
    confirm,
    notifyHost,
    notice,
    log,
  });
  const tasks = new ExtensionTaskService({
    host: {
      activateFor: (trigger, report) => host.activateFor(trigger, report),
      request: (method, params) => host.request(method, params),
      needsHost: () => host.needsHost(),
    },
    terminals: terminal,
    quickPick: (request) => prompts.quickPick(request),
    confirm,
    notifyHost,
    notice,
    log,
  });

  bridge.connect({
    terminals,
    tasks,
    showTextDocument: async (path) => {
      await workspace.openPath(path);
    },
    showVirtualDocument: async (request) => {
      await Promise.resolve();
      workspace.openVirtualDocument({
        uri: request.uri,
        text: request.text,
        language: request.languageId,
        extension: request.extension,
        readonly: request.readonly,
      });
    },
    updateVirtualDocument: request => {
      workspace.updateVirtualDocument({ uri: request.uri, text: request.text, language: request.languageId, extension: request.extension, readonly: true });
    },
    saveDocument: async (path) => {
      const id = documents.idForPath(path);
      if (id === null) return false;
      await workspace.save(id);
      return true;
    },
    saveAll: async () => {
      await workspace.saveAll();
      return true;
    },
    registerFormatter: (registration, invoke) => deps.formatters.register(registration, invoke),
  });

  // The last virtual preview tab closed: release the host mirror and pending content reads.
  workspace.filePreviews.onRelease(document => {
    if (document.model?.type === "virtualText") notifyHost("host/documentClosed", { path: document.path });
  });

  // `WebviewView.show()`: the side bar shows the view's container.
  webviews.onRevealView((view) => {
    const entry = extensions.views
      .containers()
      .find((candidate) => candidate.container.views.some((v) => v.id === view));
    if (entry) void deps.layout.showView(containerKey(entry.extensionId, entry.container.id));
  });

  // A disabled or uninstalled extension's terminals close with it; formatters go with the host.
  registry.subscribe(() => {
    if (registry.getState().snapshot === null) return;
    const enabled = new Set(
      registry
        .all()
        .filter((e) => e.enabled)
        .map((e) => e.id),
    );
    void terminals.keepOnly(enabled);
  });

  // Terminal > Run Task... lists these tasks next to the folder's own (`taskWiring.ts`).

  // The app's own file watcher feeds `createFileSystemWatcher` (nothing new watches the disk).
  void ipc
    .onFsChanged((batch) => {
      if (!batch.overflow) notifyHost("host/filesChanged", filesChanged(batch));
    })
    .catch(() => undefined);

  // An enabled extension's file icon theme, chosen with `workbench.iconTheme` (the built-in icons otherwise).
  new ExtensionIconThemeService({
    settings: deps.settings,
    registry: {
      all: () => registry.all(),
      subscribe: (listener) => registry.subscribe(listener),
      loaded: () => registry.getState().snapshot !== null,
    },
    readFile: (id, path) => ipc.extReadFile(id, path),
    readIcon: (id, path) => ipc.extReadIcon(id, path),
    languageOf: deps.languageOf,
    notice,
  }).start();

  return { terminals, tasks };
}
