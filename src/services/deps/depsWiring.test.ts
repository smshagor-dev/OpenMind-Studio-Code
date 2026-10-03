import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import { OutputService } from "../outputService";
import type { TerminalService } from "../terminalService";
import type { DepsIpc } from "./depsIpc";
import { promptFolder, readPrompt, wireDeps } from "./depsWiring";

function rig() {
  const listeners = new Set<() => void>();
  const createTaskTerminal = vi.fn(async (_title: string, start: (cols: number, rows: number) => Promise<unknown>) => {
    await start(80, 24);
    return "t9";
  });
  const waitForExit = vi.fn().mockResolvedValue(0);
  const taps = new Map<string, (data: Uint8Array) => void>();
  let sessions: { id: string; shell: string; cwd: string; exited: boolean }[] = [];
  const terminal = {
    getState: () => ({ sessions, shells: [{ kind: "powerShell", label: "PowerShell", available: true }], lastShell: "powerShell", activeId: null }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onOutput: (id: string, listener: (data: Uint8Array) => void) => {
      taps.set(id, listener);
      return () => taps.delete(id);
    },
    createTaskTerminal,
    waitForExit,
  } as unknown as TerminalService;
  const ipc: DepsIpc = {
    depsPlan: vi.fn(),
    depsRun: vi.fn().mockResolvedValue({ id: "t9", shell: "powerShell", cwd: "E:\\p", pid: 1 }),
    depsProjectInfo: vi.fn().mockResolvedValue({ pythonProject: "E:\\p", requirementsTxt: null, pyprojectToml: null, pythonTarget: "openmindPython", nodeProject: "E:\\p", packageJson: null }),
  };
  const output = new OutputService();
  const deps = wireDeps({
    events: new EventBus<AppEvents>(),
    output,
    terminal,
    confirm: vi.fn().mockResolvedValue("Install"),
    openFile: vi.fn(),
    run: vi.fn(),
    activeFilePath: () => "E:\\p\\main.py",
    workspaceRoot: () => "E:\\p",
    ipc,
  });
  return {
    deps: deps.helper,
    wiring: deps,
    ipc,
    output,
    createTaskTerminal,
    waitForExit,
    addTerminal: (id: string, cwd: string) => {
      sessions = [...sessions, { id, shell: "powerShell", cwd, exited: false }];
      for (const listener of listeners) listener();
    },
    print: (id: string, text: string) => taps.get(id)?.(new TextEncoder().encode(text)),
  };
}

describe("wireDeps", () => {
  it("a terminal line split across chunks is still recognized, with the terminal's folder", () => {
    const r = rig();
    r.addTerminal("t1", "E:\\My Work\\api");
    r.print("t1", "Traceback (most recent call last):\r\n  File \"app.py\", line 1\r\nModuleNotFound");
    expect(r.deps.getState().issue).toBeNull();
    r.print("t1", "\u001b[31mError: No module named 'requests'\u001b[0m\r\n");
    expect(r.deps.getState()).toMatchObject({
      issue: { kind: "pythonPackage", package: "requests" },
      base: "E:\\My Work\\api",
      fromRunCode: false,
    });
    expect(r.ipc.depsProjectInfo).toHaveBeenCalledWith("E:\\My Work\\api");
  });

  it("follows the shell's current folder through its prompt (a cd after the terminal started)", () => {
    const r = rig();
    r.addTerminal("t1", "E:\\smoke\\python-console");
    r.print("t1", "PS E:\\smoke\\python-console> cd ..\\node-console\r\n");
    r.print("t1", "PS E:\\smoke\\node-console> node needs_left_pad.js\r\n");
    r.print("t1", "Error: Cannot find module 'left-pad'\r\n");
    expect(r.deps.getState()).toMatchObject({
      issue: { kind: "nodePackage", package: "left-pad" },
      base: "E:\\smoke\\node-console",
    });
  });

  it("reads PowerShell and cmd prompts, with spaces, and nothing else", () => {
    expect(promptFolder("PS E:\\My Work\\api> python app.py")).toBe("E:\\My Work\\api");
    expect(promptFolder("PS C:\\> ")).toBe("C:\\");
    expect(promptFolder("E:\\My Work\\cmd dir>node x.js")).toBe("E:\\My Work\\cmd dir");
    expect(promptFolder("E:\\x>")).toBe("E:\\x");
    for (const line of ["Hello > world", "Status: Adult", "  File \"E:\\x.py\", line 1", "PS> echo", "a => b"]) {
      expect(promptFolder(line), line).toBeNull();
    }
  });

  it("reads Git Bash and WSL prompts; a folder outside the Windows drives is unknown, not guessed", () => {
    expect(readPrompt("smsha@PC MINGW64 /e/My Work/node app (main)")).toEqual({ folder: "E:\\My Work\\node app" });
    expect(readPrompt("smsha@PC MINGW64 /c")).toEqual({ folder: "C:\\" });
    expect(readPrompt("smsha@PC MINGW64 ~/projects")).toEqual({ folder: null });
    expect(readPrompt("me@box:/mnt/e/My Work/api$ node x.js")).toEqual({ folder: "E:\\My Work\\api" });
    expect(readPrompt("me@box:~$ ls")).toEqual({ folder: null });
    expect(readPrompt("me@box:/home/me/src$ ")).toEqual({ folder: null });
    expect(readPrompt("PS E:\\x> dir")).toEqual({ folder: "E:\\x" });
    for (const line of ["$ npm install", "Status: Adult", "user@example.com", "error: a@b: not found", "https://a@b.com/x$y"]) {
      expect(readPrompt(line), line).toBeNull();
    }
  });

  it("follows a cd in a Git Bash terminal, and falls back to the terminal's folder in the WSL home", () => {
    const r = rig();
    r.addTerminal("t1", "E:\\smoke");
    r.print("t1", "\r\nsmsha@PC MINGW64 /e/smoke/node-console\r\n$ node needs_left_pad.js\r\n");
    r.print("t1", "Error: Cannot find module 'left-pad'\r\n");
    expect(r.deps.getState()).toMatchObject({ issue: { kind: "nodePackage" }, base: "E:\\smoke\\node-console" });
    r.addTerminal("t2", "E:\\smoke");
    r.print("t2", "me@box:/mnt/e/smoke/py$ cd ~\r\nme@box:~$ python3 a.py\r\n");
    r.print("t2", "ModuleNotFoundError: No module named 'pandas'\r\n");
    expect(r.deps.getState()).toMatchObject({ issue: { kind: "pythonPackage" }, base: "E:\\smoke" });
  });

  it("Run Code's Output uses the active file and offers Run in Terminal; other channels are ignored", () => {
    const r = rig();
    r.output.append("Git", "ModuleNotFoundError: No module named 'x'");
    expect(r.deps.getState().issue).toBeNull();
    r.output.append("Python", "ModuleNotFoundError: No module named 'pandas'");
    expect(r.deps.getState()).toMatchObject({ base: "E:\\p\\main.py", fromRunCode: true, source: "Python" });
  });

  it("the card's install is planned by the backend, confirmed, and run as a terminal's own program (its exit code is real)", async () => {
    const r = rig();
    (r.ipc.depsPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
      manager: "pip",
      action: "add",
      packages: ["requests"],
      program: "E:\\app\\python.exe",
      source: "OpenMind portable",
      args: ["-m", "pip", "install", "--cache-dir=E:\\app\\cache\\pip", "requests"],
      command: "E:\\app\\python.exe -m pip install --cache-dir=E:\\app\\cache\\pip requests",
      cwd: "E:\\p",
      target: "OpenMind's portable Python (E:\\app)",
      network: "required",
      notes: [],
    });
    const changed = vi.fn();
    r.wiring.onChanged(changed);
    r.output.append("Python", "ModuleNotFoundError: No module named 'requests'");
    expect(await r.deps.install("pip")).toBe(true);
    const request = { base: "E:\\p\\main.py", op: { op: "pythonAdd", packages: "requests", offline: false } };
    expect(r.ipc.depsPlan).toHaveBeenCalledWith(request);
    // The same request (never a command line) goes to the backend, which plans it again before running it.
    expect(r.ipc.depsRun).toHaveBeenCalledWith(request, 80, 24);
    expect(r.waitForExit).toHaveBeenCalledWith("t9");
    expect(changed).toHaveBeenCalledOnce();
  });

  it("a failed install reports its exit code and keeps the card", async () => {
    const r = rig();
    (r.ipc.depsPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
      manager: "npm", action: "add", packages: ["left-pad"], program: "C:\\node\\npm.cmd", source: "OpenMind runtime",
      args: ["install", "left-pad"], command: "npm install left-pad", cwd: "E:\\p", target: "E:\\p\\node_modules", network: "required", notes: [],
    });
    r.waitForExit.mockResolvedValue(1);
    r.output.append("Node.js", "Error: Cannot find module 'left-pad'");
    expect(await r.deps.install("npm")).toBe(false);
    expect(r.deps.getState().error).toBe("The install failed (exit code 1). The terminal shows why.");
    expect(r.deps.getState().issue).not.toBeNull();
  });
});
