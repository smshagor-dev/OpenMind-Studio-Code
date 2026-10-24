import { describe, expect, it, vi } from "vitest";
import { ExtensionWindowState, type WindowFocusSource } from "./extensionWindowState";
import { ExtensionHostService } from "./extensionHostService";
import type { HostDocumentSync } from "./extensionHostSync";
import { command, rig } from "../testUtils/extensionRig";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function source() {
  let listener: (focused: boolean) => void = vi.fn();
  const off = vi.fn();
  const api: WindowFocusSource = {
    isFocused: vi.fn().mockResolvedValue(true),
    onFocusChanged: vi.fn().mockImplementation((next: typeof listener) => { listener = next; return Promise.resolve(off); }),
  };
  return { api, off, emit: (focused: boolean) => { listener(focused); } };
}

describe("extension native window state", () => {
  it("samples focus, deduplicates OS events and ignores callbacks after disposal", async () => {
    const s = source(); const changed = vi.fn(); const state = new ExtensionWindowState(s.api, changed);
    await state.start(); expect(state.focused).toBe(true);
    s.emit(true); s.emit(false); s.emit(false);
    expect(changed.mock.calls).toEqual([[true], [false]]);
    state.stop(); s.emit(true); expect(state.focused).toBe(false); expect(s.off).toHaveBeenCalledOnce();
  });
  it("keeps a newer focus event when the initial OS query resolves late", async () => {
    const s = source(); const sample = deferred<boolean>(); vi.mocked(s.api.isFocused).mockReturnValue(sample.promise);
    const state = new ExtensionWindowState(s.api, vi.fn()); const starting = state.start();
    await Promise.resolve(); s.emit(false); sample.resolve(true); await starting;
    expect(state.focused).toBe(false); state.stop();
  });
  it("removes a subscription that finishes registering after disposal", async () => {
    const s = source(); const registered = deferred<() => void>(); vi.mocked(s.api.onFocusChanged).mockReturnValue(registered.promise);
    const state = new ExtensionWindowState(s.api, vi.fn()); const starting = state.start(); state.stop();
    registered.resolve(s.off); await starting; expect(s.off).toHaveBeenCalledOnce(); expect(s.api.isFocused).not.toHaveBeenCalled();
  });
  it("ignores a stale initial query after tracking has restarted", async () => {
    const s = source(); const old = deferred<boolean>(); vi.mocked(s.api.isFocused).mockReturnValueOnce(old.promise).mockResolvedValue(false);
    const state = new ExtensionWindowState(s.api, vi.fn()); const first = state.start(); await Promise.resolve();
    await state.start(); old.resolve(true); await first;
    expect(state.focused).toBe(false); expect(s.off).toHaveBeenCalledOnce(); state.stop();
  });
  it("releases the listener when the OS query fails", async () => {
    const s = source(); vi.mocked(s.api.isFocused).mockRejectedValue(new Error("unavailable"));
    const state = new ExtensionWindowState(s.api, vi.fn()); await expect(state.start()).rejects.toThrow("unavailable");
    expect(s.off).toHaveBeenCalledOnce(); s.emit(true); expect(state.focused).toBe(false); state.stop(); expect(s.off).toHaveBeenCalledOnce();
  });
  it("seeds host startup and catches focus changes while host startup is pending", async () => {
    const r = rig([command]); await r.registry.initialize(); const s = source();
    const service = new ExtensionHostService({ ipc: r.ipc, events: r.events, registry: r.registry, bridge: r.bridge,
      sync: { initial: () => ({ documents: [], activeEditor: null }), start: vi.fn(), stop: vi.fn() } as unknown as HostDocumentSync,
      settingsValues: () => ({}), workspaceFolders: () => [], windowFocus: s.api });
    await service.initialize();
    const starting = deferred<Awaited<ReturnType<typeof r.ipc.extHostStart>>>(); vi.mocked(r.ipc.extHostStart).mockReturnValueOnce(starting.promise);
    const pending = service.start(); s.emit(false);
    expect(r.ipc.extHostStart).toHaveBeenCalledWith(expect.objectContaining({ windowState: { focused: true } }));
    starting.resolve({ state: "running", pid: 1, node: "node", error: null }); await pending;
    expect(r.ipc.extHostNotify).toHaveBeenLastCalledWith("host/windowStateChanged", { focused: false });
    s.emit(true); expect(r.ipc.extHostNotify).toHaveBeenLastCalledWith("host/windowStateChanged", { focused: true });
    service.dispose(); expect(s.off).toHaveBeenCalledOnce();
  });
});
