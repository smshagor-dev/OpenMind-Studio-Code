import { expect, it, vi } from "vitest";
import { ExtensionTaskService, RUN_TASK, type ExtensionTask, type ExtensionTaskDeps } from "./extensionTasks";
it("publishes custom task output through configured matchers and rejects stale reports across runs/reset", async () => {
  const reports: { output: string; current: () => boolean }[] = [];
  const reportProblems = vi.fn((_task: ExtensionTask, output: string, current: () => boolean) => { reports.push({ output, current }); return Promise.resolve(); });
  const service = new ExtensionTaskService({
    terminals: { subscribe: () => () => {}, getState: () => ({ sessions: [] }) } as unknown as ExtensionTaskDeps["terminals"],
    host: { needsHost: () => true, activateFor: () => Promise.resolve([]), request: () => Promise.resolve({ started: true }) },
    quickPick: () => Promise.resolve(null), confirm: () => Promise.resolve(RUN_TASK), notifyHost: () => {}, notice: () => {}, reportProblems,
  });
  const task: ExtensionTask = { handle: "test.task#task-1", extension: "test.task", name: "Build", source: "test", type: "custom", detail: null, group: null, commandLine: "Extension pseudoterminal", kind: "custom", cwd: null, cwdInsideFolder: false, env: {}, problemMatchers: ["$tsc"], isBackground: false };
  expect(await service.confirmAndRun(task)).toEqual({ started: true });
  service.customOutput({ handle: task.handle, data: "src/app.ts(1,2): error TS123: bad" }); service.customFinished({ handle: task.handle });
  expect(reports.at(-1)?.output).toContain("TS123"); expect(reports.at(-1)?.current()).toBe(true);
  const previous = reports.at(-1); await service.confirmAndRun({ ...task, handle: "test.task#task-2" }); expect(previous?.current()).toBe(false);
  const latest = reports.at(-1); service.reset(); expect(latest?.current()).toBe(false);
});

it("reports process start and end in order when the native task exits before start returns", async () => {
  const notifyHost = vi.fn(), disposeOutput = vi.fn();
  const service = new ExtensionTaskService({
    terminals: { subscribe: () => () => {}, getState: () => ({ sessions: [{ id: "fast", exited: true, exitCode: 9 }] }) } as unknown as ExtensionTaskDeps["terminals"],
    host: { needsHost: () => true, activateFor: () => Promise.resolve([]), request: () => Promise.resolve(null) },
    startTask: () => Promise.resolve({ sessionId: "fast", pid: 123, disposeOutput }),
    matcherNotes: () => Promise.resolve(["$unknown: Unsupported matcher"]),
    quickPick: () => Promise.resolve(null), confirm: request => { expect(request.notes).toContain("$unknown: Unsupported matcher"); return Promise.resolve(RUN_TASK); },
    notifyHost, notice: () => {},
  });
  const task: ExtensionTask = { handle: "test.task#task-3", extension: "test.task", name: "Build", source: "test", type: "process", detail: null, group: null, commandLine: "tool arg", program: "tool", args: ["arg"], kind: "process", cwd: "C:/work", cwdInsideFolder: true, env: {}, problemMatchers: [], isBackground: false };
  expect(await service.confirmAndRun(task)).toEqual({ started: true });
  expect(notifyHost.mock.calls).toEqual([["host/taskStarted", { handle: task.handle, pid: 123 }], ["host/taskEnded", { handle: task.handle, exitCode: 9 }]]);
  expect(disposeOutput).toHaveBeenCalledOnce();
});
