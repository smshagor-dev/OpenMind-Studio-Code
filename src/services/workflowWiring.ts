import type { DebugConfigurationService } from "./debugConfigurationService";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { ExtensionPromptService } from "./extensionPromptService";
import type { FilePreviewService } from "./filePreviewService";
import type { IpcClient } from "./ipc";
import { NotebookService } from "./notebook/notebookService";
import { LAUNCH_TEMPLATE, openOrCreate } from "./workspaceJsonFiles";

/** launch.json is read again when the folder changes or a launch file is saved (and before every start). */
export function watchLaunchFiles(
  events: EventBus<AppEvents>,
  configs: DebugConfigurationService,
  activePath: () => string | null,
): void {
  events.on("workspaceFolderChanged", () => {
    void configs.refresh(activePath());
  });
  events.on("documentSaved", ({ path }) => {
    if (/[\\/]\.(vscode|openmind)[\\/]launch\.json$/i.test(path))
      void configs.refresh(activePath());
  });
}

/** Run > Open Configurations: opens the folder's launch.json, or creates `.vscode/launch.json` from a template. */
export function launchJsonOpener(deps: {
  ipc: IpcClient;
  folder: () => string | null;
  openPath: (path: string) => Promise<unknown>;
  events: EventBus<AppEvents>;
}): () => Promise<void> {
  return async () => {
    const folder = deps.folder();
    if (!folder) return;
    const notice = (message: string) => {
      deps.events.emit("appNotice", { message });
    };
    await openOrCreate(
      { ipc: deps.ipc, openPath: deps.openPath, notice },
      folder,
      "launch.json",
      LAUNCH_TEMPLATE,
    );
  };
}

/** Jupyter notebooks: opening one runs nothing; cells run only in a trusted notebook on a kernel the user picked. */
export function wireNotebooks(deps: {
  ipc: IpcClient;
  prompts: ExtensionPromptService;
  events: EventBus<AppEvents>;
  settings: {
    string: (id: string, fallback: string) => string;
    number: (id: string, fallback: number) => number;
  };
  filePreviews: FilePreviewService;
  log: (line: string) => void;
}): NotebookService {
  const notebooks = new NotebookService({
    ipc: deps.ipc,
    confirm: (request) => deps.prompts.confirm(request),
    quickPick: (request) => deps.prompts.quickPick(request),
    notice: (message) => {
      deps.events.emit("appNotice", { message });
    },
    log: deps.log,
    autoSave: () => ({
      mode: deps.settings.string("files.autoSave", "off"),
      delay: deps.settings.number("files.autoSaveDelay", 1000),
    }),
  });
  // Closing a notebook's last tab stops its kernel.
  deps.filePreviews.onRelease((doc) => {
    if (doc.model?.type === "notebook") void notebooks.close(doc.path);
  });
  window.addEventListener("blur", () => {
    notebooks.windowBlurred();
  });
  return notebooks;
}
