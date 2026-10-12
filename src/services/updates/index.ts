// The update service of this window, built from the app's own services (kept out of container.ts, which is at its
// size limit). `startUpdates` runs once the workbench is up: it only listens and registers commands — the backend's
// schedule decides when to check (src-tauri/src/updates/scheduler.rs).
import { container } from "../container";
import { t } from "../../i18n";
import { tauriUpdateIpc, type UpdateIpc } from "./updateIpc";
import { UpdateService, type UpdateHost } from "./updateService";

function unsavedCount(): number {
  const dirty = new Set<string>();
  for (const group of container.workspace.getState().groups) {
    for (const tab of group.tabs) if (tab.dirty) dirty.add(tab.docId);
  }
  return dirty.size;
}

export function updateHost(): UpdateHost {
  return {
    unsavedCount,
    onUnsavedChange: (listener) => container.events.on("documentDirtyChanged", listener),
    saveAll: () => container.workspace.saveAll(),
    confirm: async (message, okLabel) => {
      const answer = await container.extensions.prompts.confirm({
        extension: "OpenMind Studio",
        title: t("update.confirm.title"),
        details: [],
        notes: [message],
        buttons: [okLabel],
      });
      return answer === okLabel;
    },
    notify: (message) => {
      container.events.emit("appNotice", { message });
    },
    text: (key, params) => t(key, params),
    openExternal: (url) => container.ipc.openExternalUrl(url),
  };
}

export function createUpdates(ipc: UpdateIpc = tauriUpdateIpc, host: UpdateHost = updateHost()): UpdateService {
  return new UpdateService(ipc, host);
}

export const updates = createUpdates();

/** Registers the update commands and follows the backend (every editor window). */
export async function startUpdates(service: UpdateService = updates): Promise<void> {
  const { commands } = container;
  // Once per window: a workbench that mounts again (a reload, tests) keeps the registered commands.
  if (!commands.has("help.checkForUpdates")) {
    commands.register("help.checkForUpdates", () => service.checkNow());
    commands.register("update.showDetails", () => {
      service.openDialog();
    });
    commands.register("update.restart", () => service.restartToUpdate(), {
      enabled: () => service.getState().info?.ready === true,
    });
  }
  service.stop();
  await service.start();
}
