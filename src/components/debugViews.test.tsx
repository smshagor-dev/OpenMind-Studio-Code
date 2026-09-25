import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Breakpoint } from "../services/breakpointService";
import { breakpointDecorations, currentLineDecoration } from "../services/debugEditorBinding";
import { controlAvailability, startAvailability, type DebugFrame } from "../services/debugModel";
import type { ConsoleLine } from "../services/debugConsoleService";
import type { DebugRun, DebugStatus } from "../services/ipc";
import type { ScopeNode } from "../services/variablesService";

const harness = vi.hoisted((): { current: unknown } => ({ current: null }));

vi.mock("../services/container", () => ({
  get container() {
    return harness.current;
  },
}));

import { BreakpointsPane, CallStackPane, VariablesPane, WatchPane } from "./DebugPanes";
import { DebugConsoleView } from "./DebugConsoleView";
import { DebugStatusItem } from "./DebugStatusItem";
import { DebugToolbar } from "./DebugToolbar";
import { RunDebugView } from "./RunDebugView";

const nullState = { run: null };
const stoppedState = { run: null as DebugRun | null };
const endedState = { run: null as DebugRun | null };
const noop = () => () => undefined;
const store = <T,>(state: T) => ({ subscribe: noop, getState: () => state });

const run = (state: DebugRun["state"], patch: Partial<DebugRun> = {}): DebugRun => ({
  runId: 1,
  configName: "Python: Current File",
  target: "python",
  state,
  program: "C:/My Site/tool.py",
  pid: 1,
  ...patch,
});

stoppedState.run = run("stopped");
endedState.run = run("terminated");

const status = (patch: Partial<DebugStatus> = {}): DebugStatus => ({
  workspace: "C:/My Site",
  run: null,
  python: {
    target: "python",
    ready: true,
    problem: null,
    interpreter: "OpenMind portable Python",
    installKind: null,
  },
  node: {
    target: "node",
    ready: true,
    problem: null,
    interpreter: "OpenMind portable Node.js",
    installKind: null,
  },
  php: {
    target: "php",
    ready: false,
    problem: "PHP debugging requires Xdebug and is not available yet.",
    interpreter: null,
    installKind: null,
  },
  ...patch,
});

interface ViewRig {
  path: string | null;
  status: DebugStatus | null;
  run: DebugRun | null;
}

function setViewContainer(input: ViewRig) {
  const start = vi.fn();
  const install = vi.fn();
  const runCommand = vi.fn();
  const workspaceState = { activeId: input.path === null ? null : "doc" };
  const debugState = { status: input.status, run: input.run };
  const debug = {
    subscribe: noop,
    getState: () => debugState,
    isDebugging: () => input.run !== null && input.run.state !== "terminated",
    startState: () => startAvailability({ path: input.path, status: input.status, run: input.run }),
    start,
  };
  harness.current = {
    keybindings: { labelFor: () => undefined },
    debug,
    debugConfigs: {
      configsFor: (path: string | null) =>
        path?.endsWith(".py") ? [{ name: "Python: Current File" }] : [],
      choose: vi.fn(),
    },
    workspace: {
      subscribe: noop,
      getState: () => workspaceState,
      getActiveWorkspace: () => ({ path: "C:/My Site" }),
    },
    documents: { has: () => input.path !== null, snapshot: () => ({ path: input.path }) },
    commands: { isEnabled: () => true, reasonFor: () => undefined },
    run: runCommand,
    runtime: { install },
    variables: store({ scopes: [] }),
    watches: store({ entries: [] }),
    callStack: store({ frames: [], selectedId: null }),
    breakpoints: store({ breakpoints: [] }),
  };
  return { start, install, runCommand };
}

describe("Run and Debug view states", () => {
  beforeEach(() => {
    harness.current = null;
  });

  it("no file or folder: says to open one and Start is disabled", () => {
    setViewContainer({ path: null, status: status(), run: null });
    render(<RunDebugView />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Open a file or folder to start debugging.",
    );
    expect(screen.getByRole("button", { name: /Start Debugging/ })).toBeDisabled();
  });

  it("an unsupported file says there is no debugger", () => {
    setViewContainer({ path: "C:/My Site/notes.txt", status: status(), run: null });
    render(<RunDebugView />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "No debugger is available for this file type.",
    );
    expect(screen.getByRole("button", { name: /Start Debugging/ })).toBeDisabled();
  });

  it("a missing runtime says so and offers no install", () => {
    setViewContainer({
      path: "C:/My Site/tool.py",
      status: status({
        python: {
          target: "python",
          ready: false,
          problem: "Python runtime is not installed yet.",
          interpreter: null,
          installKind: null,
        },
      }),
      run: null,
    });
    render(<RunDebugView />);
    expect(screen.getByRole("status")).toHaveTextContent("Python runtime is not installed yet.");
    expect(screen.queryByRole("button", { name: "Install Debugger" })).toBeNull();
  });

  it("a missing debugger says so and Install Debugger installs the right runtime kind", () => {
    const { install } = setViewContainer({
      path: "C:/My Site/tool.py",
      status: status({
        python: {
          target: "python",
          ready: false,
          problem: "Python debugger is not installed yet.",
          interpreter: "OpenMind portable Python",
          installKind: "debugpy",
        },
      }),
      run: null,
    });
    render(<RunDebugView />);
    expect(screen.getByRole("status")).toHaveTextContent("Python debugger is not installed yet.");
    fireEvent.click(screen.getByRole("button", { name: "Install Debugger" }));
    expect(install).toHaveBeenCalledWith("debugpy", null);
  });

  it("PHP is never offered a debugger", () => {
    setViewContainer({ path: "C:/My Site/index.php", status: status(), run: null });
    render(<RunDebugView />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "PHP debugging requires Xdebug and is not available yet.",
    );
    expect(screen.queryByRole("button", { name: "Install Debugger" })).toBeNull();
  });

  it("ready: Start Debugging starts, Run Without Debugging runs the code, and the configuration is listed", () => {
    const { start, runCommand } = setViewContainer({
      path: "C:/My Site/tool.py",
      status: status(),
      run: null,
    });
    render(<RunDebugView />);
    expect(screen.getByRole("combobox", { name: "Launch configuration" })).toHaveTextContent(
      "Python: Current File",
    );
    fireEvent.click(screen.getByRole("button", { name: /Start Debugging/ }));
    expect(start).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Run Without Debugging" }));
    expect(runCommand).toHaveBeenCalledWith("debug.runWithoutDebugging");
  });

  it("while debugging the view shows the session instead of the start buttons", () => {
    setViewContainer({ path: "C:/My Site/tool.py", status: status(), run: run("running") });
    render(<RunDebugView />);
    expect(screen.getByRole("status")).toHaveTextContent("Python: Current File — Running");
    expect(screen.queryByRole("button", { name: /Start Debugging/ })).toBeNull();
  });
});

describe("debug toolbar", () => {
  function toolbar(current: DebugRun | null) {
    const runCommand = vi.fn();
    const currentState = { run: current };
    harness.current = {
    keybindings: { labelFor: () => undefined },
      run: runCommand,
      debug: {
        subscribe: noop,
        getState: () => currentState,
        isDebugging: () => current !== null && current.state !== "terminated",
        controlState: (control: Parameters<typeof controlAvailability>[0]) =>
          controlAvailability(control, current),
      },
    };
    return runCommand;
  }

  it("is hidden without a session", () => {
    toolbar(null);
    const { container } = render(<DebugToolbar />);
    expect(container).toBeEmptyDOMElement();
  });

  it("running: only Pause, Restart and Stop are enabled", () => {
    toolbar(run("running"));
    render(<DebugToolbar />);
    const enabled = (name: string) =>
      screen.getByRole("button", { name }).matches(":not(:disabled)");
    expect(enabled("Pause")).toBe(true);
    expect(enabled("Restart")).toBe(true);
    expect(enabled("Stop")).toBe(true);
    for (const name of ["Continue", "Step Over", "Step Into", "Step Out"])
      expect(enabled(name)).toBe(false);
    expect(screen.getByRole("button", { name: "Step Over" })).toHaveAttribute(
      "title",
      expect.stringContaining("The program isn't paused."),
    );
  });

  it("paused: Continue and the steps are enabled and run their commands", () => {
    const runCommand = toolbar(
      run("stopped", {
        stopped: {
          reason: "breakpoint",
          threadId: 1,
          description: null,
          text: null,
          allThreadsStopped: true,
        },
      }),
    );
    render(<DebugToolbar />);
    expect(screen.getByRole("button", { name: "Pause" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(runCommand).toHaveBeenLastCalledWith("debug.continue");
    fireEvent.click(screen.getByRole("button", { name: "Step Over" }));
    expect(runCommand).toHaveBeenLastCalledWith("debug.stepOver");
    fireEvent.click(screen.getByRole("button", { name: "Step Into" }));
    expect(runCommand).toHaveBeenLastCalledWith("debug.stepInto");
    fireEvent.click(screen.getByRole("button", { name: "Step Out" }));
    expect(runCommand).toHaveBeenLastCalledWith("debug.stepOut");
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(runCommand).toHaveBeenLastCalledWith("debug.stop");
  });
});

describe("status bar item", () => {
  it("shows the state while a session exists and nothing otherwise", () => {
    harness.current = {
      run: vi.fn(),
      debug: { subscribe: noop, getState: () => stoppedState },
    };
    const { unmount } = render(<DebugStatusItem />);
    expect(screen.getByRole("button")).toHaveTextContent("Paused");
    unmount();
    harness.current = {
      run: vi.fn(),
      debug: { subscribe: noop, getState: () => endedState },
    };
    const ended = render(<DebugStatusItem />);
    expect(ended.container).toBeEmptyDOMElement();
  });
});

describe("variables, call stack, watch and breakpoints panes", () => {
  it("variables: an empty state, scopes with values, and expanding a variable", () => {
    const toggleVariable = vi.fn();
    const scopes: ScopeNode[] = [
      {
        key: "s0",
        scope: { name: "Locals", variablesReference: 1, expensive: false },
        expanded: true,
        loading: false,
        variables: [
          {
            key: "s0/0",
            variable: {
              name: "name",
              value: "'x'",
              type: "str",
              variablesReference: 0,
              evaluateName: null,
            },
            expanded: false,
            loading: false,
            children: null,
          },
          {
            key: "s0/1",
            variable: {
              name: "items",
              value: "list",
              type: null,
              variablesReference: 9,
              evaluateName: null,
            },
            expanded: false,
            loading: false,
            children: null,
          },
        ],
      },
      {
        key: "s1",
        scope: { name: "Globals", variablesReference: 2, expensive: true },
        expanded: false,
        loading: false,
        variables: null,
      },
    ];
    harness.current = { variables: { ...store({ scopes }), toggleVariable, toggleScope: vi.fn() } };
    const { unmount } = render(<VariablesPane />);
    const list = within(screen.getByRole("list", { name: "Variables" }));
    expect(list.getByText("Locals", { exact: false })).toBeInTheDocument();
    expect(list.getByText("name")).toBeInTheDocument();
    expect(list.getByText("'x'")).toBeInTheDocument();
    expect(list.getByText("Globals", { exact: false })).toBeInTheDocument();
    fireEvent.click(list.getByRole("button", { name: "Expand items" }));
    expect(toggleVariable).toHaveBeenCalledWith("s0/1");
    unmount();

    harness.current = { variables: store({ scopes: [] }) };
    render(<VariablesPane />);
    expect(screen.getByText("Variables appear when the program is paused.")).toBeInTheDocument();
  });

  it("call stack: frames are listed, runtime frames have no file, a click selects the frame", () => {
    const select = vi.fn();
    const frames: DebugFrame[] = [
      { id: 1, name: "greet", line: 2, column: 1, path: "C:/My Site/tool.py", hint: null },
      { id: 2, name: "<anonymous>", line: 1854, column: 1, path: null, hint: "deemphasize" },
    ];
    harness.current = { callStack: { ...store({ frames, selectedId: 1 }), select } };
    render(<CallStackPane />);
    expect(screen.getByText("tool.py:2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /greet/ }));
    expect(select).toHaveBeenCalledWith(frames[0]);
    expect(screen.getByTitle("Runtime internals have no file to open.")).toBeInTheDocument();
  });

  it("call stack: empty state", () => {
    harness.current = {
      callStack: { ...store({ frames: [], selectedId: null }), select: vi.fn() },
    };
    render(<CallStackPane />);
    expect(
      screen.getByText("The call stack appears when the program is paused."),
    ).toBeInTheDocument();
  });

  it("watch: entries with values, errors and 'not available'; add and remove", () => {
    const add = vi.fn();
    const remove = vi.fn();
    harness.current = {
      watches: {
        ...store({
          entries: [
            { id: 1, expression: "a + b", value: "3", error: null },
            { id: 2, expression: "zz", value: null, error: "NameError" },
            { id: 3, expression: "later", value: null, error: null },
          ],
        }),
        add,
        remove,
      },
    };
    render(<WatchPane />);
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("NameError")).toBeInTheDocument();
    expect(screen.getByText("not available")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove watch a + b" }));
    expect(remove).toHaveBeenCalledWith(1);
    fireEvent.change(screen.getByRole("textbox", { name: "Add watch expression" }), {
      target: { value: "x * 2" },
    });
    fireEvent.submit(
      screen
        .getByRole("textbox", { name: "Add watch expression" })
        .closest("form") as HTMLFormElement,
    );
    expect(add).toHaveBeenCalledWith("x * 2");
  });

  it("breakpoints: listed per file, stale ones marked, enable/remove/clear work", () => {
    const setEnabled = vi.fn();
    const remove = vi.fn();
    const removeAll = vi.fn();
    const list: Breakpoint[] = [
      { id: "bp-1", path: "C:/My Site/tool.py", line: 4, enabled: true, stale: false },
      { id: "bp-2", path: "C:/My Site/gone.py", line: 9, enabled: true, stale: true },
    ];
    harness.current = {
      workspace: { openPathAt: vi.fn() },
      breakpoints: {
        ...store({ breakpoints: list }),
        setEnabled,
        remove,
        removeAll,
        setAllEnabled: vi.fn(),
      },
    };
    render(<BreakpointsPane />);
    expect(screen.getByText("tool.py")).toBeInTheDocument();
    expect(screen.getByText("(file missing)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Enable breakpoint tool.py:4" }));
    expect(setEnabled).toHaveBeenCalledWith("bp-1", false);
    expect(screen.getByRole("checkbox", { name: "Enable breakpoint gone.py:9" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Remove breakpoint tool.py:4" }));
    expect(remove).toHaveBeenCalledWith("bp-1");
    fireEvent.click(screen.getByRole("button", { name: "Remove All" }));
    expect(removeAll).toHaveBeenCalled();
  });

  it("breakpoints: empty state explains the gutter", () => {
    harness.current = { breakpoints: store({ breakpoints: [] }) };
    render(<BreakpointsPane />);
    expect(screen.getByText(/Click the gutter/)).toBeInTheDocument();
  });
});

describe("debug console", () => {
  function consoleRig(lines: ConsoleLine[], unavailable: string | null) {
    const evaluate = vi.fn().mockResolvedValue(true);
    const clear = vi.fn();
    harness.current = {
    keybindings: { labelFor: () => undefined },
      debugConsole: { ...store({ lines }), evaluate, clear },
      debug: {
        subscribe: noop,
        getState: () => nullState,
        evaluateUnavailable: () => unavailable,
      },
    };
    return { evaluate, clear };
  }

  it("shows the program's output and adapter messages with their kinds", () => {
    consoleRig(
      [
        { id: 1, kind: "system", text: "Starting Python: Current File…" },
        { id: 2, kind: "stdout", text: "result hi" },
        { id: 3, kind: "stderr", text: "warning!" },
      ],
      null,
    );
    render(<DebugConsoleView />);
    const output = within(screen.getByLabelText("Debug Console output"));
    expect(output.getByText("result hi")).toHaveClass("debug-console__line--stdout");
    expect(output.getByText("warning!")).toHaveClass("debug-console__line--stderr");
    expect(output.getByText("Starting Python: Current File…")).toBeInTheDocument();
  });

  it("an empty console explains itself; evaluate submits and Clear clears", () => {
    const { evaluate } = consoleRig([], null);
    const { unmount } = render(<DebugConsoleView />);
    expect(screen.getByText(/output and debugger messages appear here/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear Console" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Evaluate expression" }), {
      target: { value: "1 + 1" },
    });
    fireEvent.submit(
      screen
        .getByRole("textbox", { name: "Evaluate expression" })
        .closest("form") as HTMLFormElement,
    );
    expect(evaluate).toHaveBeenCalledWith("1 + 1");
    unmount();
    const second = consoleRig([{ id: 1, kind: "stdout", text: "x" }], null);
    render(<DebugConsoleView />);
    fireEvent.click(screen.getByRole("button", { name: "Clear Console" }));
    expect(second.clear).toHaveBeenCalled();
  });

  it("when nothing can be evaluated the prompt says why", () => {
    consoleRig(
      [],
      "Expressions can only be evaluated while the program is paused at a breakpoint.",
    );
    render(<DebugConsoleView />);
    expect(screen.getByRole("textbox", { name: "Evaluate expression" })).toHaveAttribute(
      "placeholder",
      "Expressions can only be evaluated while the program is paused at a breakpoint.",
    );
  });
});

describe("breakpoint gutter model", () => {
  const bp = (line: number, patch: Partial<Breakpoint> = {}): Breakpoint => ({
    id: `bp-${String(line)}`,
    path: "C:/My Site/tool.py",
    line,
    enabled: true,
    stale: false,
    ...patch,
  });

  it("each breakpoint is a glyph on its line: enabled, disabled or stale", () => {
    const decorations = breakpointDecorations([
      bp(3),
      bp(8, { enabled: false }),
      bp(12, { stale: true }),
    ]);
    expect(decorations.map((d) => d.range.startLineNumber)).toEqual([3, 8, 12]);
    expect(decorations.map((d) => d.options.glyphMarginClassName)).toEqual([
      "debug-bp debug-bp--on",
      "debug-bp debug-bp--off",
      "debug-bp debug-bp--stale",
    ]);
    expect(decorations[2]?.options.glyphMarginHoverMessage).toEqual({
      value: "Breakpoint ignored: its file no longer exists.",
    });
    expect(breakpointDecorations([])).toEqual([]);
  });

  it("the paused line is a whole-line highlight with an arrow", () => {
    const decoration = currentLineDecoration({ path: "C:/My Site/tool.py", line: 5, column: 1 });
    expect(decoration.range.startLineNumber).toBe(5);
    expect(decoration.options.isWholeLine).toBe(true);
    expect(decoration.options.className).toBe("debug-current-line");
    expect(decoration.options.glyphMarginClassName).toBe("debug-current-glyph");
  });
});
