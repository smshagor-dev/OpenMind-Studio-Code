import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { BreakpointService, SAVE_DELAY_MS } from "./breakpointService";
import type { BreakpointRow, IpcClient } from "./ipc";

const A = "C:/My Site/a.py";
const B = "C:/My Site/lib/b.py";

function rig(saved: BreakpointRow[] = [], debugging = false, missing: string[] = []) {
  const ipc: IpcClient = createFakeIpc({
    breakpointsLoad: vi.fn().mockResolvedValue(saved),
    fsMetadata: vi
      .fn()
      .mockImplementation((path: string) =>
        missing.includes(path) ? Promise.reject(new Error("gone")) : Promise.resolve({ path }),
      ),
  });
  const state = { debugging };
  return { ipc, state, service: new BreakpointService(ipc, () => state.debugging) };
}

describe("BreakpointService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("toggling adds a breakpoint to one file and toggling again removes it", () => {
    const { service } = rig();
    expect(service.toggle(A, 3)).toBe(true);
    expect(service.toggle(B, 3)).toBe(true);
    expect(service.forFile(A).map((bp) => bp.line)).toEqual([3]);
    expect(service.forFile(B).map((bp) => bp.line)).toEqual([3]);
    expect(service.toggle(A, 3)).toBe(false);
    expect(service.forFile(A)).toEqual([]);
    expect(service.forFile(B)).toHaveLength(1);
  });

  it("breakpoints are per file and matched across slash and drive-letter styles", () => {
    const { service } = rig();
    service.toggle("C:\\My Site\\a.py", 5);
    expect(service.at("c:/my site/a.py", 5)).toBeDefined();
    expect(service.at(B, 5)).toBeUndefined();
  });

  it("changes are saved to the database once, shortly after the last one", async () => {
    const { service, ipc } = rig();
    service.toggle(A, 3);
    service.toggle(A, 9);
    service.setEnabled(service.at(A, 9)?.id ?? "", false);
    expect(ipc.breakpointsSave).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 10);
    expect(ipc.breakpointsSave).toHaveBeenCalledTimes(1);
    expect(ipc.breakpointsSave).toHaveBeenCalledWith([
      { filePath: A, line: 3, enabled: true },
      { filePath: A, line: 9, enabled: false },
    ]);
  });

  it("saved breakpoints come back after a relaunch, with their enabled state", async () => {
    const { service } = rig([
      { filePath: A, line: 3, enabled: true },
      { filePath: A, line: 12, enabled: false },
    ]);
    await service.initialize();
    expect(service.forFile(A).map((bp) => [bp.line, bp.enabled, bp.stale])).toEqual([
      [3, true, false],
      [12, false, false],
    ]);
    expect(service.activeLines(A)).toEqual([3]);
  });

  it("a breakpoint whose file is gone is kept, marked stale and never sent to the debugger", async () => {
    const { service } = rig(
      [
        { filePath: A, line: 3, enabled: true },
        { filePath: B, line: 7, enabled: true },
      ],
      false,
      [B],
    );
    await service.initialize();
    expect(service.forFile(B)[0]?.stale).toBe(true);
    expect(service.activeLines(B)).toEqual([]);
    expect(service.activeRows()).toEqual([{ filePath: A, line: 3, enabled: true }]);
    // It is still saved, in case the file comes back.
    await service.saveNow();
  });

  it("disabling, enabling, removing and clearing", () => {
    const { service } = rig();
    service.toggle(A, 1);
    service.toggle(A, 2);
    service.toggle(B, 3);
    service.setAllEnabled(false);
    expect(service.activeRows()).toEqual([]);
    service.setAllEnabled(true);
    expect(service.activeRows()).toHaveLength(3);
    service.remove(service.at(A, 1)?.id ?? "");
    expect(service.getState().breakpoints).toHaveLength(2);
    service.removeAll();
    expect(service.getState().breakpoints).toEqual([]);
  });

  it("breakpoints follow their line when the text above moves them", () => {
    const { service } = rig();
    service.toggle(A, 10);
    const id = service.at(A, 10)?.id ?? "";
    service.moveLines([{ id, line: 12 }]);
    expect(service.at(A, 10)).toBeUndefined();
    expect(service.at(A, 12)?.id).toBe(id);
  });

  it("while a session runs every change reaches the adapter for that file only", () => {
    const { service, ipc, state } = rig();
    service.toggle(A, 3);
    expect(ipc.debugSetBreakpoints).not.toHaveBeenCalled();
    state.debugging = true;
    service.toggle(A, 8);
    expect(ipc.debugSetBreakpoints).toHaveBeenLastCalledWith(A, [3, 8]);
    service.setEnabled(service.at(A, 3)?.id ?? "", false);
    expect(ipc.debugSetBreakpoints).toHaveBeenLastCalledWith(A, [8]);
    service.toggle(B, 1);
    expect(ipc.debugSetBreakpoints).toHaveBeenLastCalledWith(B, [1]);
  });

  it("subscribers hear every change", () => {
    const { service } = rig();
    const listener = vi.fn();
    service.subscribe(listener);
    service.toggle(A, 1);
    service.toggle(A, 1);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
