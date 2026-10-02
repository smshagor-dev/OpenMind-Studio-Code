import { describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { RuntimeStatus, ShellKind } from "./ipc";
import { PanelService } from "./panelService";
import { describeRuntimeChange, runtimeFingerprint, TerminalRefreshService } from "./terminalRefreshService";
import { TerminalService } from "./terminalService";

function runtime(id: string, name: string, version: string | null, healthy = true): RuntimeStatus {
  return {
    id,
    displayName: name,
    activeVersion: version,
    installed: version === null ? [] : [{ version, active: true, healthy }],
  } as unknown as RuntimeStatus;
}

describe("runtime fingerprints", () => {
  it("change only when an active, healthy version appears, switches or goes", () => {
    const none = runtimeFingerprint([runtime("node", "Node.js", null)]);
    const v21 = runtimeFingerprint([runtime("node", "Node.js", "24.21.0")]);
    expect(v21).toBe("node@24.21.0");
    expect(none).not.toBe(v21);
    expect(runtimeFingerprint([runtime("node", "Node.js", "24.21.0", false)])).toBe(none);
    expect(runtimeFingerprint([runtime("node", "Node.js", "24.20.0")])).not.toBe(v21);
    const removed = (name: string) => `${name} removed`;
    expect(describeRuntimeChange([runtime("node", "Node.js", null)], [runtime("node", "Node.js", "24.21.0")], removed)).toBe(
      "Node.js 24.21.0",
    );
    expect(describeRuntimeChange([runtime("node", "Node.js", "24.21.0")], [runtime("node", "Node.js", null)], removed)).toBe(
      "Node.js removed",
    );
  });
});

async function rig(busy: (id: string) => boolean | null = () => false) {
  let counter = 0;
  let emit: (id: string, data: Uint8Array) => void = () => undefined;
  const ipc = createFakeIpc({
    terminalListShells: vi.fn().mockResolvedValue([
      { kind: "powerShell", label: "PowerShell", available: true },
    ]),
    terminalCreate: vi.fn((shell: ShellKind | null, cwd: string | null) => {
      counter += 1;
      return Promise.resolve({ id: `t${String(counter)}`, shell: shell ?? "powerShell", cwd: cwd ?? "C:/w", pid: counter });
    }),
    onTerminalOutput: vi.fn((handler: (id: string, data: Uint8Array) => void) => {
      emit = handler;
      return Promise.resolve(() => undefined);
    }),
  });
  const events = new EventBus<AppEvents>();
  const terminal = new TerminalService(ipc, events, () => "C:/w", new PanelService(ipc));
  await terminal.initialize();
  const waiting = vi.fn();
  const isBusy = vi.fn((id: string) => Promise.resolve(busy(id)));
  const refresh = new TerminalRefreshService({
    terminal,
    isBusy,
    note: (change, folder) => `runtimes changed (${change}) in ${folder}`,
    waiting,
    recheckMs: 10,
  });
  refresh.start("");
  const say = (id: string, text: string) => {
    emit(id, new TextEncoder().encode(text));
  };
  return { ipc, terminal, refresh, waiting, isBusy, say };
}

describe("refreshing terminals when the runtimes change", () => {
  it("restarts an idle terminal in the folder its prompt shows, in the same tab, and not one opened afterwards", async () => {
    const r = await rig();
    const first = await r.terminal.createTerminal();
    const other = await r.terminal.createTerminal();
    r.terminal.setActive(first ?? "");
    r.say(first ?? "", "PS E:\\My Work\\app> ");

    await r.refresh.runtimesChanged("node@24.21.0", "Node.js 24.21.0");

    const { sessions, activeId } = r.terminal.getState();
    expect(sessions.map((s) => s.title)).toEqual(["PowerShell", "PowerShell (2)"]);
    expect(sessions.every((s) => s.id !== first && s.id !== other)).toBe(true);
    expect(activeId).toBe(sessions[0]?.id);
    expect(r.ipc.terminalCreate).toHaveBeenCalledWith("powerShell", "E:\\My Work\\app", 80, 24);
    expect(r.ipc.terminalClose).toHaveBeenCalledWith(first);
    expect(r.ipc.terminalClose).toHaveBeenCalledWith(other);

    // Opened after the change: already has the new PATH.
    const later = await r.terminal.createTerminal();
    vi.mocked(r.ipc.terminalClose).mockClear();
    await r.refresh.refreshStale();
    expect(r.ipc.terminalClose).not.toHaveBeenCalled();
    expect(r.terminal.getState().sessions.some((s) => s.id === later)).toBe(true);
  });

  it("never touches a terminal while a program runs in it, and refreshes it once the program has ended", async () => {
    let running = true;
    const r = await rig(() => running);
    const id = await r.terminal.createTerminal();

    await r.refresh.runtimesChanged("node@24.21.0", "Node.js 24.21.0");
    expect(r.ipc.terminalClose).not.toHaveBeenCalled();
    expect(r.waiting).toHaveBeenCalledWith(["PowerShell"]);

    running = false;
    await vi.waitFor(() => {
      expect(r.ipc.terminalClose).toHaveBeenCalledWith(id);
    });
    expect(r.waiting).toHaveBeenCalledOnce();
    r.refresh.dispose();
  });

  it("leaves extension and task terminals, exited shells and ones it can't read alone", async () => {
    const r = await rig((id) => (id === "t2" ? null : false));
    await r.terminal.createTerminal(undefined, null, { title: "ext", refreshable: false });
    await r.terminal.createTerminal();
    await r.terminal.createTaskTerminal("build", () => Promise.resolve({ id: "task-1", shell: "powerShell", cwd: "C:/w" }), false);

    await r.refresh.runtimesChanged("node@24.21.0", "Node.js 24.21.0");

    expect(r.ipc.terminalClose).not.toHaveBeenCalled();
    expect(r.isBusy).toHaveBeenCalledTimes(1);
    // The same fingerprint again changes nothing.
    await r.refresh.runtimesChanged("node@24.21.0", "Node.js 24.21.0");
    expect(r.isBusy).toHaveBeenCalledTimes(1);
  });

  it("shows a note at the top of the restarted terminal and keeps the old one if the new shell can't start", async () => {
    const r = await rig();
    const id = await r.terminal.createTerminal();
    const written: string[] = [];
    vi.mocked(r.ipc.terminalCreate).mockRejectedValueOnce(new Error("no shell"));
    await r.refresh.runtimesChanged("node@24.21.0", "Node.js 24.21.0");
    expect(r.terminal.getState().sessions.map((s) => s.id)).toEqual([id]);

    await r.refresh.runtimesChanged("node@24.21.1", "Node.js 24.21.1");
    const replacement = r.terminal.getState().sessions[0]?.id ?? "";
    r.terminal.attachSink(replacement, {
      write: (data) => written.push(new TextDecoder().decode(data)),
      clear: () => undefined,
    });
    expect(written.join("")).toContain("runtimes changed (Node.js 24.21.1) in C:/w");
  });
});
