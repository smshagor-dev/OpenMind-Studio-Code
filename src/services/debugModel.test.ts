import { describe, expect, it } from "vitest";

import {
  consoleLineFromOutput,
  controlAvailability,
  debugTargetOf,
  defaultConfigs,
  parseEvaluate,
  parseFrames,
  parseScopes,
  parseVariables,
  runSummary,
  startAvailability,
} from "./debugModel";
import type { DebugReadiness, DebugRun, DebugStatus } from "./ipc";

const ready = (target: DebugReadiness["target"]): DebugReadiness => ({
  target,
  ready: true,
  problem: null,
  interpreter: `OpenMind portable ${target}`,
  installKind: null,
});

function status(patch: Partial<DebugStatus> = {}): DebugStatus {
  return {
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
    ...patch,
  };
}

function run(state: DebugRun["state"], patch: Partial<DebugRun> = {}): DebugRun {
  return {
    runId: 1,
    configName: "Python: Current File",
    target: "python",
    state,
    program: "C:/My Site/tool.py",
    pid: 10,
    ...patch,
  };
}

describe("what can be debugged", () => {
  it("files map to a target; TypeScript and plain text have none", () => {
    expect(debugTargetOf("C:/My Site/tool.py")).toBe("python");
    expect(debugTargetOf("run.PYW")).toBe("python");
    expect(debugTargetOf("app.js")).toBe("node");
    expect(debugTargetOf("server.mjs")).toBe("node");
    expect(debugTargetOf("index.php")).toBe("php");
    expect(debugTargetOf("app.ts")).toBeNull();
    expect(debugTargetOf("notes.txt")).toBeNull();
    expect(debugTargetOf("Makefile")).toBeNull();
  });

  it("the default configuration runs the current file in the workspace, or the file's folder without one", () => {
    const [config] = defaultConfigs("C:/My Site/src/tool.py", "C:/My Site");
    expect(config).toMatchObject({
      name: "Python: Current File",
      target: "python",
      program: "C:/My Site/src/tool.py",
      cwd: "C:/My Site",
      stopOnEntry: false,
    });
    expect(defaultConfigs("C:/My Site/src/app.js", null)[0]?.cwd).toBe("C:/My Site/src");
    expect(defaultConfigs("C:/My Site/src/app.js", null)[0]?.name).toBe("Node.js: Current File");
    expect(defaultConfigs("notes.txt", null)).toEqual([]);
  });
});

describe("the Run and Debug states", () => {
  const start = (
    path: string | null,
    s: DebugStatus | null = status(),
    r: DebugRun | null = null,
  ) => startAvailability({ path, status: s, run: r });

  it("no file: open a file or folder", () => {
    expect(start(null)).toEqual({
      enabled: false,
      reason: "Open a file or folder to start debugging.",
    });
  });

  it("an unsupported file type says there is no debugger", () => {
    expect(start("C:/My Site/notes.txt").reason).toBe(
      "No debugger is available for this file type.",
    );
    expect(start("C:/My Site/app.ts").reason).toBe("No debugger is available for this file type.");
  });

  it("a missing runtime is the runtime's own message and offers no install", () => {
    const missing = status({
      python: {
        ...ready("python"),
        ready: false,
        problem: "Python runtime is not installed yet.",
        interpreter: null,
      },
    });
    expect(start("C:/My Site/tool.py", missing)).toEqual({
      enabled: false,
      reason: "Python runtime is not installed yet.",
      target: "python",
    });
    const node = status({
      node: {
        ...ready("node"),
        ready: false,
        problem: "Node.js runtime is not installed yet.",
        interpreter: null,
      },
    });
    expect(start("C:/My Site/app.js", node).reason).toBe("Node.js runtime is not installed yet.");
  });

  it("a missing debugger offers Install Debugger for the right runtime kind", () => {
    const python = status({
      python: {
        ...ready("python"),
        ready: false,
        problem: "Python debugger is not installed yet.",
        installKind: "debugpy",
      },
      node: {
        ...ready("node"),
        ready: false,
        problem: "Node.js debugger is not installed yet.",
        installKind: "js-debug",
      },
    });
    expect(start("C:/My Site/tool.py", python)).toMatchObject({
      enabled: false,
      reason: "Python debugger is not installed yet.",
      installKind: "debugpy",
    });
    expect(start("C:/My Site/app.js", python)).toMatchObject({
      reason: "Node.js debugger is not installed yet.",
      installKind: "js-debug",
    });
  });

  it("PHP is never faked", () => {
    expect(start("C:/My Site/index.php")).toMatchObject({
      enabled: false,
      reason: "PHP debugging requires Xdebug and is not available yet.",
    });
  });

  it("a ready target can start; a running session blocks a second one", () => {
    expect(start("C:/My Site/tool.py")).toEqual({ enabled: true, target: "python" });
    expect(start("C:/My Site/tool.py", status(), run("running")).reason).toBe(
      "A debug session is already running.",
    );
    // An ended session doesn't.
    expect(start("C:/My Site/tool.py", status(), run("terminated")).enabled).toBe(true);
    expect(start("C:/My Site/tool.py", null).reason).toBe("Checking for debuggers…");
  });
});

describe("controls follow the run state", () => {
  it("continue and the steps need a paused program; pause needs a running one; stop and restart need a session", () => {
    const states = {
      none: null,
      starting: run("starting"),
      running: run("running"),
      stopped: run("stopped", {
        stopped: {
          reason: "breakpoint",
          threadId: 1,
          description: null,
          text: null,
          allThreadsStopped: true,
        },
      }),
      ended: run("terminated"),
    };
    const on = (control: Parameters<typeof controlAvailability>[0], key: keyof typeof states) =>
      controlAvailability(control, states[key]).enabled;

    for (const control of ["continue", "stepOver", "stepInto", "stepOut"] as const) {
      expect(on(control, "stopped")).toBe(true);
      expect(on(control, "running")).toBe(false);
      expect(on(control, "none")).toBe(false);
      expect(on(control, "ended")).toBe(false);
    }
    expect(on("pause", "running")).toBe(true);
    expect(on("pause", "stopped")).toBe(false);
    for (const key of ["starting", "running", "stopped"] as const) {
      expect(on("stop", key)).toBe(true);
      expect(on("restart", key)).toBe(true);
    }
    expect(on("stop", "none")).toBe(false);
    expect(controlAvailability("stepOver", states.running).reason).toBe(
      "The program isn't paused.",
    );
    expect(controlAvailability("stop", null).reason).toBe("There is no debug session.");
  });

  it("the summary reads the state", () => {
    expect(runSummary(null)).toBe("");
    expect(runSummary(run("starting"))).toBe("Starting…");
    expect(runSummary(run("running"))).toBe("Running");
    expect(
      runSummary(
        run("stopped", {
          stopped: {
            reason: "breakpoint",
            threadId: 1,
            description: "Paused on breakpoint",
            text: null,
            allThreadsStopped: true,
          },
        }),
      ),
    ).toBe("Paused on breakpoint");
    expect(runSummary(run("terminated", { error: "boom" }))).toBe("Ended with an error");
  });
});

describe("parsing what the adapter answers", () => {
  it("a stack trace keeps files and drops runtime internals as paths", () => {
    const frames = parseFrames({
      stackFrames: [
        { id: 7, name: "greet", line: 2, column: 5, source: { path: "C:\\My Site\\t.py" } },
        {
          id: 8,
          name: "<anonymous>",
          line: 1854,
          column: 1,
          source: { path: "<node_internals>/loader", presentationHint: "deemphasize" },
        },
        { name: "no id" },
      ],
    });
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ id: 7, line: 2, path: "C:\\My Site\\t.py" });
    expect(frames[1]).toMatchObject({ path: null, hint: "deemphasize" });
    expect(parseFrames(null)).toEqual([]);
  });

  it("scopes, variables and evaluate results", () => {
    expect(
      parseScopes({
        scopes: [
          { name: "Locals", variablesReference: 3 },
          { name: "Globals", variablesReference: 4, expensive: true },
          { variablesReference: 5 },
        ],
      }),
    ).toEqual([
      { name: "Locals", variablesReference: 3, expensive: false },
      { name: "Globals", variablesReference: 4, expensive: true },
    ]);
    const variables = parseVariables({
      variables: [
        { name: "name", value: "'x'", type: "str", variablesReference: 0 },
        { name: "items", value: "list", variablesReference: 12, evaluateName: "items" },
        { value: "nameless" },
      ],
    });
    expect(variables).toHaveLength(2);
    expect(variables[1]).toMatchObject({ variablesReference: 12, evaluateName: "items" });
    expect(parseEvaluate({ result: "3", type: "number" })).toEqual({
      result: "3",
      type: "number",
      variablesReference: 0,
    });
    expect(parseEvaluate(null).result).toBe("");
  });

  it("output events become console lines; telemetry and empty ones don't", () => {
    expect(consoleLineFromOutput({ category: "stdout", output: "hi\n" })).toEqual({
      kind: "stdout",
      text: "hi",
    });
    expect(consoleLineFromOutput({ category: "stderr", output: "bad\r\n" })).toEqual({
      kind: "stderr",
      text: "bad",
    });
    expect(consoleLineFromOutput({ output: "x" })?.kind).toBe("console");
    expect(consoleLineFromOutput({ category: "telemetry", output: "x" })).toBeNull();
    expect(consoleLineFromOutput({ category: "stdout", output: "" })).toBeNull();
  });
});
