import { beforeEach, describe, expect, it, vi } from "vitest";

import { backendFeeds } from "../testUtils/canonicalFeeds";
import { createFakeIpc, type FakeIpc } from "../testUtils/fakeIpcClient";
import { BreakpointService } from "./breakpointService";
import { CallStackService } from "./callStackService";
import { CommandRegistry } from "./commandRegistry";
import { DebugConfigurationService } from "./debugConfigurationService";
import { registerDebugCommands } from "./debugCommands";
import { DebugConsoleService } from "./debugConsoleService";
import { parseEvaluate } from "./debugModel";
import { DebugService } from "./debugService";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { DebugEventPayload, DebugReadiness, DebugRun, DebugStatus } from "./ipc";
import { DEFAULT_KEYBINDINGS } from "./keybindings";
import { VariablesService } from "./variablesService";
import { WatchService } from "./watchService";

const FILE = "C:/My Site/tool.py";

const ready = (target: DebugReadiness["target"]): DebugReadiness => ({
  target,
  ready: true,
  problem: null,
  interpreter: "OpenMind portable Python",
  installKind: null,
});

const STATUS: DebugStatus = {
  workspace: "C:/My Site",
  run: null,
  python: ready("python"),
  node: ready("node"),
  php: {
    target: "php",
    ready: false,
    problem: "PHP debugging requires Xdebug and is not available yet.",
    interpreter: null,
    installKind: null,
  },
};

const run = (state: DebugRun["state"], patch: Partial<DebugRun> = {}): DebugRun => ({
  runId: 1,
  configName: "Python: Current File",
  target: "python",
  state,
  program: FILE,
  pid: 7,
  ...patch,
});

const stoppedRun = run("stopped", {
  stopped: {
    reason: "breakpoint",
    threadId: 1,
    description: null,
    text: null,
    allThreadsStopped: true,
  },
});

interface Rig {
  ipc: FakeIpc;
  events: EventBus<AppEvents>;
  debug: DebugService;
  breakpoints: BreakpointService;
  console: DebugConsoleService;
  callStack: CallStackService;
  variables: VariablesService;
  watches: WatchService;
  commands: CommandRegistry;
  sent: { state?: (run: DebugRun) => void; event?: (event: DebugEventPayload) => void };
  file: { current: { path: string; docId: string } | null };
  revealed: [string, number, number][];
  saved: string[];
  errors: string[];
}

async function rig(): Promise<Rig> {
  const sent: Rig["sent"] = {};
  const ipc = createFakeIpc({
    debugStatus: vi.fn().mockResolvedValue(STATUS),
    debugStart: vi.fn().mockResolvedValue(run("starting")),
    onDebugState: vi.fn().mockImplementation((handler: (run: DebugRun) => void) => {
      sent.state = handler;
      return Promise.resolve(() => undefined);
    }),
    onDebugEvent: vi.fn().mockImplementation((handler: (event: DebugEventPayload) => void) => {
      sent.event = handler;
      return Promise.resolve(() => undefined);
    }),
    debugRequest: vi
      .fn()
      .mockImplementation(
        (command: string, args: { expression?: string; variablesReference?: number }) => {
          switch (command) {
            case "stackTrace":
              return Promise.resolve({
                stackFrames: [
                  { id: 11, name: "greet", line: 2, column: 1, source: { path: FILE } },
                  { id: 12, name: "<module>", line: 5, column: 1, source: { path: FILE } },
                ],
              });
            case "scopes":
              return Promise.resolve({
                scopes: [
                  { name: "Locals", variablesReference: 100 },
                  { name: "Globals", variablesReference: 200, expensive: true },
                ],
              });
            case "variables":
              return Promise.resolve({
                variables:
                  args.variablesReference !== 300
                    ? [
                        { name: "name", value: "'x'", type: "str", variablesReference: 0 },
                        { name: "items", value: "list", variablesReference: 300 },
                      ]
                    : [],
              });
            case "evaluate":
              return Promise.resolve({
                result: `<${args.expression ?? ""}>`,
                variablesReference: 0,
              });
            default:
              return Promise.resolve(null);
          }
        },
      ),
  });
  const events = new EventBus<AppEvents>();
  const errors: string[] = [];
  events.on("appError", ({ message }) => errors.push(message));
  const breakpoints = new BreakpointService(ipc, () => debug.isDebugging());
  const file: Rig["file"] = { current: { path: FILE, docId: "doc-1" } };
  const saved: string[] = [];
  const revealed: [string, number, number][] = [];
  const callStack = new CallStackService(ipc, events, (path, line, column) => {
    revealed.push([path, line, column]);
  });
  const variables = new VariablesService(ipc, events);
  const watches = new WatchService(ipc, events);
  const debugConsole: DebugConsoleService = new DebugConsoleService(
    async (expression) =>
      parseEvaluate(await debug.evaluate(expression, callStack.selected()?.id ?? null)),
    () => debug.evaluateUnavailable(),
  );
  const debug: DebugService = new DebugService(
    ipc,
    events,
    breakpoints,
    new DebugConfigurationService(),
    debugConsole,
    {
      activeFile: () => file.current,
      saveIfDirty: (id) => {
        saved.push(id);
        return Promise.resolve(true);
      },
      workspacePath: () => "C:/My Site",
      showConsole: () => undefined,
      log: () => undefined,
    },
  );
  callStack.initialize();
  variables.initialize();
  await watches.initialize();
  // The folder's debug readiness, as the canonical state delivers it.
  const readiness = backendFeeds(ipc).debug;
  debug.useCanonical(readiness);
  await readiness.refresh();
  await debug.initialize();
  const commands = new CommandRegistry();
  registerDebugCommands({
    commands,
    debug,
    breakpoints,
    editor: { hasEditor: () => true, getStatus: () => ({ line: 4 }) } as unknown as Parameters<
      typeof registerDebugCommands
    >[0]["editor"],
    events,
    activeFile: () => file.current,
  });
  return {
    ipc,
    events,
    debug,
    breakpoints,
    console: debugConsole,
    callStack,
    variables,
    watches,
    commands,
    sent,
    file,
    revealed,
    saved,
    errors,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("starting a debug session", () => {
  let r: Rig;
  beforeEach(async () => {
    r = await rig();
  });

  it("only F5 starts one: launch config for the file in front, saved first, enabled breakpoints go along", async () => {
    r.breakpoints.toggle(FILE, 2);
    r.breakpoints.toggle("C:/My Site/other.py", 9);
    r.breakpoints.setEnabled(r.breakpoints.at("C:/My Site/other.py", 9)?.id ?? "", false);
    expect(r.ipc.debugStart).not.toHaveBeenCalled();

    expect(await r.debug.start()).toBe(true);
    expect(r.saved).toEqual(["doc-1"]);
    expect(r.ipc.debugStart).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Python: Current File",
        target: "python",
        program: FILE,
        cwd: "C:/My Site",
      }),
      [{ filePath: FILE, line: 2, enabled: true }],
    );
    expect(r.debug.isDebugging()).toBe(true);
  });

  it("nothing starts when it can't: no file, unsupported file, PHP, or a session already running", async () => {
    r.file.current = null;
    expect(await r.debug.start()).toBe(false);
    r.file.current = { path: "C:/My Site/notes.txt", docId: "d" };
    expect(await r.debug.start()).toBe(false);
    r.file.current = { path: "C:/My Site/index.php", docId: "d" };
    expect(await r.debug.start()).toBe(false);
    expect(r.debug.startState().reason).toBe(
      "PHP debugging requires Xdebug and is not available yet.",
    );
    r.file.current = { path: FILE, docId: "doc-1" };
    r.sent.state?.(run("running"));
    expect(await r.debug.start()).toBe(false);
    expect(r.ipc.debugStart).not.toHaveBeenCalled();
  });

  it("a refused start is shown in the console and as an error, and no session exists", async () => {
    vi.mocked(r.ipc.debugStart).mockRejectedValue("Python debugger is not installed yet.");
    expect(await r.debug.start()).toBe(false);
    expect(r.errors).toEqual(["Python debugger is not installed yet."]);
    expect(r.console.getState().lines.some((line) => line.kind === "error")).toBe(true);
    expect(r.debug.isDebugging()).toBe(false);
  });

  it("if the file can't be saved, debugging doesn't start", async () => {
    const rejecting = await rig();
    // Rebuild a service whose save fails.
    const failing = new DebugService(
      rejecting.ipc,
      rejecting.events,
      rejecting.breakpoints,
      new DebugConfigurationService(),
      rejecting.console,
      {
        activeFile: () => ({ path: FILE, docId: "d" }),
        saveIfDirty: () => Promise.resolve(false),
        workspacePath: () => null,
        showConsole: () => undefined,
        log: () => undefined,
      },
    );
    failing.useCanonical(backendFeeds(rejecting.ipc).debug);
    await failing.refreshStatus();
    expect(await failing.start()).toBe(false);
    expect(rejecting.ipc.debugStart).not.toHaveBeenCalled();
  });
});

describe("launch.json configurations", () => {
  it("a chosen configuration that can't run blocks Start with its reason; a runnable one starts its own program", async () => {
    const r = await rig();
    const cpp = {
      name: "C++",
      source: "C:/w/.vscode/launch.json",
      typeName: "cppdbg",
      request: "launch",
      config: null,
      problem: 'The debugger type "cppdbg" is not supported.',
      notes: [],
    };
    const app = {
      ...cpp,
      name: "App",
      typeName: "debugpy",
      problem: null,
      config: { name: "App", target: "python" as const, program: "C:/w/app.py", cwd: "C:/w", args: [], stopOnEntry: false, env: { A: "1" } },
    };
    vi.mocked(r.ipc.debugConfigurations).mockResolvedValue({
      files: [{ path: "C:/w/.vscode/launch.json", error: null, configurations: [cpp, app], compounds: [] }],
      extensionDebuggers: [],
    });
    const configs = new DebugConfigurationService(r.ipc);
    const saveAll = vi.fn(() => Promise.resolve());
    const debug = new DebugService(r.ipc, r.events, r.breakpoints, configs, r.console, {
      activeFile: () => null,
      saveIfDirty: () => Promise.resolve(true),
      workspacePath: () => "C:/w",
      showConsole: () => undefined,
      log: () => undefined,
      saveAll,
    });
    debug.useCanonical(backendFeeds(r.ipc).debug);
    await debug.refreshStatus();
    await configs.refresh(null);
    configs.choose("C:/w/.vscode/launch.json::C++");
    expect(debug.startState()).toEqual({ enabled: false, reason: 'C++: The debugger type "cppdbg" is not supported.' });
    configs.choose("C:/w/.vscode/launch.json::App");
    expect(debug.startState().enabled).toBe(true);
    expect(await debug.start()).toBe(true);
    expect(saveAll).toHaveBeenCalled();
    expect(r.ipc.debugStart).toHaveBeenCalledWith(expect.objectContaining({ program: "C:/w/app.py", env: { A: "1" } }), []);
    expect(configs.entries(null, "C:/w")[0]?.name).toBe("App");
  });
});

describe("a paused program", () => {
  let r: Rig;
  beforeEach(async () => {
    r = await rig();
    await r.debug.start();
  });

  it("pausing reads the call stack, opens the file at the top frame and shows its variables", async () => {
    r.sent.state?.(stoppedRun);
    await vi.waitFor(() => {
      expect(r.variables.getState().scopes[0]?.variables?.length).toBe(2);
    });
    expect(r.callStack.getState().frames.map((f) => f.name)).toEqual(["greet", "<module>"]);
    expect(r.callStack.selected()?.id).toBe(11);
    expect(r.callStack.location()).toEqual({ path: FILE, line: 2, column: 1 });
    expect(r.revealed).toEqual([[FILE, 2, 1]]);
    const locals = r.variables.getState().scopes[0];
    expect(locals?.expanded).toBe(true);
    expect(locals?.variables?.map((v) => [v.variable.name, v.variable.value])).toEqual([
      ["name", "'x'"],
      ["items", "list"],
    ]);
    // The expensive scope (Globals) is not read until asked for.
    expect(r.variables.getState().scopes[1]?.variables).toBeNull();
    expect(r.debug.controlState("stepOver").enabled).toBe(true);
    expect(r.debug.controlState("pause").enabled).toBe(false);
  });

  it("clicking another frame opens its line and shows that frame's variables", async () => {
    r.sent.state?.(stoppedRun);
    await vi.waitFor(() => {
      expect(r.callStack.getState().frames).toHaveLength(2);
    });
    const other = r.callStack.getState().frames[1];
    if (!other) throw new Error("no frame");
    r.callStack.select(other);
    expect(r.callStack.selected()?.id).toBe(12);
    expect(r.revealed.at(-1)).toEqual([FILE, 5, 1]);
    await vi.waitFor(() => {
      expect(vi.mocked(r.ipc.debugRequest)).toHaveBeenCalledWith("scopes", { frameId: 12 });
    });
  });

  it("a variable with children loads them only when expanded", async () => {
    r.sent.state?.(stoppedRun);
    await vi.waitFor(() => {
      expect(r.variables.getState().scopes[0]?.variables?.length).toBe(2);
    });
    const items = r.variables.getState().scopes[0]?.variables?.[1];
    expect(items?.children).toBeNull();
    await r.variables.toggleVariable(items?.key ?? "");
    const after = r.variables.getState().scopes[0]?.variables?.[1];
    expect(after?.expanded).toBe(true);
    expect(after?.children).toEqual([]);
    await r.variables.toggleVariable(items?.key ?? "");
    expect(r.variables.getState().scopes[0]?.variables?.[1]?.expanded).toBe(false);
  });

  it("watch expressions are evaluated in the selected frame while paused and blanked when running", async () => {
    r.watches.add("name + '!'");
    expect(r.watches.getState().entries[0]?.value).toBeNull();
    r.sent.state?.(stoppedRun);
    await vi.waitFor(() => {
      expect(r.watches.getState().entries[0]?.value).toBe("<name + '!'>");
    });
    expect(r.ipc.debugRequest).toHaveBeenCalledWith("evaluate", {
      expression: "name + '!'",
      frameId: 11,
      context: "watch",
    });
    expect(r.ipc.settingsSet).toHaveBeenCalledWith("debug.watch", JSON.stringify(["name + '!'"]));
    r.sent.state?.(run("running"));
    await vi.waitFor(() => {
      expect(r.watches.getState().entries[0]?.value).toBeNull();
    });
    expect(r.callStack.getState().frames).toEqual([]);
    expect(r.variables.getState().scopes).toEqual([]);
    r.watches.remove(r.watches.getState().entries[0]?.id ?? 0);
    expect(r.watches.getState().entries).toEqual([]);
  });

  it("a watch that the adapter rejects shows its error", async () => {
    vi.mocked(r.ipc.debugRequest).mockImplementation((command: string) =>
      command === "evaluate"
        ? Promise.reject(new Error("name 'zz' is not defined"))
        : Promise.resolve({
            stackFrames: [{ id: 1, name: "f", line: 1, column: 1, source: { path: FILE } }],
          }),
    );
    r.watches.add("zz");
    r.sent.state?.(stoppedRun);
    await vi.waitFor(() => {
      expect(r.watches.getState().entries[0]?.error).toContain("zz");
    });
  });
});

describe("the debug console", () => {
  it("shows program output, evaluates when paused and refuses (with the reason) when not", async () => {
    const r = await rig();
    await r.debug.start();
    r.sent.event?.({ name: "output", body: { category: "stdout", output: "hello\n" } });
    r.sent.event?.({ name: "output", body: { category: "stderr", output: "oops\n" } });
    r.sent.event?.({ name: "output", body: { category: "telemetry", output: "x" } });
    const kinds = r.console.getState().lines.map((line) => [line.kind, line.text]);
    expect(kinds).toContainEqual(["stdout", "hello"]);
    expect(kinds).toContainEqual(["stderr", "oops"]);
    expect(kinds.some(([, text]) => text === "x")).toBe(false);

    r.sent.state?.(run("running"));
    expect(await r.console.evaluate("1 + 1")).toBe(false);
    expect(r.console.getState().lines.at(-1)).toMatchObject({
      kind: "error",
      text: "Expressions can only be evaluated while the program is paused at a breakpoint.",
    });

    r.sent.state?.(stoppedRun);
    await vi.waitFor(() => {
      expect(r.callStack.selected()).not.toBeNull();
    });
    expect(await r.console.evaluate("name")).toBe(true);
    expect(r.console.getState().lines.at(-1)).toEqual(
      expect.objectContaining({ kind: "result", text: "<name>" }),
    );
    r.console.clear();
    expect(r.console.getState().lines).toEqual([]);
  });

  it("an evaluate the adapter rejects prints its message", async () => {
    const r = await rig();
    await r.debug.start();
    r.sent.state?.(stoppedRun);
    vi.mocked(r.ipc.debugRequest).mockRejectedValueOnce(new Error("NameError: zz"));
    expect(await r.console.evaluate("zz")).toBe(false);
    expect(r.console.getState().lines.at(-1)).toMatchObject({
      kind: "error",
      text: "NameError: zz",
    });
  });

  it("the program's exit and the end of the session are said in the console", async () => {
    const r = await rig();
    await r.debug.start();
    r.sent.event?.({ name: "exited", body: { exitCode: 3 } });
    r.sent.state?.(run("terminated"));
    const texts = r.console.getState().lines.map((line) => line.text);
    expect(texts).toContain("The program exited with code 3.");
    expect(texts).toContain("The debug session ended.");
    r.sent.state?.(
      run("terminated", { runId: 2, error: "The debug adapter stopped unexpectedly." }),
    );
  });
});

describe("the controls and the commands", () => {
  it("continue and the steps go to the backend only while paused", async () => {
    const r = await rig();
    await r.debug.start();
    expect(await r.debug.control("stepOver")).toBe(false);
    r.sent.state?.(stoppedRun);
    expect(await r.debug.control("stepOver")).toBe(true);
    expect(r.ipc.debugControl).toHaveBeenLastCalledWith("stepOver");
    r.sent.state?.(run("running"));
    expect(await r.debug.control("pause")).toBe(true);
    expect(r.ipc.debugControl).toHaveBeenLastCalledWith("pause");
  });

  it("F5 is Start Debugging (Continue once paused); Ctrl+F5 stays Run Code; the step keys are bound", async () => {
    const key = (chord: string) =>
      DEFAULT_KEYBINDINGS.filter((binding) => binding.key === chord).map(
        (binding) => binding.command,
      );
    expect(key("F5")).toEqual(["debug.start"]);
    expect(key("Ctrl+F5")).toEqual(["run.code"]);
    expect(key("Shift+F5")).toEqual(["debug.stop"]);
    expect(key("F9")).toEqual(["debug.toggleBreakpoint"]);
    expect(key("F10")).toEqual(["debug.stepOver"]);
    expect(key("F11")).toContain("debug.stepInto");
    expect(key("Shift+F11")).toEqual(["debug.stepOut"]);

    const r = await rig();
    expect(r.commands.isEnabled("debug.start")).toBe(true);
    await r.commands.execute("debug.start");
    expect(r.ipc.debugStart).toHaveBeenCalledTimes(1);
    r.sent.state?.(stoppedRun);
    expect(r.commands.isEnabled("debug.start")).toBe(true);
    await r.commands.execute("debug.start");
    expect(r.ipc.debugControl).toHaveBeenCalledWith("continue");
    expect(r.ipc.debugStart).toHaveBeenCalledTimes(1);
  });

  it("commands are disabled with a reason until they can run", async () => {
    const r = await rig();
    for (const id of [
      "debug.stop",
      "debug.restart",
      "debug.continue",
      "debug.stepOver",
      "debug.stepInto",
      "debug.stepOut",
      "debug.pause",
    ]) {
      expect(r.commands.isEnabled(id)).toBe(false);
      expect(r.commands.reasonFor(id)).toBeTruthy();
    }
    expect(r.commands.reasonFor("debug.stepOver")).toBe("There is no debug session.");
    r.file.current = { path: "C:/My Site/notes.txt", docId: "d" };
    expect(r.commands.isEnabled("debug.start")).toBe(false);
    expect(r.commands.reasonFor("debug.start")).toBe(
      "No debugger is available for this file type.",
    );
    expect(r.commands.reasonFor("debug.enableAllBreakpoints")).toBe("There are no breakpoints.");
  });

  it("Toggle Breakpoint uses the cursor line of the file in front; the breakpoint commands work on all", async () => {
    const r = await rig();
    await r.commands.execute("debug.toggleBreakpoint");
    expect(r.breakpoints.at(FILE, 4)).toBeDefined();
    await r.commands.execute("debug.disableAllBreakpoints");
    expect(r.breakpoints.activeRows()).toEqual([]);
    await r.commands.execute("debug.enableAllBreakpoints");
    expect(r.breakpoints.activeRows()).toHaveLength(1);
    await r.commands.execute("debug.removeAllBreakpoints");
    expect(r.breakpoints.getState().breakpoints).toEqual([]);
    r.file.current = null;
    expect(r.commands.isEnabled("debug.toggleBreakpoint")).toBe(false);
  });

  it("Stop ends the session; Restart stops it and starts the same configuration again", async () => {
    const r = await rig();
    await r.debug.start();
    vi.mocked(r.ipc.debugStop).mockImplementation(() => {
      r.sent.state?.(run("terminated"));
      return Promise.resolve();
    });
    const restarted = r.debug.restart();
    await restarted;
    expect(r.ipc.debugStop).toHaveBeenCalledTimes(1);
    expect(r.ipc.debugStart).toHaveBeenCalledTimes(2);
    expect(vi.mocked(r.ipc.debugStart).mock.calls[1]?.[0].name).toBe("Python: Current File");
    await r.commands.execute("debug.stop");
    expect(r.ipc.debugStop).toHaveBeenCalledTimes(2);
    await settle();
  });

  it("Install Additional Debuggers opens the Runtime Manager", async () => {
    const r = await rig();
    const opened = vi.fn();
    r.events.on("showRuntimeManager", opened);
    await r.commands.execute("debug.installDebuggers");
    expect(opened).toHaveBeenCalled();
  });

  it("Refresh asks the backend for the folder's debug readiness", async () => {
    const r = await rig();
    const before = vi.mocked(r.ipc.debugStatus).mock.calls.length;
    await r.debug.refreshStatus();
    expect(vi.mocked(r.ipc.debugStatus).mock.calls.length).toBe(before + 1);
  });
});
