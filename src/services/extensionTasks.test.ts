import { describe, expect, it, vi } from "vitest";

import { ExtensionTaskService, RUN_TASK, RUN_TASK_COMMAND, taskDetails, taskLine, type ExtensionTask } from "./extensionTasks";

function task(overrides: Partial<ExtensionTask> = {}): ExtensionTask {
  return {
    handle: "pub.ext#task-1",
    extension: "pub.ext",
    name: "build",
    source: "samplev2",
    type: "samplev2",
    detail: null,
    group: "build",
    commandLine: "npm run build",
    kind: "shell",
    cwd: "C:/work/My Project",
    cwdInsideFolder: true,
    env: {},
    problemMatchers: [],
    isBackground: false,
    ...overrides,
  };
}

function rig(options: { answer?: string | null; pick?: number | null; tasks?: ExtensionTask[]; shell?: string } = {}) {
  let sessions: { id: string; shell: string; exited: boolean; exitCode: number | null }[] = [];
  const listeners = new Set<() => void>();
  const terminals = {
    createTerminal: vi.fn(() => {
      sessions = [...sessions, { id: "s1", shell: options.shell ?? "powerShell", exited: false, exitCode: null }];
      return Promise.resolve("s1");
    }),
    write: vi.fn(),
    getState: () => ({ sessions }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    closeTerminal: vi.fn(() => {
      sessions = [];
      for (const l of listeners) l();
      return Promise.resolve();
    }),
  };
  const host = {
    activateFor: vi.fn(() => Promise.resolve([])),
    request: vi.fn(() => Promise.resolve({ tasks: options.tasks ?? [task()] })),
    needsHost: () => true,
  };
  const confirm = vi.fn(() => Promise.resolve(options.answer === undefined ? RUN_TASK : options.answer));
  const quickPick = vi.fn(() => Promise.resolve(options.pick === undefined ? 0 : options.pick));
  const notifyHost = vi.fn();
  const notice = vi.fn();
  const service = new ExtensionTaskService({
    host,
    terminals: terminals as never,
    quickPick,
    confirm,
    notifyHost,
    notice,
  });
  return { service, terminals, host, confirm, quickPick, notifyHost, notice };
}

describe("taskLine", () => {
  it("sets the environment in each shell's syntax and refuses what can't be written safely", () => {
    expect(taskLine(task(), "powerShell")).toBe("npm run build");
    const env = task({ env: { MODE: "it's" } });
    expect(taskLine(env, "powerShell")).toBe("$env:MODE='it''s'; npm run build");
    expect(taskLine(env, "gitBash")).toBe(String.raw`MODE='it'\''s' npm run build`);
    expect(taskLine(task({ env: { MODE: "x" } }), "cmd")).toBe('set "MODE=x" && npm run build');
    expect(taskLine(task({ env: { MODE: "a&b" } }), "cmd")).toBeNull();
    expect(taskLine(task({ env: { "BAD-KEY": "x" } }), "powerShell")).toBeNull();
    expect(taskLine(env, "wsl")).toBeNull();
  });

  it("shows label, command, folder and environment", () => {
    const lines = taskDetails(task({ env: { A: "1" } }));
    expect(lines.map((l) => l.label)).toEqual(["Task", "Command", "Folder", "Environment"]);
    expect(lines[1]?.value).toBe("npm run build");
  });
});

describe("ExtensionTaskService", () => {
  it("wakes task providers, lists, confirms and runs in a new terminal", async () => {
    const r = rig();
    await r.service.pickAndRun();
    expect(r.host.activateFor).toHaveBeenCalledWith({ kind: "command", command: RUN_TASK_COMMAND }, true);
    expect(r.host.request).toHaveBeenCalledWith("host/provideTasks", {});
    expect(r.confirm).toHaveBeenCalledTimes(1);
    expect(r.notifyHost).toHaveBeenCalledWith("host/taskStarted", { handle: "pub.ext#task-1" });
    expect(r.terminals.write).toHaveBeenCalledWith("s1", "npm run build\r");
  });

  it("runs nothing when the user cancels, and nothing when the list is empty", async () => {
    const cancelled = rig({ answer: null });
    await cancelled.service.pickAndRun();
    expect(cancelled.terminals.createTerminal).not.toHaveBeenCalled();
    const empty = rig({ tasks: [] });
    await empty.service.pickAndRun();
    expect(empty.quickPick).not.toHaveBeenCalled();
    expect(empty.notice).toHaveBeenCalledWith(expect.stringContaining("No tasks"));
  });

  it("refuses a folder outside the workspace and another extension's task", async () => {
    const r = rig();
    expect(await r.service.execute({ extension: "pub.ext", task: task({ cwdInsideFolder: false }) })).toMatchObject({
      started: false,
    });
    expect(await r.service.execute({ extension: "other.ext", task: task() })).toEqual({
      started: false,
      reason: "Invalid task.",
    });
    expect(r.confirm).not.toHaveBeenCalled();
  });

  it("says problem matchers aren't supported, and reports the end when the terminal closes", async () => {
    const r = rig();
    expect(await r.service.execute({ extension: "pub.ext", task: task({ problemMatchers: ["$tsc"] }) })).toEqual({
      started: true,
    });
    const request = (r.confirm.mock.calls as unknown[][])[0]?.[0] as { notes: string[] };
    expect(request.notes.join(" ")).toMatch(/Problem matchers \(\$tsc\) are not supported/);
    await r.service.terminate({ handle: "pub.ext#task-1" });
    expect(r.notifyHost).toHaveBeenCalledWith("host/taskEnded", { handle: "pub.ext#task-1", exitCode: null });
  });

  it("doesn't run when the environment can't be set in the shell", async () => {
    const r = rig({ shell: "cmd" });
    const result = await r.service.execute({ extension: "pub.ext", task: task({ env: { A: "x|y" } }) });
    expect(result.started).toBe(false);
    expect(r.terminals.write).not.toHaveBeenCalled();
  });
});
