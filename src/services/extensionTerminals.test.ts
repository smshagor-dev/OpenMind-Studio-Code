import { describe, expect, it, vi } from "vitest";

import { ExtensionTerminalService, RUN, RUN_ALWAYS, type TerminalsForExtensions } from "./extensionTerminals";

interface FakeSession {
  id: string;
  exited: boolean;
  exitCode: number | null;
}

function rig(answers: (string | null)[] = []) {
  let sessions: FakeSession[] = [];
  const listeners = new Set<() => void>();
  let showing = false;
  let activeId: string | null = null;
  const inputs = new Set<(id: string, data: string) => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const terminals = {
    createTerminal: vi.fn(() => {
      const id = `s${String(sessions.length + 1)}`;
      sessions = [...sessions, { id, exited: false, exitCode: null }];
      activeId = id;
      return Promise.resolve(id);
    }),
    closeTerminal: vi.fn((id: string) => {
      sessions = sessions.filter((s) => s.id !== id);
      emit();
      return Promise.resolve();
    }),
    write: vi.fn((id: string, data: string) => { for (const input of inputs) input(id, data); }),
    onInput: (listener: (id: string, data: string) => void) => { inputs.add(listener); return () => { inputs.delete(listener); }; },
    setActive: vi.fn((id: string) => { activeId = id; emit(); }),
    getState: () => ({ sessions, activeId }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    isShowing: () => showing,
  } as unknown as TerminalsForExtensions & { write: ReturnType<typeof vi.fn>; createTerminal: ReturnType<typeof vi.fn> };
  const showPanel = vi.fn(() => {
    showing = true;
    return Promise.resolve();
  });
  const confirm = vi.fn(() => Promise.resolve(answers.shift() ?? null));
  const notifyHost = vi.fn();
  const notice = vi.fn();
  const service = new ExtensionTerminalService({ terminals, showPanel, confirm, notifyHost, notice });
  return {
    service,
    terminals,
    showPanel,
    confirm,
    notifyHost,
    notice,
    select: (id: string) => { activeId = id; emit(); },
    exit: (id: string, code: number) => {
      sessions = sessions.map((s) => (s.id === id ? { ...s, exited: true, exitCode: code } : s));
      emit();
    },
  };
}

const base = { extension: "pub.ext", id: "pub.ext#term-1", name: "Build" };

describe("ExtensionTerminalService", () => {
  it("creates a terminal without opening the panel and refuses another extension's ids", async () => {
    const r = rig();
    await r.service.create(base);
    expect(r.terminals.createTerminal).toHaveBeenCalledWith(undefined, null, { refreshable: false, title: "Build (pub.ext)", show: false });
    expect(r.showPanel).not.toHaveBeenCalled();
    expect(r.service.countFor("pub.ext")).toBe(1);
    await expect(r.service.create({ ...base, id: "other.ext#term-1" })).rejects.toThrow("Invalid terminal request.");
  });

  it("types text without a line break and asks before anything runs", async () => {
    const r = rig([null]);
    await r.service.create(base);
    expect(await r.service.sendText({ ...base, text: "echo hi", addNewLine: false })).toEqual({ sent: true });
    expect(r.confirm).not.toHaveBeenCalled();
    expect(await r.service.sendText({ ...base, text: "", addNewLine: true })).toEqual({ sent: false });
    expect(r.confirm).toHaveBeenCalledTimes(1);
    const request = (r.confirm.mock.calls as unknown[][])[0]?.[0] as { details: { value: string }[] };
    expect(request.details[0]?.value).toBe("echo hi");
    expect(r.terminals.write).toHaveBeenCalledTimes(1);
    expect(r.showPanel).not.toHaveBeenCalled();
  });

  it("runs after Run (panel opens), and asks no more after Always", async () => {
    const r = rig([RUN, RUN_ALWAYS]);
    await r.service.create(base);
    await r.service.sendText({ ...base, text: "npm test" });
    expect(r.terminals.write).toHaveBeenLastCalledWith("s1", "npm test\r");
    expect(r.showPanel).toHaveBeenCalledTimes(1);
    await r.service.sendText({ ...base, text: "npm run build\n" });
    await r.service.sendText({ ...base, text: "ls" });
    expect(r.confirm).toHaveBeenCalledTimes(2);
    expect(r.terminals.write).toHaveBeenLastCalledWith("s1", "ls\r");
  });

  it("refuses text for a closed terminal and oversized text", async () => {
    const r = rig();
    await expect(r.service.sendText({ ...base, text: "x" })).rejects.toThrow("closed");
    await r.service.create(base);
    await expect(r.service.sendText({ ...base, text: "x".repeat(17 * 1024), addNewLine: false })).rejects.toThrow(
      "16 KB",
    );
  });

  it("show only selects and tells the user; it never opens the panel", async () => {
    const r = rig();
    await r.service.create(base);
    r.service.show(base);
    expect(r.terminals.setActive).toHaveBeenCalledWith("s1");
    expect(r.showPanel).not.toHaveBeenCalled();
    expect(r.notice).toHaveBeenCalledWith(expect.stringContaining("Open the Terminal panel"));
  });

  it("tells the host when the shell exits or the user closes it", async () => {
    const r = rig();
    await r.service.create(base);
    r.exit("s1", 3);
    expect(r.notifyHost).toHaveBeenCalledWith("host/terminalClosed", { id: base.id, exitCode: 3 });
    await r.service.create({ ...base, id: "pub.ext#term-2" });
    await r.terminals.closeTerminal("s2");
    expect(r.notifyHost).toHaveBeenCalledWith("host/terminalClosed", { id: "pub.ext#term-2", exitCode: null });
  });

  it("closes a disabled extension's terminals", async () => {
    const r = rig();
    await r.service.create(base);
    await r.service.keepOnly(new Set(["other.ext"]));
    expect(r.terminals.closeTerminal).toHaveBeenCalledWith("s1");
    expect(r.service.countFor("pub.ext")).toBe(0);
  });
});



describe("extension terminal focus and interaction", () => {
  it("announces selected managed terminals, deduplicates changes and clears ordinary or closed selections", async () => {
    const r = rig(); await r.service.create(base);
    expect(r.notifyHost).toHaveBeenLastCalledWith("host/activeTerminalChanged", { id: base.id });
    const count = r.notifyHost.mock.calls.length; r.select("s1"); expect(r.notifyHost).toHaveBeenCalledTimes(count);
    r.select("ordinary"); expect(r.notifyHost).toHaveBeenLastCalledWith("host/activeTerminalChanged", { id: null });
    r.select("s1"); r.exit("s1", 0); expect(r.notifyHost).toHaveBeenLastCalledWith("host/activeTerminalChanged", { id: null });
  });
  it("only marks real nonempty routed input once, including user input", async () => {
    const r = rig(); await r.service.create(base); r.notifyHost.mockClear();
    r.terminals.write("ordinary", "x"); r.terminals.write("s1", ""); expect(r.notifyHost).not.toHaveBeenCalled();
    r.terminals.write("s1", "typed"); r.terminals.write("s1", "more");
    expect(r.notifyHost.mock.calls).toEqual([["host/terminalStateChanged", { id: base.id, isInteractedWith: true }]]);
  });
  it("does not mark cancelled commands as interaction but marks accepted programmatic text", async () => {
    const r = rig([null]); await r.service.create(base); r.notifyHost.mockClear();
    await r.service.sendText({ ...base, text: "cancelled" }); expect(r.notifyHost).not.toHaveBeenCalled();
    await r.service.sendText({ ...base, text: "accepted", addNewLine: false });
    expect(r.notifyHost).toHaveBeenCalledWith("host/terminalStateChanged", { id: base.id, isInteractedWith: true });
  });
});
