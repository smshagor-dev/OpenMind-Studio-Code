import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import { commandPreview, DependencyService, type DependencyHost } from "./dependencyService";
import type { DepsIpc, InstallPlan, ProjectInfo } from "./depsIpc";

const PYTHON = "E:\\My Apps\\OpenMind Studio\\runtimes\\python\\versions\\3.14.7\\python.exe";

const INFO: ProjectInfo = {
  pythonProject: "E:\\work\\app",
  requirementsTxt: "E:\\work\\app\\requirements.txt",
  pyprojectToml: null,
  pythonTarget: "openmindPython",
  nodeProject: "E:\\work\\app",
  packageJson: null,
};

function plan(patch: Partial<InstallPlan> = {}): InstallPlan {
  return { argv: [PYTHON, "-m", "pip", "install", "requests"], cwd: "E:\\work\\app", target: "openmindPython", interpreter: PYTHON, ...patch };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function rig(host: Partial<DependencyHost> = {}, ipc: Partial<DepsIpc> = {}) {
  const events = new EventBus<AppEvents>();
  let clock = 0;
  const full: DependencyHost = {
    ipc: {
      depsInstallPlan: vi.fn().mockResolvedValue(plan()),
      depsProjectInfo: vi.fn().mockResolvedValue(INFO),
      ...ipc,
    },
    events,
    confirm: vi.fn().mockResolvedValue("Install"),
    runInTerminal: vi.fn().mockResolvedValue(null),
    openFile: vi.fn(),
    openRuntimeManager: vi.fn(),
    runActiveInTerminal: vi.fn(),
    now: () => clock,
    ...host,
  };
  return {
    service: new DependencyService(full),
    host: full,
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

  it("installs only after the confirmation, which shows the exact command with the interpreter's full path", async () => {
    const r = rig();
    r.service.report("ModuleNotFoundError: No module named 'requests'", "E:\\work\\app\\main.py", "Python");
    expect(await r.service.install("pip")).toBe(true);
    expect(r.host.ipc.depsInstallPlan).toHaveBeenCalledWith("pip", "requests", "E:\\work\\app\\main.py");
    const request = (r.host.confirm as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { details: { label: string; value: string }[] };
    expect(request.details[0]).toEqual({
      label: "Command",
      value: `"${PYTHON}" -m pip install requests`,
    });
    expect(request.details[2]?.value).toContain("OpenMind's portable Python");
    expect(r.host.runInTerminal).toHaveBeenCalledWith(plan().argv, "E:\\work\\app");
    // Never a bare `python` (that could be the user's own Python), never --user.
    const argv = (r.host.runInTerminal as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string[];
    expect(argv[0]).toBe(PYTHON);
    expect(argv).not.toContain("--user");
    expect(r.service.getState().issue).toBeNull();
  });

  it("nothing is installed when the user cancels, and a refused plan is shown without asking", async () => {
    const cancelled = rig({ confirm: vi.fn().mockResolvedValue(null) });
    cancelled.service.report("ModuleNotFoundError: No module named 'pandas'", "E:\\work\\main.py", "Terminal");
    expect(await cancelled.service.install("pip")).toBe(false);
    expect(cancelled.host.runInTerminal).not.toHaveBeenCalled();
    const refused = rig({}, {
      depsInstallPlan: vi.fn().mockRejectedValue("OpenMind's Python runtime isn't installed. Install Python from the Runtime Manager (or create a .venv in the project) — packages are never installed into your own Python."),
    });
    refused.service.report("ModuleNotFoundError: No module named 'pandas'", "E:\\work\\main.py", "Terminal");
    expect(await refused.service.install("pip")).toBe(false);
    expect(refused.host.confirm).not.toHaveBeenCalled();
    expect(refused.host.runInTerminal).not.toHaveBeenCalled();
    expect(refused.service.getState().error).toContain("never installed into your own Python");
  });

  it("offline wheelhouse, requirements.txt and npm use their own plans; the offline note says no network", async () => {
    const r = rig();
    r.service.report("ModuleNotFoundError: No module named 'django'", "E:\\work\\app\\main.py", "Terminal");
    await r.service.install("pipOffline");
    expect(r.host.ipc.depsInstallPlan).toHaveBeenLastCalledWith("pipOffline", "django", "E:\\work\\app\\main.py");
    const offline = (r.host.confirm as ReturnType<typeof vi.fn>).mock.lastCall?.[0] as { notes: string[] };
    expect(offline.notes[0]).toContain("--no-index");
    r.service.report("ModuleNotFoundError: No module named 'flask'", "E:\\work\\app\\main.py", "Terminal");
    await r.service.install("pipRequirements");
    expect(r.host.ipc.depsInstallPlan).toHaveBeenLastCalledWith("pipRequirements", null, "E:\\work\\app\\main.py");
    r.service.report("Error: Cannot find module 'express'", "E:\\web", "Terminal");
    await r.service.install("npm");
    expect(r.host.ipc.depsInstallPlan).toHaveBeenLastCalledWith("npm", "express", "E:\\web");
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
    expect(commandPreview(["npm", "install", "left pad"])).toBe('npm install "left pad"');
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
    expect(r.host.runInTerminal).not.toHaveBeenCalled();
    expect(r.host.ipc.depsInstallPlan).not.toHaveBeenCalled();
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
