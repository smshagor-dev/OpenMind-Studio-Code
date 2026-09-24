import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { IpcClient, ShellInfo, TerminalSessionInfo } from "./ipc";
import { PanelService } from "./panelService";
import { TerminalService } from "./terminalService";

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
  let panel: PanelService;
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
    panel = new PanelService(ipc);
    return new TerminalService(ipc, events, () => cwd, panel);
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
      // Only the old key exists: the panel migrates its visibility/height from it.
      settingsGet: vi.fn((key: string) =>
        Promise.resolve(
          key === "terminal.state"
            ? '{"panelVisible":true,"panelHeight":300,"lastShell":"cmd"}'
            : null,
        ),
      ),
    });
    await service.initialize();
    await panel.initialize();

    expect(service.getState()).toMatchObject({ lastShell: "cmd", sessions: [] });
    expect(panel.getState()).toMatchObject({ visible: true, height: 300 });
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
    expect(service.getState()).toMatchObject({ activeId: id });
    expect(panel.getState()).toMatchObject({ visible: true, activeTab: "terminal" });
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
    expect(service.getState()).toMatchObject({ activeId: first });
    expect(panel.getState().visible).toBe(true);

    await service.closeTerminal(first);
    expect(service.getState()).toMatchObject({ activeId: null, sessions: [] });
    expect(panel.getState().visible).toBe(false);
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

  it("refuses a shell that isn't available without ever calling the backend", async () => {
    const service = makeService();
    const errors: string[] = [];
    events.on("appError", ({ message }) => errors.push(message));
    await service.initialize();

    const id = await service.createTerminal("wsl");

    expect(id).toBeNull();
    expect(ipc.terminalCreate).not.toHaveBeenCalled();
    expect(errors).toHaveLength(1);
  });

  it("input typed into an exited terminal is dropped instead of erroring", async () => {
    const service = makeService();
    await service.initialize();
    const id = (await service.createTerminal()) ?? "";
    exitHandler(id, 0);

    service.write(id, "ls\r");

    expect(ipc.terminalWrite).not.toHaveBeenCalled();
  });

  it("closing an already-exited terminal still cleans up without error", async () => {
    const service = makeService();
    const errors: string[] = [];
    events.on("appError", ({ message }) => errors.push(message));
    await service.initialize();
    const id = (await service.createTerminal()) ?? "";
    exitHandler(id, 0);

    await service.closeTerminal(id);

    expect(ipc.terminalClose).toHaveBeenCalledWith(id);
    expect(errors).toHaveLength(0);
    expect(service.getState().sessions).toHaveLength(0);
  });

  it("copyToClipboard writes the selection to the system clipboard and skips empty text", async () => {
    const service = makeService();

    await service.copyToClipboard("selected text");
    await service.copyToClipboard("");

    expect(ipc.clipboardWriteText).toHaveBeenCalledTimes(1);
    expect(ipc.clipboardWriteText).toHaveBeenCalledWith("selected text");
  });

  it("a clipboard failure surfaces as appError instead of failing silently", async () => {
    const service = makeService({
      clipboardWriteText: vi.fn().mockRejectedValue(new Error("clipboard busy")),
      clipboardReadText: vi.fn().mockRejectedValue(new Error("clipboard busy")),
    });
    const errors: string[] = [];
    events.on("appError", ({ message }) => errors.push(message));

    await service.copyToClipboard("x");
    const pasted = await service.readClipboard();

    expect(pasted).toBe("");
    expect(errors).toHaveLength(2);
  });

  it("readClipboard returns the clipboard text for the view to paste", async () => {
    const service = makeService({ clipboardReadText: vi.fn().mockResolvedValue("pasted text") });

    expect(await service.readClipboard()).toBe("pasted text");
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
    expect(panel.getState().visible).toBe(true);
    expect(ipc.terminalCreate).toHaveBeenCalledTimes(1);

    await service.togglePanel();
    expect(panel.getState().visible).toBe(false);
    expect(service.getState().sessions).toHaveLength(1);

    await service.togglePanel();
    expect(panel.getState().visible).toBe(true);
    expect(ipc.terminalCreate).toHaveBeenCalledTimes(1);
  });

  it("togglePanel while another panel tab is showing switches to the terminal instead of hiding", async () => {
    const service = makeService();
    await service.initialize();
    await service.createTerminal();
    await panel.show("output");

    await service.togglePanel();

    expect(panel.getState()).toMatchObject({ visible: true, activeTab: "terminal" });
    expect(service.isShowing()).toBe(true);
  });

  it("logs its lifecycle to the output channel it was given", async () => {
    const lines: string[] = [];
    ipc = createFakeIpc({
      terminalListShells: vi.fn().mockResolvedValue(SHELLS),
      terminalCreate: vi.fn().mockResolvedValue(sessionInfo("t1")),
      onTerminalExit: vi.fn((handler: typeof exitHandler) => {
        exitHandler = handler;
        return Promise.resolve(() => undefined);
      }),
    });
    const service = new TerminalService(
      ipc,
      events,
      () => cwd,
      new PanelService(ipc),
      (line) => lines.push(line),
    );
    await service.initialize();

    await service.createTerminal();
    exitHandler("t1", 2);
    await service.closeTerminal("t1");

    expect(lines).toEqual([
      "Started PowerShell in C:/proj",
      "PowerShell exited with code 2",
      "Closed PowerShell",
    ]);
  });

  it("notifies subscribers when state changes", async () => {
    const service = makeService();
    const listener = vi.fn();
    service.subscribe(listener);

    await service.initialize();

    expect(listener).toHaveBeenCalled();
  });
});
