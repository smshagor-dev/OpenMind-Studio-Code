import { describe, expect, it, vi } from "vitest";

import { CommandRegistry } from "./commandRegistry";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { PythonBundleStatus } from "./ipc";
import { INSTALL_BUNDLED_PACKAGES, registerPythonPackagesCommands } from "./pythonPackagesCommands";

const PRESENT: PythonBundleStatus = {
  present: true,
  problem: null,
  python: "3.14",
  packages: ["requests", "numpy", "flask"],
  stdlib: ["os", "tkinter"],
};

function rig(status: PythonBundleStatus, install = vi.fn().mockResolvedValue("Python 3.14.7: installed.")) {
  const commands = new CommandRegistry();
  const events = new EventBus<AppEvents>();
  const notices: string[] = [];
  const errors: string[] = [];
  events.on("appNotice", ({ message }) => notices.push(message));
  events.on("appError", ({ message }) => errors.push(message));
  const setAppActions = vi.fn();
  const ipc = { pythonPackagesStatus: vi.fn().mockResolvedValue(status), pythonPackagesInstall: install };
  registerPythonPackagesCommands({ commands, events, ipc, editor: { setAppActions } });
  return { commands, ipc, notices, errors, setAppActions };
}

describe("Python: Install Bundled Packages", () => {
  it("is in the palette under its own owner", () => {
    const r = rig(PRESENT);
    expect(r.setAppActions).toHaveBeenCalledWith(
      [{ command: INSTALL_BUNDLED_PACKAGES, label: "Python: Install Bundled Packages", inContextMenu: false }],
      "python",
    );
  });

  it("installs into the active Python and reports what the backend did", async () => {
    const r = rig(PRESENT);
    await r.commands.execute(INSTALL_BUNDLED_PACKAGES);
    expect(r.ipc.pythonPackagesInstall).toHaveBeenCalledWith(null);
    expect(r.notices[0]).toContain("requests, numpy, flask");
    expect(r.notices[1]).toBe("Python 3.14.7: installed.");
  });

  it("says so when the copy has no bundle, and shows a failure as an error", async () => {
    const none = rig({ ...PRESENT, present: false, packages: [] });
    await none.commands.execute(INSTALL_BUNDLED_PACKAGES);
    expect(none.ipc.pythonPackagesInstall).not.toHaveBeenCalled();
    expect(none.notices).toEqual(["This copy of OpenMind Studio has no bundled Python packages."]);
    const failing = rig(PRESENT, vi.fn().mockRejectedValue("No portable Python is installed."));
    await failing.commands.execute(INSTALL_BUNDLED_PACKAGES);
    expect(failing.errors).toEqual(["No portable Python is installed."]);
  });
});
