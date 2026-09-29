import { describe, expect, it, vi } from "vitest";

import { confirmationDetails, DependencyActions, type DependencyActionsHost } from "./dependencyActions";
import type { DepsPlan, DepsRequest } from "./depsIpc";

const PLAN: DepsPlan = {
  manager: "pip",
  action: "add",
  packages: ["requests"],
  program: "E:\\My Work\\app\\.venv\\Scripts\\python.exe",
  source: "project environment",
  args: ["-m", "pip", "install", "--cache-dir=E:\\OpenMind\\cache\\pip", "requests"],
  command: "\"E:\\My Work\\app\\.venv\\Scripts\\python.exe\" -m pip install --cache-dir=E:\\OpenMind\\cache\\pip requests",
  cwd: "E:\\My Work\\app",
  target: "E:\\My Work\\app\\.venv (project environment)",
  network: "required",
  notes: [],
};

const REQUEST: DepsRequest = { base: "E:\\My Work\\app", op: { op: "pythonAdd", packages: "requests", offline: false } };

function rig(patch: Partial<DependencyActionsHost> = {}, exit: number | null = 0) {
  const host: DependencyActionsHost = {
    ipc: {
      depsPlan: vi.fn().mockResolvedValue(PLAN),
      depsRun: vi.fn().mockResolvedValue({ id: "t1", shell: "powerShell", cwd: PLAN.cwd, pid: 5 }),
    },
    confirm: vi.fn().mockResolvedValue("Install"),
    terminals: {
      createTaskTerminal: vi.fn(async (_title: string, start: (cols: number, rows: number) => Promise<unknown>) => {
        await start(100, 30);
        return "t1";
      }),
      waitForExit: vi.fn().mockResolvedValue(exit),
    },
    notice: vi.fn(),
    error: vi.fn(),
    changed: vi.fn(),
    ...patch,
  };
  return { host, actions: new DependencyActions(host) };
}

describe("DependencyActions", () => {
  it("shows every detail of the command before anything runs", () => {
    const labels = confirmationDetails(PLAN).map((d) => `${d.label}: ${d.value}`);
    expect(labels).toEqual([
      "Package(s): requests",
      "Action: add",
      "Package manager: pip",
      "Executable: E:\\My Work\\app\\.venv\\Scripts\\python.exe (project environment)",
      `Command: ${PLAN.command}`,
      "Working directory: E:\\My Work\\app",
      "Target: E:\\My Work\\app\\.venv (project environment)",
      "Network: Requires network (downloads from the package registry)",
    ]);
  });

  it("runs the confirmed request as a terminal program and reports its real exit code", async () => {
    const r = rig();
    expect(await r.actions.perform(REQUEST, "Dependencies")).toEqual({ status: "done" });
    const prompt = (r.host.confirm as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { buttons: string[]; title: string };
    expect(prompt.buttons).toEqual(["Install"]);
    expect(prompt.title).toBe("pip: add?");
    // The request (not a command) is what the backend runs; it plans it again itself.
    expect(r.host.ipc.depsRun).toHaveBeenCalledWith(REQUEST, 100, 30);
    expect(r.host.notice).toHaveBeenCalledWith("pip add: done.");
    expect(r.host.changed).toHaveBeenCalledOnce();
  });

  it("cancelling runs nothing; a refused plan never asks; a failure keeps its exit code", async () => {
    const cancelled = rig({ confirm: vi.fn().mockResolvedValue(null) });
    expect(await cancelled.actions.perform(REQUEST, "x")).toEqual({ status: "cancelled" });
    expect(cancelled.host.ipc.depsRun).not.toHaveBeenCalled();
    expect(cancelled.host.terminals.createTaskTerminal).not.toHaveBeenCalled();

    const refused = rig({ ipc: { depsPlan: vi.fn().mockRejectedValue("\"-g\" isn't an npm package name."), depsRun: vi.fn() } });
    expect(await refused.actions.perform(REQUEST, "x")).toEqual({ status: "refused", reason: "\"-g\" isn't an npm package name." });
    expect(refused.host.confirm).not.toHaveBeenCalled();

    const failed = rig({}, 1);
    expect(await failed.actions.perform(REQUEST, "x")).toEqual({ status: "failed", code: 1 });
    expect(failed.host.error).toHaveBeenCalledWith("pip add failed with exit code 1. The terminal shows why.");
    expect(failed.host.notice).not.toHaveBeenCalled();

    const stopped = rig({}, null);
    expect(await stopped.actions.perform(REQUEST, "x")).toEqual({ status: "failed", code: null });
  });

  it("buttons say what happens", async () => {
    for (const [action, button] of [
      ["remove", "Remove"],
      ["update", "Update"],
      ["create environment", "Create"],
      ["run script", "Run"],
      ["install", "Install"],
    ] as const) {
      const r = rig({ ipc: { depsPlan: vi.fn().mockResolvedValue({ ...PLAN, action }), depsRun: vi.fn() }, confirm: vi.fn().mockResolvedValue(null) });
      await r.actions.perform(REQUEST, "x");
      const prompt = (r.host.confirm as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { buttons: string[] };
      expect(prompt.buttons, action).toEqual([button]);
    }
  });
});
