import type { RuntimeService } from "../runtimeService";
import { t } from "../../i18n";
import type { PythonGuiHost } from "./dependencyService";

/** Tkinter's missing-module card: the Runtime Manager's Tcl/Tk add-on of the active portable Python. */
export function pythonGuiHost(runtime: RuntimeService): PythonGuiHost {
  return {
    addable: () => {
      const found = runtime.addableAddon("python", "tcltk");
      return found === null
        ? null
        : {
            version: found.version,
            label: found.status.label,
            downloadBytes: found.status.downloadBytes,
            license: found.status.license?.name ?? null,
          };
    },
    add: async (version) =>
      (await runtime.installAddon("python", version, "tcltk"))
        ? null
        : (runtime.getState().errors.python ?? t("runtimes.addon.busy", { name: "Python" })),
    refresh: () => runtime.refresh(),
  };
}
