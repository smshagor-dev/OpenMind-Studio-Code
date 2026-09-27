import { describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import type { TaskStep, WorkspaceTaskInfo } from "./workflowIpc";
import { confirmationOf, problemFiles, RUN_ALWAYS, RUN_TASK, WorkspaceTaskService } from "./workspaceTasks";

function info(label: string, patch: Partial<WorkspaceTaskInfo> = {}): WorkspaceTaskInfo {
  return {
    id: `C:/w/.vscode/tasks.json::${label}`,
    label,
    source: "C:/w/.vscode/tasks.json",
    typeName: "shell",
    commandLine: `echo ${label}`,
    cwd: "C:/w",
    group: null,
    isDefault: false,
    dependsOn: [],
    isBackground: false,
    matchers: [],
    notes: [],
    problem: null,
    detail: null,
    hide: false,
    ...patch,
  };
}

function step(label: string, patch: Partial<TaskStep> = {}): TaskStep {
  return {
    label,
    source: "C:/w/.vscode/tasks.json",
    kind: "shell",
    commandLine: `echo ${label}`,
    program: "powershell",
    args: [],
    cwd: "C:/w",
    env: {},
    isBackground: false,
    matchers: [],
    problemMatchers: [],
    risks: [],
    notes: [],
    fingerprint: `fp-${label}`,
    ...patch,
  };
}

function rig(options: { tasks?: WorkspaceTaskInfo[]; steps?: TaskStep[]; answer?: string | null; exits?: (number | null)[]; pick?: number | null } = {}) {
  const exits = [...(options.exits ?? [0, 0, 0])];
  const outputs = new Map<string, (data: Uint8Array) => void>();
  let terminals = 0;
  const ipc = createFakeIpc({
    tasksList: vi.fn().mockResolvedValue({ folder: "C:/w", files: [], tasks: options.tasks ?? [info("build")] }),
    tasksPlan: vi.fn().mockResolvedValue({ steps: options.steps ?? [step("build")] }),
    tasksProblems: vi.fn().mockResolvedValue([
      { file: "C:/w/src/a.ts", line: 3, column: 7, severity: "error", message: "bad", code: "TS2322", source: "typescript" },
    ]),
    settingsGet: vi.fn().mockResolvedValue(null),
    settingsSet: vi.fn().mockResolvedValue(undefined),
  });
  const created: { title: string; show: boolean }[] = [];
  const terminal = {
    createTaskTerminal: vi.fn((title: string, start: (c: number, r: number) => Promise<unknown>, show: boolean) => {
      created.push({ title, show });
      void start(80, 24).catch(() => undefined);
      terminals += 1;
      return Promise.resolve(`t${String(terminals)}`);
    }),
    onOutput: vi.fn((id: string, listener: (data: Uint8Array) => void) => {
      outputs.set(id, listener);
      listener(new TextEncoder().encode("src/a.ts(3,7): error TS2322: bad\n"));
      return () => undefined;
    }),
    waitForExit: vi.fn(() => Promise.resolve(exits.shift() ?? 0)),
    closeTerminal: vi.fn(() => Promise.resolve()),
    setActive: vi.fn(),
    lastShell: () => "powerShell" as const,
  };
  const confirm = vi.fn(() => Promise.resolve(options.answer === undefined ? RUN_TASK : options.answer));
  const quickPick = vi.fn(() => Promise.resolve(options.pick === undefined ? 0 : options.pick));
  const setProblems = vi.fn();
  const notice = vi.fn();
  const extensionTasks = { list: vi.fn(() => Promise.resolve([])), confirmAndRun: vi.fn(() => Promise.resolve()) };
  const service = new WorkspaceTaskService({
    ipc,
    terminals: terminal,
    confirm,
    quickPick,
    setProblems,
    activeFile: () => "C:/w/src/a.ts",
    notice,
    log: () => undefined,
    extensionTasks,
  });
  return { service, ipc, terminal, confirm, quickPick, setProblems, notice, created, extensionTasks };
}

describe("WorkspaceTaskService", () => {
  it("nothing runs until the user confirms what the task runs", async () => {
    const r = rig({ answer: null });
    expect(await r.service.run(info("build"))).toBe(false);
    expect(r.confirm).toHaveBeenCalledTimes(1);
    expect(r.terminal.createTaskTerminal).not.toHaveBeenCalled();
  });

  it("runs the steps in order in new terminals (the first one shown) and stops the chain on a failure", async () => {
    const r = rig({ steps: [step("prep"), step("build"), step("pack")], exits: [0, 2, 0] });
    expect(await r.service.run(info("pack"))).toBe(false);
    expect(r.created).toEqual([
      { title: "Task - prep", show: true },
      { title: "Task - build", show: false },
    ]);
    expect(r.ipc.taskRunStep).toHaveBeenCalledWith("C:/w/.vscode/tasks.json::pack", "prep", "C:/w/src/a.ts", "powerShell", 80, 24);
    expect(r.notice).toHaveBeenCalledWith(`Task "build" failed with exit code 2; the 1 task after it didn't run.`);
  });

  it("problem matchers turn the output into Problems; unsupported ones are only named", async () => {
    const r = rig({
      steps: [
        step("build", {
          problemMatchers: ["$tsc", "$tsc-watch"],
          matchers: [
            { name: "$tsc", supported: true, reason: null },
            { name: "$tsc-watch", supported: false, reason: "Problem matcher $tsc-watch is not supported." },
          ],
        }),
      ],
    });
    await r.service.run(info("build"));
    expect(r.ipc.tasksProblems).toHaveBeenCalledWith(["$tsc"], "src/a.ts(3,7): error TS2322: bad\n", "C:/w");
    expect(r.setProblems).toHaveBeenLastCalledWith("task:build", [
      { path: "C:/w/src/a.ts", title: "a.ts", problems: [expect.objectContaining({ line: 3, column: 7, message: "bad (TS2322)", severity: "error" })] },
    ]);
  });

  it("'don't ask again' skips the question next time, unless the task has a risk", async () => {
    const r = rig({ answer: RUN_ALWAYS });
    await r.service.run(info("build"));
    await r.service.run(info("build"));
    expect(r.confirm).toHaveBeenCalledTimes(1);
    const risky = rig({ answer: RUN_ALWAYS, steps: [step("install", { risks: ["It may download from or upload to the network."] })] });
    await risky.service.run(info("install"));
    await risky.service.run(info("install"));
    expect(risky.confirm).toHaveBeenCalledTimes(2);
  });

  it("a task that can't run says why; Run Build Task picks the default build task", async () => {
    const r = rig({ tasks: [info("lint", { group: "build" }), info("build", { group: "build", isDefault: true })] });
    expect(await r.service.run(info("npm", { problem: "Task type \"npm\" comes from a task provider." }))).toBe(false);
    expect(r.notice).toHaveBeenCalledWith('Task type "npm" comes from a task provider.');
    await r.service.pickAndRun("build");
    expect(r.quickPick).not.toHaveBeenCalled();
    expect(r.ipc.tasksPlan).toHaveBeenCalledWith("C:/w/.vscode/tasks.json::build", "C:/w/src/a.ts", "powerShell");
  });

  it("without tasks it says how to add them, and extension tasks share the picker", async () => {
    const empty = rig({ tasks: [] });
    await empty.service.pickAndRun();
    expect(empty.notice).toHaveBeenCalledWith(expect.stringContaining("No tasks"));
    await empty.service.pickAndRun("test");
    expect(empty.notice).toHaveBeenCalledWith(expect.stringContaining("No test task"));
    const r = rig({ tasks: [info("build")], pick: 1 });
    const provided = { handle: "h", extension: "pub.ext", name: "ext task", source: "samplev2", type: "samplev2", detail: null,
      group: null, commandLine: "npm x", kind: "shell" as const, cwd: null, cwdInsideFolder: true, env: {}, problemMatchers: [], isBackground: false };
    r.extensionTasks.list.mockResolvedValue([provided] as never);
    await r.service.pickAndRun();
    expect(r.extensionTasks.confirmAndRun).toHaveBeenCalledWith(provided);
  });

  it("the confirmation names every step's command, folder, environment, source, risks and unsupported parts", () => {
    const prompt = confirmationOf(info("pack"), [
      step("prep", { env: { MODE: "ci" }, risks: ["It deletes or resets files."] }),
      step("pack", { commandLine: "", program: "", matchers: [{ name: "$x", supported: false, reason: "Problem matcher $x is not supported." }] }),
    ]);
    expect(prompt.title).toBe('Run the task "pack"?');
    expect(prompt.details).toEqual(
      expect.arrayContaining([
        { label: "1. prep: Command", value: "echo prep" },
        { label: "1. prep: Environment", value: "MODE=ci" },
        { label: "2. pack: Command", value: "(runs its dependencies only)" },
        { label: "From", value: ".vscode/tasks.json" },
      ]),
    );
    expect(prompt.notes).toEqual(expect.arrayContaining(["It deletes or resets files.", "Problem matcher $x is not supported."]));
    expect(problemFiles([])).toEqual([]);
  });
});
