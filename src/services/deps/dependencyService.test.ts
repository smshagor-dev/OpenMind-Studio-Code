import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import type { ActionOutcome } from "./dependencyActions";
import { DependencyService, type DependencyHost } from "./dependencyService";
import type { DepsIpc, ProjectInfo } from "./depsIpc";

const INFO: ProjectInfo = {
  pythonProject: "E:\\work\\app",
  requirementsTxt: "E:\\work\\app\\requirements.txt",
  pyprojectToml: null,
  pythonTarget: "openmindPython",
  nodeProject: "E:\\work\\app",
  packageJson: null,
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function rig(host: Partial<DependencyHost> = {}, ipc: Partial<DepsIpc> = {}, outcome: ActionOutcome = { status: "done" }) {
  const events = new EventBus<AppEvents>();
  let clock = 0;
  const perform = vi.fn().mockResolvedValue(outcome);
  const full: DependencyHost = {
    ipc: {
      depsProjectInfo: vi.fn().mockResolvedValue(INFO),
      ...ipc,
    },
    events,
    confirm: vi.fn().mockResolvedValue("Install"),
    actions: { perform },
    openFile: vi.fn(),
    openRuntimeManager: vi.fn(),
    runActiveInTerminal: vi.fn(),
    now: () => clock,
    ...host,
  };
  return {
    service: new DependencyService(full),
    host: full,
    perform,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("DependencyService", () => {
  it("a missing module shows the card and reads what the project has", async () => {
    const r = rig();
    expect(r.service.report("ModuleNotFoundError: No module named 'requests'", "E:\\work\\app\\main.py", "Python", true)).toBe(true);
    await flush();
    const state = r.service.getState();
    expect(state.issue).toMatchObject({ kind: "pythonPackage", package: "requests" });
    expect(state.fromRunCode).toBe(true);
    expect(state.info?.requirementsTxt).toContain("requirements.txt");
    expect(r.host.ipc.depsProjectInfo).toHaveBeenCalledWith("E:\\work\\app\\main.py");
    // Other output doesn't change it; the same issue again is the same card.
    expect(r.service.report("Status: Adult", null, "Terminal")).toBe(false);
    expect(r.service.report("ModuleNotFoundError: No module named 'requests'", null, "Terminal")).toBe(true);
    expect(r.service.getState().source).toBe("Python");
  });

  it("installs through the Dependencies view's runner (plan, confirmation, terminal, real exit code)", async () => {
    const r = rig();
    r.service.report("ModuleNotFoundError: No module named 'requests'", "E:\\work\\app\\main.py", "Python");
    expect(await r.service.install("pip")).toBe(true);
    expect(r.perform).toHaveBeenCalledWith(
      { base: "E:\\work\\app\\main.py", op: { op: "pythonAdd", packages: "requests", offline: false } },
      "Dependency helper",
    );
    expect(r.service.getState()).toMatchObject({ issue: null, notice: "Installed. Run the program again." });
  });

  it("a cancelled, refused or failed install leaves the card with the reason", async () => {
    const cancelled = rig({}, {}, { status: "cancelled" });
    cancelled.service.report("ModuleNotFoundError: No module named 'pandas'", "E:\\work\\main.py", "Terminal");
    expect(await cancelled.service.install("pip")).toBe(false);
    expect(cancelled.service.getState().issue).not.toBeNull();
    const refused = rig({}, {}, { status: "refused", reason: "OpenMind's Python runtime isn't installed. Install Python from the Runtime Manager — packages are never installed into your own Python." });
    refused.service.report("ModuleNotFoundError: No module named 'pandas'", "E:\\work\\main.py", "Terminal");
    expect(await refused.service.install("pip")).toBe(false);
    expect(refused.service.getState().error).toContain("never installed into your own Python");
    const failed = rig({}, {}, { status: "failed", code: 1 });
    failed.service.report("ModuleNotFoundError: No module named 'pandas'", "E:\\work\\main.py", "Terminal");
    expect(await failed.service.install("pip")).toBe(false);
    expect(failed.service.getState().error).toBe("The install failed (exit code 1). The terminal shows why.");
  });

  it("offline wheelhouse, requirements.txt and npm map to their operations", async () => {
    const r = rig();
    r.service.report("ModuleNotFoundError: No module named 'django'", "E:\\work\\app\\main.py", "Terminal");
    await r.service.install("pipOffline");
    expect(r.perform).toHaveBeenLastCalledWith({ base: "E:\\work\\app\\main.py", op: { op: "pythonAdd", packages: "django", offline: true } }, "Dependency helper");
    r.service.report("ModuleNotFoundError: No module named 'flask'", "E:\\work\\app\\main.py", "Terminal");
    await r.service.install("pipRequirements");
    expect(r.perform).toHaveBeenLastCalledWith({ base: "E:\\work\\app\\main.py", op: { op: "pythonInstallRequirements" } }, "Dependency helper");
    r.service.report("Error: Cannot find module 'express'", "E:\\web", "Terminal");
    await r.service.install("npm");
    expect(r.perform).toHaveBeenLastCalledWith({ base: "E:\\web", op: { op: "nodeAdd", package: "express", dev: false } }, "Dependency helper");
    r.service.report("Error: Cannot find module 'left-pad'", "E:\\web", "Terminal");
    await r.service.install("npmProject");
    expect(r.perform).toHaveBeenLastCalledWith({ base: "E:\\web", op: { op: "nodeInstall" } }, "Dependency helper");
  });

  it("a dismissed issue stays quiet for a while; the helpers open files and the Runtime Manager", () => {
    const r = rig();
    r.service.report("javac : The term 'javac' is not recognized", "E:\\java", "Terminal");
    r.service.dismiss();
    expect(r.service.report("javac : The term 'javac' is not recognized", "E:\\java", "Terminal")).toBe(false);
    r.advance(3 * 60 * 1000);
    expect(r.service.report("javac : The term 'javac' is not recognized", "E:\\java", "Terminal")).toBe(true);
    r.service.openRuntimeManager();
    expect(r.host.openRuntimeManager).toHaveBeenCalledOnce();
    r.service.runInTerminal();
    expect(r.host.runActiveInTerminal).toHaveBeenCalledOnce();
  });
});

describe("Tcl/Tk GUI support for the portable Python (Milestone 22.5)", () => {
  const TK = "ModuleNotFoundError: No module named 'tkinter'";
  const gui = (addable: ReturnType<NonNullable<DependencyHost["pythonGui"]>["addable"]>, ok = true) => ({
    addable: vi.fn().mockReturnValue(addable),
    add: vi.fn().mockResolvedValue(ok ? null : "checksum mismatch: expected a, got b."),
    refresh: vi.fn().mockResolvedValue(undefined),
  });
  const ADDABLE = { version: "3.14.7", label: "Tcl/Tk GUI support (tkinter)", downloadBytes: 5_414_912, license: "Tcl/Tk License (BSD-style) and PSF License" };

  it("offers the add-on for tkinter only, and adds it only after a confirmation that says what and where", async () => {
    const pythonGui = gui(ADDABLE);
    const r = rig({ pythonGui });
    r.service.report("ModuleNotFoundError: No module named 'requests'", "E:\\work\\app", "Python");
    expect(r.service.pythonGui()).toBeNull();
    r.service.report(TK, "E:\\work\\app", "Python");
    // The card appearing reloads the runtime list, so the offer is current.
    expect(pythonGui.refresh).toHaveBeenCalledOnce();
    expect(r.service.pythonGui()).toEqual(ADDABLE);

    expect(await r.service.addPythonGui()).toBe(true);

    const request = (r.host.confirm as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { title: string; details: { label: string; value: string }[] };
    expect(request.title).toBe("Add Tcl/Tk GUI support to Python 3.14.7?");
    expect(request.details.map((d) => d.value)).toEqual([
      "Tcl/Tk GUI support (tkinter)",
      "OpenMind's portable Python 3.14.7 only",
      "python.org tcltk.msi (5.2 MB)",
      "Tcl/Tk License (BSD-style) and PSF License",
    ]);
    expect(pythonGui.add).toHaveBeenCalledWith("3.14.7");
    expect(r.service.getState()).toMatchObject({ issue: null, notice: "Tcl/Tk GUI support was added. Run the program again." });
    // Never pip, never a terminal.
    expect(r.perform).not.toHaveBeenCalled();
  });

  it("cancelling adds nothing; a failure is shown; without an addable add-on only the explanation remains", async () => {
    const cancelled = rig({ pythonGui: gui(ADDABLE), confirm: vi.fn().mockResolvedValue(null) });
    cancelled.service.report(TK, null, "Terminal");
    expect(await cancelled.service.addPythonGui()).toBe(false);
    expect(cancelled.host.pythonGui?.add).not.toHaveBeenCalled();

    const failing = rig({ pythonGui: gui(ADDABLE, false) });
    failing.service.report(TK, null, "Terminal");
    expect(await failing.service.addPythonGui()).toBe(false);
    expect(failing.service.getState().error).toBe(
      "Tcl/Tk GUI support couldn't be added: checksum mismatch: expected a, got b.",
    );

    const none = rig({ pythonGui: gui(null) });
    none.service.report(TK, null, "Terminal");
    expect(none.service.pythonGui()).toBeNull();
    expect(await none.service.addPythonGui()).toBe(false);
    expect(none.host.confirm).not.toHaveBeenCalled();
  });
});
