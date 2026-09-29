import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import { OutputService } from "../outputService";
import type { TerminalService } from "../terminalService";
import type { DepsIpc } from "./depsIpc";
import { promptFolder, readPrompt, wireDeps } from "./depsWiring";

function rig() {
  const listeners = new Set<() => void>();
  const createTerminal = vi.fn().mockResolvedValue("t9");
  const write = vi.fn();
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
    createTerminal,
    write,
  } as unknown as TerminalService;
  const ipc: DepsIpc = {
    depsInstallPlan: vi.fn(),
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
    terminalLine: (argv) => Promise.resolve(argv.join(" ")),
  });
  return {
    deps,
    ipc,
    output,
    createTerminal,
    write,
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

  it("an install is typed into a new terminal in the project folder (nothing without the confirmation)", async () => {
    const r = rig();
    (r.ipc.depsInstallPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
      argv: ["E:\\app\\python.exe", "-m", "pip", "install", "requests"],
      cwd: "E:\\p",
      target: "openmindPython",
      interpreter: "E:\\app\\python.exe",
    });
    r.output.append("Python", "ModuleNotFoundError: No module named 'requests'");
    await r.deps.install("pip");
    expect(r.createTerminal).toHaveBeenCalledWith("powerShell", "E:\\p");
    expect(r.write).toHaveBeenCalledWith("t9", "E:\\app\\python.exe -m pip install requests\r");
  });
});
