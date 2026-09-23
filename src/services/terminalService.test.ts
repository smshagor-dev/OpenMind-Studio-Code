import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { IpcClient, ShellInfo, TerminalSessionInfo } from "./ipc";
import { PANEL_MAX_HEIGHT, PANEL_MIN_HEIGHT, TerminalService } from "./terminalService";

const SHELLS: ShellInfo[] = [
  { kind: "powerShell", label: "PowerShell", available: true },
  { kind: "cmd", label: "Command Prompt", available: true },
  { kind: "gitBash", label: "Git Bash", available: false },
  { kind: "wsl", label: "WSL", available: false },
];

function sessionInfo(id: string, shell: TerminalSessionInfo["shell"] = "powerShell") {
  return { id, shell, cwd: "C:/proj", pid: 100 } satisfies TerminalSessionInfo;
}

describe("TerminalService", () => {
  let events: EventBus<AppEvents>;
  let cwd: string | null;
  let outputHandler: (id: string, data: Uint8Array) => void;
  let exitHandler: (id: string, code: number | null) => void;
  let ipc: IpcClient;
  let counter: number;

  function makeService(overrides: Partial<IpcClient> = {}) {
    ipc = createFakeIpc({
      terminalListShells: vi.fn().mockResolvedValue(SHELLS),
      terminalCreate: vi.fn((shell: string | null) =>
        Promise.resolve(sessionInfo(`t${String(++counter)}`, (shell ?? "powerShell") as "cmd")),
      ),
      onTerminalOutput: vi.fn((handler: typeof outputHandler) => {
        outputHandler = handler;
        return Promise.resolve(() => undefined);
      }),
      onTerminalExit: vi.fn((handler: typeof exitHandler) => {
        exitHandler = handler;
        return Promise.resolve(() => undefined);
      }),
      ...overrides,
    });
    return new TerminalService(ipc, events, () => cwd);
  }

  beforeEach(() => {
    events = new EventBus<AppEvents>();
    cwd = "C:/proj";
    counter = 0;
  });

  it("only offers shells that are actually available", async () => {
    const service = makeService();
    await service.initialize();

    expect(service.getState().shells.map((shell) => shell.kind)).toEqual(["powerShell", "cmd"]);
  });

  it("does not start any terminal on launch, even if the panel was left open", async () => {
    const service = makeService({
      settingsGet: vi
        .fn()
        .mockResolvedValue('{"panelVisible":true,"panelHeight":300,"lastShell":"cmd"}'),
    });
    await service.initialize();

    expect(service.getState()).toMatchObject({
      panelVisible: true,
      panelHeight: 300,
      lastShell: "cmd",
      sessions: [],
    });
    expect(ipc.terminalCreate).not.toHaveBeenCalled();
  });

  it("ignores a persisted shell that is no longer available", async () => {
    const service = makeService({
      settingsGet: vi.fn().mockResolvedValue('{"panelVisible":false,"lastShell":"wsl"}'),
    });
    await service.initialize();

    expect(service.getState().lastShell).toBeNull();
  });

  it("createTerminal starts in the workspace folder, shows the panel and activates the session", async () => {
    const service = makeService();
    await service.initialize();

    const id = await service.createTerminal();

    expect(ipc.terminalCreate).toHaveBeenCalledWith(null, "C:/proj", 80, 24);
    expect(service.getState()).toMatchObject({ panelVisible: true, activeId: id });
    expect(service.getState().sessions).toHaveLength(1);
  });

  it("createTerminal with no folder open passes a null cwd", async () => {
    cwd = null;
    const service = makeService();
    await service.initialize();

    await service.createTerminal();

    expect(ipc.terminalCreate).toHaveBeenCalledWith(null, null, 80, 24);
  });

  it("remembers the last shell, reuses it, and persists it", async () => {
    const service = makeService();
    await service.initialize();

    await service.createTerminal("cmd");
    await service.createTerminal();

    expect(ipc.terminalCreate).toHaveBeenLastCalledWith("cmd", "C:/proj", 80, 24);
    expect(ipc.settingsSet).toHaveBeenLastCalledWith(
      "terminal.state",
      expect.stringContaining('"lastShell":"cmd"'),
    );
  });

  it("numbers additional terminals of the same shell", async () => {
    const service = makeService();
    await service.initialize();

    await service.createTerminal("cmd");
    await service.createTerminal("cmd");

    expect(service.getState().sessions.map((session) => session.title)).toEqual([
      "Command Prompt",
      "Command Prompt (2)",
    ]);
  });

  it("a failed spawn surfaces as appError and adds no session", async () => {
    const service = makeService({
      terminalCreate: vi.fn().mockRejectedValue(new Error("shell is not available")),
    });
    const errors: string[] = [];
    events.on("appError", ({ message }) => errors.push(message));
    await service.initialize();

    const id = await service.createTerminal();

    expect(id).toBeNull();
    expect(errors).toHaveLength(1);
    expect(service.getState().sessions).toHaveLength(0);
  });

  it("switching the active terminal", async () => {
    const service = makeService();
    await service.initialize();
    const first = (await service.createTerminal()) ?? "";
    await service.createTerminal();

    service.setActive(first);

    expect(service.getState().activeId).toBe(first);
  });

  it("closing a terminal kills it, activates a neighbour, and hides the panel after the last one", async () => {
    const service = makeService();
    await service.initialize();
    const first = (await service.createTerminal()) ?? "";
    const second = (await service.createTerminal()) ?? "";

    await service.closeTerminal(second);
    expect(ipc.terminalClose).toHaveBeenCalledWith(second);
    expect(service.getState()).toMatchObject({ activeId: first, panelVisible: true });

    await service.closeTerminal(first);
    expect(service.getState()).toMatchObject({ activeId: null, panelVisible: false, sessions: [] });
  });

  it("a shell exit marks the session exited but keeps its tab", async () => {
    const service = makeService();
    await service.initialize();
    const id = (await service.createTerminal()) ?? "";

    exitHandler(id, 3);

    expect(service.getState().sessions[0]).toMatchObject({ exited: true, exitCode: 3 });
  });

  it("routes output to the attached view and buffers what arrives before it attaches", async () => {
    const service = makeService();
    await service.initialize();
    outputHandler("t1", new Uint8Array([1]));
    const id = (await service.createTerminal()) ?? "";
    const write = vi.fn();

    service.attachSink(id, { write, clear: vi.fn() });
    outputHandler(id, new Uint8Array([2]));

    expect(write.mock.calls.map((call) => Array.from(call[0] as Uint8Array))).toEqual([[1], [2]]);
  });

  it("drops late output from a terminal the user already closed", async () => {
    const service = makeService();
    await service.initialize();
    const id = (await service.createTerminal()) ?? "";
    await service.closeTerminal(id);

    outputHandler(id, new Uint8Array([9]));
    const write = vi.fn();
    service.attachSink(id, { write, clear: vi.fn() });

    expect(write).not.toHaveBeenCalled();
  });

  it("clear asks the attached view to clear", async () => {
    const service = makeService();
    await service.initialize();
    const id = (await service.createTerminal()) ?? "";
    const clear = vi.fn();
    service.attachSink(id, { write: vi.fn(), clear });

    service.clearActive();

    expect(clear).toHaveBeenCalled();
  });

  it("forwards input and resize to the backend", async () => {
    const service = makeService();
    await service.initialize();

    service.write("t1", "echo hi\r");
    service.resize("t1", 120, 30);

    expect(ipc.terminalWrite).toHaveBeenCalledWith("t1", "echo hi\r");
    expect(ipc.terminalResize).toHaveBeenCalledWith("t1", 120, 30);
  });

  it("togglePanel starts a terminal only when there is none, and otherwise just shows/hides", async () => {
    const service = makeService();
    await service.initialize();

    await service.togglePanel();
    expect(service.getState()).toMatchObject({ panelVisible: true });
    expect(ipc.terminalCreate).toHaveBeenCalledTimes(1);

    await service.togglePanel();
    expect(service.getState().panelVisible).toBe(false);
    expect(service.getState().sessions).toHaveLength(1);

    await service.togglePanel();
    expect(service.getState().panelVisible).toBe(true);
    expect(ipc.terminalCreate).toHaveBeenCalledTimes(1);
  });

  it("clamps and persists the panel height", async () => {
    const service = makeService();
    await service.initialize();

    service.previewPanelHeight(5);
    expect(service.getState().panelHeight).toBe(PANEL_MIN_HEIGHT);
    service.previewPanelHeight(99999);
    expect(service.getState().panelHeight).toBe(PANEL_MAX_HEIGHT);

    await service.commitPanelHeight();
    expect(ipc.settingsSet).toHaveBeenLastCalledWith(
      "terminal.state",
      expect.stringContaining(`"panelHeight":${String(PANEL_MAX_HEIGHT)}`),
    );
  });

  it("notifies subscribers when state changes", async () => {
    const service = makeService();
    const listener = vi.fn();
    service.subscribe(listener);

    await service.initialize();

    expect(listener).toHaveBeenCalled();
  });
});
