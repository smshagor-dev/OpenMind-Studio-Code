import { i18n, t } from "../i18n";
import type { CommandRegistry } from "./commandRegistry";
import type { EditorService } from "./editorService";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { IpcClient } from "./ipc";

export const INSTALL_BUNDLED_PACKAGES = "python.installBundledPackages";

export interface PythonPackagesDeps {
  commands: CommandRegistry;
  events: EventBus<AppEvents>;
  ipc: Pick<IpcClient, "pythonPackagesStatus" | "pythonPackagesInstall">;
  editor: Pick<EditorService, "setAppActions">;
}

/**
 * "Python: Install Bundled Packages": installs OpenMind Studio's offline Python bundle (requests, numpy, pandas, Flask,
 * OpenCV ... and Tcl/Tk for tkinter) into the active portable Python. The Runtime Manager does this by itself right after
 * it installs Python; the command is for an install made before, or after a repair. Nothing is downloaded.
 */
export function registerPythonPackagesCommands(deps: PythonPackagesDeps): void {
  deps.commands.register(INSTALL_BUNDLED_PACKAGES, async () => {
    try {
      const status = await deps.ipc.pythonPackagesStatus();
      if (!status.present) {
        deps.events.emit("appNotice", {
          message: status.problem ?? t("python.bundle.none"),
        });
        return;
      }
      deps.events.emit("appNotice", {
        message: t("python.bundle.installing", { packages: status.packages.join(", ") }),
      });
      const message = await deps.ipc.pythonPackagesInstall(null);
      deps.events.emit("appNotice", { message });
    } catch (error) {
      deps.events.emit("appError", { message: String(error) });
    }
  });
  const actions = () => [
    { command: INSTALL_BUNDLED_PACKAGES, label: t(`command.${INSTALL_BUNDLED_PACKAGES}`), inContextMenu: false },
  ];
  deps.editor.setAppActions(actions(), "python");
  i18n.subscribe(() => {
    deps.editor.setAppActions(actions(), "python");
  });
}
