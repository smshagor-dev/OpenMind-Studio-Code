import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { CommandRegistry } from "./commandRegistry";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { CodeRunEvent, IpcClient, RunAvailability, ShellInfo } from "./ipc";
import { KeybindingService } from "./keybindings";
import { buildMenuBar, collectCommandIds } from "./menus";
import { OutputService } from "./outputService";
import { PanelService } from "./panelService";
import { RunConfigurationService, validateCommand } from "./runConfigurationService";
import {
  channelFor,
  describeRunButton,
  parseBuildProblem,
  RunCodeService,
  shellStyleFor,
} from "./runCodeService";
import { registerRunCommands } from "./runCommands";
import { buildRunMenu } from "./runMenu";
import { TerminalService } from "./terminalService";
import type { EditorTabView, WorkspaceService } from "./workspaceService";

const RUNNABLE: RunAvailability = {
  runnable: true,
  kind: "python",
  language: "Python",
  reason: null,
  previewable: false,
  runtimeMissing: false,
  runtime: "OpenMind portable Python 3.14.7",
  command: "python hello.py",
  resolved: "C:/app/runtimes/python/versions/3.14.7/python.exe",
};

function refused(reason: string, extra: Partial<RunAvailability> = {}): RunAvailability {
  return {
    ...RUNNABLE,
    runnable: false,
    kind: null,
    language: null,
    reason,
    runtime: null,
    command: null,
    resolved: null,
    ...extra,
  };
}

function tab(path: string | null, dirty = false, id = "doc-1"): EditorTabView {
  return {
    id,
    docId: id,
    kind: "text",
    preview: false,
    groupId: "group-1",
    path,
    title: path?.split("/").pop() ?? "Untitled",
    dirty,
    encoding: "utf8",
    lineEnding: "lf",
    external: "none",
  };
}

interface Rig {
  ipc: IpcClient;
  events: EventBus<AppEvents>;
  output: OutputService;
  panel: PanelService;
  terminal: TerminalService;
  configs: RunConfigurationService;
  service: RunCodeService;
  /** What Run Code opened beside the editor (the secondary side bar). */
  showBeside: ReturnType<typeof vi.fn>;
  workspace: { tabs: EditorTabView[]; save: ReturnType<typeof vi.fn> };
  emit: (event: CodeRunEvent) => void;
  errors: string[];
  open: (t: EditorTabView | null) => void;
}

const POWERSHELL: ShellInfo = { kind: "powerShell", label: "PowerShell", available: true };

async function rig(
  overrides: Partial<IpcClient> = {},
  prefs?: { saveBeforeRun: () => boolean; clearOutputBeforeRun: () => boolean },
): Promise<Rig> {
  let handler: (event: CodeRunEvent) => void = () => undefined;
  const ipc = createFakeIpc({
    runResolve: vi.fn().mockResolvedValue(RUNNABLE),
    runStart: vi.fn().mockResolvedValue({ runId: "run-1", file: "C:/p/hello.py", pid: 7 }),
    onRunEvent: vi.fn((h: typeof handler) => {
      handler = h;
      return Promise.resolve(() => undefined);
    }),
    terminalListShells: vi.fn().mockResolvedValue([POWERSHELL]),
    terminalCreate: vi
      .fn()
      .mockResolvedValue({ id: "t1", shell: "powerShell", cwd: "C:/p", pid: 1 }),
    runTerminalCommand: vi.fn().mockResolvedValue({
      line: "& 'C:/py/python.exe' 'C:/p/hello.py'",
      display: "python hello.py",
      runtime: "OpenMind portable Python 3.14.7",
      resolved: "C:/py/python.exe",
      language: "Python",
    }),
    ...overrides,
  });
  const events = new EventBus<AppEvents>();
  const errors: string[] = [];
  events.on("appError", ({ message }) => errors.push(message));
  const output = new OutputService();
  const panel = new PanelService(ipc);
  const terminal = new TerminalService(ipc, events, () => "C:/p", panel);
  await terminal.initialize();
  const configs = new RunConfigurationService(ipc);
  const workspace = {
    tabs: [tab("C:/p/hello.py")],
    save: vi.fn(),
  };
  const tabsView = () => ({
    tabs: workspace.tabs,
    activeId: workspace.tabs[0]?.id ?? null,
    groups: [],
    activeGroupId: "group-1",
    weights: [1],
  });
  const stub = {
    getState: tabsView,
    getActiveWorkspace: () => ({ id: 1, name: "p", path: "C:/p" }),
    save: (id: string) => {
      workspace.save(id);
      workspace.tabs = workspace.tabs.map((t) => ({ ...t, dirty: false }));
      return Promise.resolve();
    },
  } as unknown as WorkspaceService;
  const showBeside = vi.fn();
  const service = new RunCodeService(
    ipc,
    events,
    output,
    stub,
    configs,
    terminal,
    panel,
    showBeside,
    prefs,
  );
  await service.initialize();
  return {
    ipc,
    events,
    output,
    panel,
    terminal,
    configs,
    service,
    showBeside,
    workspace,
    emit: (event) => {
      handler(event);
    },
    errors,
    open: (t) => {
      workspace.tabs = t ? [t] : [];
    },
  };
}

describe("describeRunButton", () => {
  const editor = { tabId: "d", docId: "d", path: "C:/p/a.py", dirty: false };
  const base = {
    editor,
    availability: RUNNABLE,
    availabilityCurrent: true,
    checking: false,
    running: false,
    error: null,
  };

  it("is ready and shows the command when the file can run", () => {
    const view = describeRunButton(base);

    expect(view).toMatchObject({ state: "ready", enabled: true, canStop: false });
    expect(view.tooltip).toContain("Ctrl+F5");
    expect(view.tooltip).toContain("python hello.py");
  });

  it("with no editor or an unsaved file it is disabled with the reason", () => {
    expect(describeRunButton({ ...base, editor: null })).toMatchObject({
      enabled: false,
      tooltip: "Open a file to run it.",
    });
    expect(describeRunButton({ ...base, editor: { ...editor, path: null } })).toMatchObject({
      enabled: false,
      tooltip: "Save the file before running.",
    });
  });

  it("an unsupported file is disabled with Rust's reason; a missing runtime is flagged as such", () => {
    expect(
      describeRunButton({ ...base, availability: refused("JSON files can't be run.") }),
    ).toMatchObject({ state: "disabled", enabled: false, tooltip: "JSON files can't be run." });
    expect(
      describeRunButton({
        ...base,
        availability: refused("Python runtime is not installed.", { runtimeMissing: true }),
      }),
    ).toMatchObject({ state: "runtimeMissing", tooltip: "Python runtime is not installed." });
  });

  it("while running it becomes a stop button; while checking it is disabled", () => {
    expect(describeRunButton({ ...base, running: true })).toMatchObject({
      state: "running",
      enabled: true,
      canStop: true,
    });
    expect(
      describeRunButton({ ...base, availabilityCurrent: false, checking: true }),
    ).toMatchObject({
      state: "checking",
      enabled: false,
    });
  });

  it("a failed start shows as an error but can be retried", () => {
    expect(describeRunButton({ ...base, error: "Couldn't start it" })).toMatchObject({
      state: "error",
      enabled: true,
      tooltip: "Couldn't start it — click to try again",
    });
  });
});

describe("RunConfigurationService", () => {
  let ipc: IpcClient;
  let configs: RunConfigurationService;
  const settings = new Map<string, string>();

  beforeEach(() => {
    settings.clear();
    ipc = createFakeIpc({
      settingsGet: vi.fn((key: string) => Promise.resolve(settings.get(key) ?? null)),
      settingsSet: vi.fn((key: string, value: string) => {
        settings.set(key, value);
        return Promise.resolve();
      }),
    });
    configs = new RunConfigurationService(ipc);
  });

  it("has the built-in defaults for each supported type, sending output to the panel", () => {
    expect(configs.get(".py")).toEqual({
      command: 'python "${file}"',
      target: "output",
      custom: false,
    });
    expect(configs.get(".mjs")?.command).toBe('node "${file}"');
    expect(configs.get(".php")?.command).toBe('php "${file}"');
    expect(configs.get(".md")).toBeNull();
    expect(configs.supports(".PY")).toBe(true);
    expect(configs.templateFor(".py")).toBeNull();
  });

  it("saves a custom command and target, persists them and restores them", async () => {
    const problem = await configs.set(".py", 'python -u "${file}"', "terminal");

    expect(problem).toBeNull();
    expect(configs.templateFor(".py")).toBe('python -u "${file}"');
    expect(configs.targetFor(".py")).toBe("terminal");
    const restored = new RunConfigurationService(ipc);
    await restored.initialize();
    expect(restored.get(".py")).toEqual({
      command: 'python -u "${file}"',
      target: "terminal",
      custom: true,
    });
  });

  it("saving the defaults stores nothing, and reset returns to them", async () => {
    await configs.set(".py", 'python -u "${file}"', "output");
    await configs.set(".py", 'python "${file}"', "output");
    expect(settings.get("run.configurations")).toBe("{}");

    await configs.set(".js", 'node --inspect "${file}"', "output");
    await configs.reset(".js");
    expect(configs.get(".js")?.custom).toBe(false);
  });

  it("refuses commands that are empty, multi-line, unbalanced, paths, or that never run the file", async () => {
    for (const bad of [
      "",
      "   ",
      'python "${file}"\ncalc',
      'python "${file',
      'C:\\Python\\python.exe "${file}"',
      "./python ${file}",
      "python a.py",
    ]) {
      expect(validateCommand(bad), JSON.stringify(bad)).not.toBeNull();
      expect(await configs.set(".py", bad, "output")).not.toBeNull();
    }
    expect(configs.get(".py")?.custom).toBe(false);
    expect(await configs.set(".md", 'python "${file}"', "output")).toMatch(/doesn't support/);
  });

  it("accepts quoted program names and arguments after the file", () => {
    expect(validateCommand('"python" "${file}" --x')).toBeNull();
    expect(validateCommand("pypy3 ${file}")).toBeNull();
  });

  it("ignores stored entries that are invalid", async () => {
    settings.set(
      "run.configurations",
      JSON.stringify({
        ".py": { command: "C:\\evil.exe ${file}", target: "output" },
        ".js": { command: 'node "${file}"', target: "elsewhere" },
        ".zip": { command: 'unzip "${file}"', target: "output" },
      }),
    );

    await configs.initialize();

    expect(configs.get(".py")?.custom).toBe(false);
    expect(configs.get(".js")?.custom).toBe(false);
  });
});

describe("RunCodeService", () => {
  let r: Rig;

  beforeEach(async () => {
    r = await rig();
  });

  it("works out how the active file would run when it is opened", async () => {
    await r.service.refresh();

    expect(r.ipc.runResolve).toHaveBeenCalledWith({
      file: "C:/p/hello.py",
      workspace: "C:/p",
      template: null,
    });
    expect(r.service.buttonView()).toMatchObject({ state: "ready", enabled: true });
    expect(r.service.canRun()).toBe(true);
  });

  it("asks again with the user's command when one is configured", async () => {
    await r.service.refresh();
    await r.configs.set(".py", 'python -u "${file}"', "output");
    await vi.waitFor(() => {
      expect(r.ipc.runResolve).toHaveBeenCalledTimes(2);
    });

    expect(vi.mocked(r.ipc.runResolve).mock.calls[1]?.[0].template).toBe('python -u "${file}"');
  });

  it("an unsupported file is disabled with Rust's reason, and an untitled file never asks Rust", async () => {
    vi.mocked(r.ipc.runResolve).mockResolvedValue(refused("JSON files can't be run."));
    r.open(tab("C:/p/package.json"));
    await r.service.refresh();
    expect(r.service.buttonView()).toMatchObject({
      enabled: false,
      tooltip: "JSON files can't be run.",
    });

    vi.mocked(r.ipc.runResolve).mockClear();
    r.open(tab(null));
    await r.service.refresh();
    expect(r.service.buttonView()).toMatchObject({
      enabled: false,
      tooltip: "Save the file before running.",
    });
    expect(r.ipc.runResolve).not.toHaveBeenCalled();
    expect(await r.service.run()).toBe(false);
    expect(r.errors).toContain("Save the file before running.");
  });

  it("a missing runtime says which one, and re-checks when the runtimes change", async () => {
    vi.mocked(r.ipc.runResolve).mockResolvedValue(
      refused("Python runtime is not installed.", { runtimeMissing: true }),
    );
    r.service.noteRuntimesChanged("python:-:0");
    await vi.waitFor(() => {
      expect(r.service.buttonView().state).toBe("runtimeMissing");
    });
    expect(r.service.buttonView().tooltip).toBe("Python runtime is not installed.");

    // The user installs Python in the Runtime Manager.
    vi.mocked(r.ipc.runResolve).mockResolvedValue(RUNNABLE);
    r.service.noteRuntimesChanged("python:3.14.7:1");
    await vi.waitFor(() => {
      expect(r.service.buttonView().state).toBe("ready");
    });
  });

  it("with Save Before Run off, a file with unsaved changes is not run and not saved", async () => {
    const off = await rig({}, { saveBeforeRun: () => false, clearOutputBeforeRun: () => true });
    off.open(tab("C:/p/hello.py", true));
    await off.service.refresh();

    expect(await off.service.run()).toBe(false);

    expect(off.workspace.save).not.toHaveBeenCalled();
    expect(off.ipc.runStart).not.toHaveBeenCalled();
    expect(off.service.getState().error).toContain("Save Before Run");
  });

  it("with Save Before Run on (the default), the file is saved first", async () => {
    r.open(tab("C:/p/hello.py", true));
    await r.service.refresh();

    expect(await r.service.run()).toBe(true);
    expect(r.workspace.save).toHaveBeenCalledWith("doc-1");
  });

  it("Clear Output Before Run decides whether the previous run's output is kept", async () => {
    const started = {
      runId: "run-1",
      type: "started" as const,
      file: "C:/p/hello.py",
      commandLine: "python hello.py",
      resolved: "C:/rt/python.exe",
      cwd: "C:/p",
      runtime: "OpenMind portable Python 3.14.7",
      language: "Python",
      pid: 7,
    };
    const keep = await rig({}, { saveBeforeRun: () => true, clearOutputBeforeRun: () => false });
    keep.output.append("Python", "old line");
    await keep.service.refresh();
    await keep.service.run();
    keep.emit(started);
    expect(keep.output.getLines("Python")[0]).toBe("old line");

    r.output.append("Python", "old line");
    await r.service.refresh();
    await r.service.run();
    r.emit(started);
    expect(r.output.getLines("Python")).not.toContain("old line");
  });

  it("runs the file, streams stdout and stderr into the language channel, shown beside the editor", async () => {
    await r.service.refresh();

    expect(await r.service.run()).toBe(true);
    r.emit({
      runId: "run-1",
      type: "started",
      file: "C:/p/hello.py",
      commandLine: "python hello.py",
      resolved: "C:/rt/python.exe",
      cwd: "C:/p",
      runtime: "OpenMind portable Python 3.14.7",
      language: "Python",
      pid: 7,
    });
    r.emit({ runId: "run-1", type: "output", stream: "stdout", line: "Hello world" });
    r.emit({ runId: "run-1", type: "output", stream: "stderr", line: "warning: x" });
    expect(r.service.buttonView()).toMatchObject({ state: "running", canStop: true });
    r.emit({ runId: "run-1", type: "exited", code: 0, durationMs: 120, stopped: false });

    expect(r.output.getLines("Python")).toEqual([
      "[Run Code] python hello.py",
      "cwd: C:/p",
      "runtime: OpenMind portable Python 3.14.7",
      "resolved: C:/rt/python.exe",
      "",
      "Hello world",
      "warning: x",
      "",
      "Process exited with code 0. (0.12s)",
    ]);
    const log = r.output.getLines("Run Code").join("\n");
    expect(log).toContain("[Run Code] python hello.py");
    expect(log).toContain("Process exited with code 0.");
    expect(r.output.getState().selected).toBe("Python");
    // The bottom panel stays closed (it opens only when the user opens it).
    expect(r.panel.getState().visible).toBe(false);
    // The same channel also opens beside the editor (the secondary side bar).
    expect(r.showBeside).toHaveBeenCalledWith("Python");
    expect(r.service.getState().lastRun).toMatchObject({
      path: "C:/p/hello.py",
      code: 0,
      stopped: false,
    });
    expect(r.service.buttonView().state).toBe("ready");
  });

  it("output that arrives before the start request returns is still tracked to the right file", async () => {
    let finish: (info: { runId: string; file: string; pid: number }) => void = () => undefined;
    vi.mocked(r.ipc.runStart).mockImplementation(
      () => new Promise((resolve) => (finish = resolve)),
    );
    await r.service.refresh();

    const running = r.service.run();
    r.emit({
      runId: "run-9",
      type: "started",
      file: "C:/p/hello.py",
      commandLine: "python x",
      resolved: "C:/rt/python.exe",
      cwd: "C:/p",
      runtime: "rt",
      language: "Python",
      pid: 1,
    });
    r.emit({ runId: "run-9", type: "output", stream: "stdout", line: "early" });
    finish({ runId: "run-9", file: "C:/p/hello.py", pid: 1 });
    await running;

    expect(r.output.getLines("Python")).toContain("early");
    expect(r.service.getState().running).toEqual({ "C:/p/hello.py": "run-9" });
  });

  it("a failing exit code is shown and remembered; TypeScript output goes to the Node.js channel", async () => {
    await r.service.refresh();
    await r.service.run();
    r.emit({
      runId: "run-1",
      type: "started",
      file: "C:/p/hello.py",
      commandLine: "tsx a.ts",
      resolved: "C:/rt/python.exe",
      cwd: "C:/p",
      runtime: "rt",
      language: "TypeScript",
      pid: 1,
    });
    r.emit({ runId: "run-1", type: "exited", code: 2, durationMs: 5, stopped: false });

    expect(r.output.getLines("Node.js").at(-1)).toBe("Process exited with code 2. (0.01s)");
    expect(r.service.getState().lastRun?.code).toBe(2);
    expect(channelFor("TypeScript")).toBe("Node.js");
    expect(channelFor("PHP")).toBe("PHP");
  });

  it("a run that cannot start reports why in the Run Code channel and on the button", async () => {
    vi.mocked(r.ipc.runStart).mockRejectedValue("Python runtime is not installed.");
    await r.service.refresh();

    expect(await r.service.run()).toBe(false);

    expect(r.output.getLines("Run Code").join("\n")).toContain("Python runtime is not installed.");
    expect(r.service.buttonView()).toMatchObject({ state: "error" });
    expect(r.errors).toContain("Python runtime is not installed.");
    expect(r.output.getState().selected).toBe("Run Code");
    // The reason shows beside the editor too, like every run.
    expect(r.showBeside).toHaveBeenCalledWith("Run Code");
  });

  it("does not start a second run of the same file", async () => {
    await r.service.refresh();
    await r.service.run();
    r.emit({
      runId: "run-1",
      type: "started",
      file: "C:/p/hello.py",
      commandLine: "x",
      resolved: "C:/rt/python.exe",
      cwd: "C:/p",
      runtime: "rt",
      language: "Python",
      pid: 1,
    });

    expect(await r.service.run()).toBe(false);
    expect(r.ipc.runStart).toHaveBeenCalledTimes(1);
  });

  it("Stop asks Rust to stop that run, and a stopped exit is reported as stopped", async () => {
    await r.service.refresh();
    await r.service.run();
    r.emit({
      runId: "run-1",
      type: "started",
      file: "C:/p/hello.py",
      commandLine: "x",
      resolved: "C:/rt/python.exe",
      cwd: "C:/p",
      runtime: "rt",
      language: "Python",
      pid: 1,
    });
    expect(r.service.canStop()).toBe(true);

    await r.service.stop();
    r.emit({ runId: "run-1", type: "exited", code: null, durationMs: 1500, stopped: true });

    expect(r.ipc.runStop).toHaveBeenCalledWith("run-1");
    expect(r.output.getLines("Python").at(-1)).toBe("Process stopped. (1.50s)");
    expect(r.service.canStop()).toBe(false);
    expect(r.service.getState().lastRun).toMatchObject({ stopped: true });
  });

  describe("unsaved changes", () => {
    it("saves a file that has changes before running it", async () => {
      r.open(tab("C:/p/hello.py", true));
      await r.service.refresh();

      expect(await r.service.run()).toBe(true);

      expect(r.workspace.save).toHaveBeenCalledWith("doc-1");
      expect(r.ipc.runStart).toHaveBeenCalledTimes(1);
    });

    it("does not run if the save did not go through", async () => {
      r.open(tab("C:/p/hello.py", true));
      await r.service.refresh();
      // A save that leaves the file dirty (cancelled or failed).
      r.workspace.save.mockImplementation(() => undefined);
      const stubbed = r.service as unknown as {
        workspace: { save: (id: string) => Promise<void> };
      };
      stubbed.workspace.save = () => Promise.resolve();

      expect(await r.service.run()).toBe(false);

      expect(r.ipc.runStart).not.toHaveBeenCalled();
      expect(r.errors.at(-1)).toMatch(/couldn't be saved/);
    });
  });

  describe("running in a terminal", () => {
    it("opens a terminal if needed and types the quoted command, showing the terminal", async () => {
      await r.service.refresh();

      expect(await r.service.run({ target: "terminal" })).toBe(true);

      expect(r.ipc.runTerminalCommand).toHaveBeenCalledWith(
        { file: "C:/p/hello.py", workspace: "C:/p", template: null },
        "powerShell",
      );
      expect(r.ipc.terminalWrite).toHaveBeenCalledWith(
        "t1",
        "& 'C:/py/python.exe' 'C:/p/hello.py'\r",
      );
      expect(r.panel.getState()).toMatchObject({ visible: true, activeTab: "terminal" });
      expect(r.output.getLines("Run Code").join("\n")).toContain(
        "Sent to the terminal: python hello.py",
      );
      expect(r.ipc.runStart).not.toHaveBeenCalled();
    });

    it("reuses the active terminal instead of opening another", async () => {
      await r.terminal.createTerminal();
      await r.service.refresh();

      await r.service.run({ target: "terminal" });

      expect(r.ipc.terminalCreate).toHaveBeenCalledTimes(1);
    });

    it("refuses WSL terminals rather than typing a path they cannot use", async () => {
      vi.mocked(r.ipc.terminalCreate).mockResolvedValue({
        id: "w1",
        shell: "wsl",
        cwd: "C:/p",
        pid: 2,
      });
      vi.mocked(r.ipc.terminalListShells).mockResolvedValue([
        { kind: "wsl", label: "WSL", available: true },
      ]);
      const wsl = await rig({
        terminalCreate: vi.fn().mockResolvedValue({ id: "w1", shell: "wsl", cwd: "C:/p", pid: 2 }),
        terminalListShells: vi
          .fn()
          .mockResolvedValue([{ kind: "wsl", label: "WSL", available: true }]),
      });
      await wsl.service.refresh();

      expect(await wsl.service.run({ target: "terminal" })).toBe(false);

      expect(wsl.errors.at(-1)).toMatch(/WSL/);
      expect(wsl.ipc.terminalWrite).not.toHaveBeenCalled();
    });

    it("shellStyleFor maps terminals to quoting styles", () => {
      expect(shellStyleFor("powerShell")).toBe("powerShell");
      expect(shellStyleFor("cmd")).toBe("cmd");
      expect(shellStyleFor("gitBash")).toBe("bash");
      expect(shellStyleFor("wsl")).toBeNull();
    });

    it("uses the configured target when none is given", async () => {
      await r.configs.set(".py", 'python -u "${file}"', "terminal");
      await r.service.refresh();

      await r.service.run();

      expect(r.ipc.runTerminalCommand).toHaveBeenCalled();
      expect(r.ipc.runStart).not.toHaveBeenCalled();
    });
  });
});

describe("Run menu", () => {
  const flush = async (r: Rig) => {
    await r.service.refresh();
  };
  const labels = (rows: ReturnType<typeof buildRunMenu>) =>
    rows.flatMap((row) => (row.kind === "separator" ? [] : [row.label]));

  it("offers the run actions, configure and select runtime; Stop only appears while running", async () => {
    const r = await rig();
    await flush(r);
    const run = vi.fn();
    const build = () => buildRunMenu({ runCode: r.service, configs: r.configs, run });

    expect(labels(build())).toEqual([
      "Run Code",
      "Run Code in Terminal",
      "Run Code and Show Output",
      "Configure Run Command…",
      "Select Runtime…",
    ]);
    await r.service.run();
    r.emit({
      runId: "run-1",
      type: "started",
      file: "C:/p/hello.py",
      commandLine: "x",
      resolved: "C:/rt/python.exe",
      cwd: "C:/p",
      runtime: "rt",
      language: "Python",
      pid: 1,
    });

    const running = build();
    expect(labels(running).at(-1)).toBe("Stop Running Code");
    expect(running.find((row) => row.kind === "item" && row.label === "Run Code")).toMatchObject({
      enabled: false,
      reason: "Already running — stop it first.",
    });
  });

  it("with an unrunnable file the run rows are disabled with the real reason, but Select Runtime still works", async () => {
    const r = await rig({
      runResolve: vi
        .fn()
        .mockResolvedValue(refused("Python runtime is not installed.", { runtimeMissing: true })),
    });
    await flush(r);
    const rows = buildRunMenu({ runCode: r.service, configs: r.configs, run: vi.fn() });

    for (const label of ["Run Code", "Run Code in Terminal", "Run Code and Show Output"]) {
      expect(
        rows.find((row) => row.kind === "item" && row.label === label),
        label,
      ).toMatchObject({
        enabled: false,
        reason: "Python runtime is not installed.",
      });
    }
    expect(
      rows.find((row) => row.kind === "item" && row.label === "Select Runtime…"),
    ).toMatchObject({ enabled: true });
  });

  it("shows the disabled reason as text in the dropdown (once, on Run Code), not only as a tooltip", async () => {
    const r = await rig({
      runResolve: vi
        .fn()
        .mockResolvedValue(refused("PHP runtime is not installed yet.", { runtimeMissing: true })),
    });
    r.open(tab("C:/p/index.php"));
    await flush(r);
    const rows = buildRunMenu({ runCode: r.service, configs: r.configs, run: vi.fn() });
    const shown = rows.filter((row) => row.kind === "item" && row.showReason === true);

    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({
      label: "Run Code",
      reason: "PHP runtime is not installed yet.",
    });
    expect(r.service.buttonView()).toMatchObject({
      state: "runtimeMissing",
      enabled: false,
      tooltip: "PHP runtime is not installed yet.",
    });
  });

  it("an unsaved file says to save it, in the button and in the dropdown", async () => {
    const r = await rig();
    r.open(tab(null));
    await flush(r);
    const rows = buildRunMenu({ runCode: r.service, configs: r.configs, run: vi.fn() });

    expect(r.service.buttonView().tooltip).toBe("Save the file before running.");
    expect(rows.find((row) => row.kind === "item" && row.label === "Run Code")).toMatchObject({
      enabled: false,
      reason: "Save the file before running.",
      showReason: true,
    });
  });

  it("a system interpreter is labelled as such in the Output, with the resolved path on its own line", async () => {
    const r = await rig();
    await flush(r);
    await r.service.run();
    r.emit({
      runId: "run-1",
      type: "started",
      file: "C:/p/hello.py",
      commandLine: "python hello.py",
      resolved: "C:/Python314/python.exe",
      cwd: "C:/p",
      runtime: "System Python",
      language: "Python",
      pid: 1,
    });

    expect(r.output.getLines("Python").slice(0, 4)).toEqual([
      "[Run Code] python hello.py",
      "cwd: C:/p",
      "runtime: System Python",
      "resolved: C:/Python314/python.exe",
    ]);
  });

  it("a Markdown file offers previews instead, and Configure is disabled with a reason", async () => {
    const r = await rig({
      runResolve: vi
        .fn()
        .mockResolvedValue(
          refused("Markdown files aren't run — open the preview instead.", { previewable: true }),
        ),
    });
    r.open(tab("C:/p/README.md"));
    await flush(r);

    const rows = buildRunMenu({ runCode: r.service, configs: r.configs, run: vi.fn() });

    expect(labels(rows)).toContain("Open Markdown Preview");
    expect(labels(rows)).toContain("Open Preview to the Side");
    expect(
      rows.find((row) => row.kind === "item" && row.label === "Configure Run Command…"),
    ).toMatchObject({
      enabled: false,
      reason: expect.stringContaining("doesn't support") as string,
    });
  });

  it("menu rows run the matching commands", async () => {
    const r = await rig();
    await flush(r);
    const run = vi.fn();
    const rows = buildRunMenu({ runCode: r.service, configs: r.configs, run });
    const select = (label: string) => {
      const row = rows.find((candidate) => candidate.kind === "item" && candidate.label === label);
      if (row?.kind === "item") row.onSelect();
    };

    select("Run Code in Terminal");
    select("Run Code and Show Output");
    select("Configure Run Command…");
    select("Select Runtime…");

    expect(run.mock.calls.map((call) => call[0] as string)).toEqual([
      "run.codeInTerminal",
      "run.codeShowOutput",
      "run.configure",
      "run.selectRuntime",
    ]);
  });
});

describe("Run commands and shortcuts", () => {
  it("commands are enabled only when they can work and run the service", async () => {
    const r = await rig();
    const commands = new CommandRegistry();
    registerRunCommands({ commands, events: r.events, runCode: r.service, configs: r.configs });

    expect(commands.isEnabled("run.code")).toBe(true);
    expect(commands.isEnabled("debug.runWithoutDebugging")).toBe(true);
    expect(commands.isEnabled("run.stop")).toBe(false);
    expect(commands.isEnabled("run.configure")).toBe(true);

    await commands.execute("run.codeShowOutput");
    expect(r.ipc.runStart).toHaveBeenCalledTimes(1);
    r.emit({
      runId: "run-1",
      type: "started",
      file: "C:/p/hello.py",
      commandLine: "x",
      resolved: "C:/rt/python.exe",
      cwd: "C:/p",
      runtime: "rt",
      language: "Python",
      pid: 1,
    });
    expect(commands.isEnabled("run.stop")).toBe(true);
    expect(commands.isEnabled("run.code")).toBe(false);
    await commands.execute("run.stop");
    expect(r.ipc.runStop).toHaveBeenCalledWith("run-1");
  });

  it("configure and select-runtime raise the UI events", async () => {
    const r = await rig();
    const commands = new CommandRegistry();
    registerRunCommands({ commands, events: r.events, runCode: r.service, configs: r.configs });
    const configure = vi.fn();
    const runtimes = vi.fn();
    r.events.on("showRunConfiguration", configure);
    r.events.on("showRuntimeManager", runtimes);

    await commands.execute("run.configure");
    await commands.execute("run.selectRuntime");

    expect(configure).toHaveBeenCalledTimes(1);
    expect(runtimes).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+F5 runs code, Ctrl+Shift+F5 stops it, and plain F5 does nothing (future debugger)", async () => {
    const r = await rig();
    const commands = new CommandRegistry();
    registerRunCommands({ commands, events: r.events, runCode: r.service, configs: r.configs });
    const keybindings = new KeybindingService(commands);
    const press = (init: KeyboardEventInit) =>
      keybindings.resolve(new KeyboardEvent("keydown", init));

    expect(press({ code: "F5", ctrlKey: true })).toBe("run.code");
    expect(press({ code: "F5" })).toBeNull();
    expect(commands.isEnabled("debug.start")).toBe(false);
    expect(keybindings.labelFor("run.code")).toBe("Ctrl+F5");
    expect(keybindings.labelFor("run.stop")).toBe("Ctrl+Shift+F5");

    // Stop is only reachable while something is running.
    expect(press({ code: "F5", ctrlKey: true, shiftKey: true })).toBeNull();
    await commands.execute("run.code");
    r.emit({
      runId: "run-1",
      type: "started",
      file: "C:/p/hello.py",
      commandLine: "x",
      resolved: "C:/rt/python.exe",
      cwd: "C:/p",
      runtime: "rt",
      language: "Python",
      pid: 1,
    });
    expect(press({ code: "F5", ctrlKey: true, shiftKey: true })).toBe("run.stop");
  });

  it("the Run menu lists the run commands, and every menu command has its shortcut only if registered", () => {
    const ids = collectCommandIds(buildMenuBar({ folders: [], files: [] }));

    for (const id of [
      "run.code",
      "run.codeInTerminal",
      "run.codeShowOutput",
      "run.stop",
      "run.configure",
      "run.selectRuntime",
    ]) {
      expect(ids, id).toContain(id);
    }
  });
});

describe("Run Code and interactive input (Milestone 22.4)", () => {
  it("a file that reads the keyboard is offered the terminal; Cancel runs nothing; Run Anyway uses the Output", async () => {
    for (const [answer, started, typed] of [
      ["terminal", false, true],
      ["output", true, false],
      [null, false, false],
    ] as const) {
      const r = await rig();
      const choose = vi.fn().mockResolvedValue(answer);
      r.service.setInteractiveHost({ text: () => 'name = input("Enter your name: ")', choose });
      await r.service.run();
      expect(choose).toHaveBeenCalledWith("C:/p/hello.py");
      expect(r.ipc.runStart).toHaveBeenCalledTimes(started ? 1 : 0);
      expect(r.ipc.runTerminalCommand).toHaveBeenCalledTimes(typed ? 1 : 0);
    }
  });

  it("a file without input runs in the Output as before, without asking", async () => {
    const r = await rig();
    const choose = vi.fn();
    r.service.setInteractiveHost({ text: () => "print('hello')", choose });
    await r.service.run();
    expect(choose).not.toHaveBeenCalled();
    expect(r.ipc.runStart).toHaveBeenCalledOnce();
  });

  it("a run that hit EOFError says it needs the terminal", async () => {
    const r = await rig();
    const notices: string[] = [];
    r.events.on("appNotice", ({ message }) => notices.push(message));
    r.emit({ type: "started", runId: "run-1", file: "C:/p/hello.py", language: "Python", commandLine: "python hello.py", cwd: "C:/p", runtime: "OpenMind portable Python 3.14.7", resolved: "C:/py/python.exe", pid: 7 });
    r.emit({ type: "output", runId: "run-1", stream: "stderr", line: "EOFError: EOF when reading a line" });
    r.emit({ type: "exited", runId: "run-1", code: 1, stopped: false, durationMs: 40 });
    const lines = r.output.getLines(channelFor("Python"));
    expect(lines).toContain("This program needs interactive input. Run it in the integrated terminal.");
    expect(notices).toEqual(["This program needs interactive input. Run it in the integrated terminal."]);
  });
});

describe("Run Code for compiled languages (Milestone 22.5)", () => {
  const building = {
    type: "building",
    runId: "run-1",
    file: "C:/p/hello.c",
    language: "C",
    commandLine: "clang hello.c -o hello.exe",
    cwd: "C:/p",
    runtime: "OpenMind portable clang (llvm-mingw 20260922)",
    compiler: "C:/app/runtimes/llvm-mingw/versions/20260922/bin/clang.exe",
    pid: 5,
  } as const;

  it("shows the build, then the program's own output apart from it", async () => {
    const r = await rig();
    r.emit(building);
    r.emit({ type: "output", runId: "run-1", stream: "stderr", line: "hello.c:2: warning: unused", phase: "build" });
    r.emit({ type: "built", runId: "run-1", success: true, code: 0, durationMs: 420 });
    r.emit({ type: "started", runId: "run-1", file: "C:/p/hello.c", language: "C", commandLine: "hello.exe", cwd: "C:/p", runtime: building.runtime, resolved: "C:/app/cache/run-builds/run-1/hello.exe", pid: 6 });
    expect(r.service.getState().running).toEqual({ "C:/p/hello.c": "run-1" });
    r.emit({ type: "output", runId: "run-1", stream: "stdout", line: "Status: Adult", phase: "run" });
    r.emit({ type: "exited", runId: "run-1", code: 0, stopped: false, durationMs: 900, buildFailed: false });
    expect(r.output.getLines("C")).toEqual([
      "[Run Code] clang hello.c -o hello.exe",
      "cwd: C:/p",
      `compiler: ${building.runtime}`,
      `resolved: ${building.compiler}`,
      "",
      "Building...",
      "hello.c:2: warning: unused",
      "Build succeeded. (0.42s)",
      "",
      "> hello.exe",
      "",
      "Status: Adult",
      "",
      "Process exited with code 0. (0.90s)",
    ]);
    expect(r.service.getState().running).toEqual({});
  });

  it("a failed build says the program was not run", async () => {
    const r = await rig();
    r.emit(building);
    r.emit({ type: "output", runId: "run-1", stream: "stderr", line: "hello.c:3: error: use of undeclared identifier", phase: "build" });
    r.emit({ type: "built", runId: "run-1", success: false, code: 1, durationMs: 300 });
    r.emit({ type: "exited", runId: "run-1", code: 1, stopped: false, durationMs: 310, buildFailed: true });
    const lines = r.output.getLines("C");
    expect(lines).toContain("Build failed with exit code 1. The program was not run.");
    expect(lines[lines.length - 1]).toBe("Build failed. (0.31s)");
    expect(lines.some((line) => line.startsWith("Process exited"))).toBe(false);
    expect(r.service.getState().lastRun).toMatchObject({ path: "C:/p/hello.c", code: 1 });
  });

  it("compiler output can become Problems entries", () => {
    expect(parseBuildProblem("hello.f90:7:14: Error: Symbol 'x' has no IMPLICIT type")).toMatchObject({
      severity: "error",
      source: "compiler",
      line: 7,
      column: 14,
      message: "Symbol 'x' has no IMPLICIT type",
    });
    expect(parseBuildProblem("program.pas(3,5) Warning: Variable \"i\" does not seem to be initialized")).toMatchObject({
      severity: "warning",
      line: 3,
      column: 5,
    });
  });

  it("a C, C++, Java or Rust file that reads the keyboard is offered the terminal first", async () => {
    for (const [path, text] of [
      ["C:/p/hello.c", 'scanf("%d", &age);'],
      ["C:/p/hello.cpp", "std::cin >> age;"],
      ["C:/p/Hello.java", "Scanner in = new Scanner(System.in);"],
      ["C:/p/hello.rs", "std::io::stdin().read_line(&mut s).unwrap();"],
    ] as const) {
      const r = await rig();
      r.open(tab(path));
      const choose = vi.fn().mockResolvedValue("terminal");
      r.service.setInteractiveHost({ text: () => text, choose });
      await r.service.run();
      expect(choose, path).toHaveBeenCalledWith(path);
      expect(r.ipc.runStart, path).not.toHaveBeenCalled();
      expect(r.ipc.runTerminalCommand, path).toHaveBeenCalledOnce();
    }
  });

  it("Java's Scanner without input is explained like Python's EOFError", async () => {
    const r = await rig();
    r.emit({ type: "started", runId: "run-1", file: "C:/p/Hello.java", language: "Java", commandLine: "java Hello", cwd: "C:/p", runtime: "System javac", resolved: "C:/jdk/bin/java.exe", pid: 7 });
    r.emit({ type: "output", runId: "run-1", stream: "stderr", line: 'Exception in thread "main" java.util.NoSuchElementException: No line found' });
    r.emit({ type: "exited", runId: "run-1", code: 1, stopped: false, durationMs: 40 });
    expect(r.output.getLines("Java")).toContain("This program needs interactive input. Run it in the integrated terminal.");
  });
});

describe("Run Anyway for a program that reads input (Milestone 22.5)", () => {
  it("says at the end why it got no input, even when the program printed no error (C, Rust)", async () => {
    const r = await rig();
    r.open(tab("C:/p/hello.c"));
    r.service.setInteractiveHost({ text: () => 'scanf("%d", &age);', choose: vi.fn().mockResolvedValue("output") });
    await r.service.run();
    expect(r.ipc.runStart).toHaveBeenCalledOnce();
    r.emit({ type: "started", runId: "run-1", file: "C:/p/hello.c", language: "C", commandLine: "hello.exe", cwd: "C:/p", runtime: "System clang", resolved: "C:/b/hello.exe", pid: 7 });
    r.emit({ type: "output", runId: "run-1", stream: "stdout", line: "Enter your age: " });
    r.emit({ type: "exited", runId: "run-1", code: 1, stopped: false, durationMs: 20 });
    expect(r.output.getLines("C")).toContain("This program needs interactive input. Run it in the integrated terminal.");
  });
});
