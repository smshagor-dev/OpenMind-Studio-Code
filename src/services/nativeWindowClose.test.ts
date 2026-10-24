import { beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  invoke: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  listen: vi.fn<(event: string, handler: (event?: { payload: unknown }) => void) => Promise<() => void>>(),
  off: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ listen: native.listen }) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: vi.fn() }));

import { tauriWindowApi } from "./windowService";

beforeEach(() => {
  vi.clearAllMocks();
  native.invoke.mockResolvedValue("current-page-token");
  native.listen.mockResolvedValue(native.off);
});

it("installs the recovery event listener before telling native code it is ready", async () => {
  const handler = vi.fn().mockResolvedValue(undefined);
  const off = await tauriWindowApi.onCloseRequested?.(handler);
  expect(native.listen).toHaveBeenCalledWith("editor-close-requested", expect.any(Function));
  expect(native.invoke).toHaveBeenCalledWith("window_close_ready");
  expect(native.listen.mock.invocationCallOrder[0]).toBeLessThan(native.invoke.mock.invocationCallOrder[0] ?? 0);
  native.listen.mock.calls[0]?.[1]();
  expect(handler).toHaveBeenCalledTimes(1);
  const event: unknown = handler.mock.calls[0]?.[0];
  expect(event).toHaveProperty("preventDefault");
  expect(native.invoke.mock.calls.map(call => call[0])).not.toContain("window_close_confirmed");
  off?.(); expect(native.off).toHaveBeenCalledTimes(3);
  expect(native.invoke).toHaveBeenLastCalledWith("window_close_unready", { token: "current-page-token" });
});

it("removes the listener if native readiness registration fails", async () => {
  native.invoke.mockRejectedValueOnce(new Error("native unavailable"));
  await expect(tauriWindowApi.onCloseRequested?.(vi.fn())).rejects.toThrow("native unavailable");
  expect(native.off).toHaveBeenCalledTimes(3);
});

it("acknowledges a confirmed close through its dedicated native command", async () => {
  await tauriWindowApi.onCloseRequested?.(vi.fn());
  native.invoke.mockClear();
  await tauriWindowApi.confirmClose?.();
  expect(native.invoke).toHaveBeenCalledExactlyOnceWith("window_close_confirmed", { token: "current-page-token" });
});


it("replaces the close capability when a listener is re-registered", async () => {
  native.invoke.mockResolvedValueOnce("old-page-token").mockResolvedValueOnce("replacement-page-token");
  await tauriWindowApi.onCloseRequested?.(vi.fn());
  await tauriWindowApi.onCloseRequested?.(vi.fn());
  await tauriWindowApi.confirmClose?.();
  expect(native.invoke).toHaveBeenLastCalledWith("window_close_confirmed", { token: "replacement-page-token" });
});


it("routes global recovery through flush-only events and acknowledges without closing the window", async () => {
  const handler = vi.fn().mockResolvedValue(undefined);
  const off = await tauriWindowApi.onCloseRequested?.(handler);
  const request = native.listen.mock.calls.find(call => call[0] === "editor-shutdown-requested")?.[1];
  const finished = native.listen.mock.calls.find(call => call[0] === "editor-shutdown-finished")?.[1];
  request?.({ payload: { requestId: "quit-all", token: "current-page-token" } });
  await vi.waitFor(() => { expect(native.invoke).toHaveBeenCalledWith("window_shutdown_ack", { requestId: "quit-all", token: "current-page-token", saved: true }); });
  expect(native.invoke.mock.calls.map(call => call[0])).not.toContain("window_close_confirmed");
  expect(document.documentElement.inert).toBe(true);
  finished?.({ payload: { requestId: "quit-all" } }); expect(document.documentElement.inert).not.toBe(true);
  off?.();
});

it("retires partial listener registration before exposing native readiness", async () => {
  native.listen.mockResolvedValueOnce(native.off).mockRejectedValueOnce(Error("listener failed"));
  await expect(tauriWindowApi.onCloseRequested?.(vi.fn())).rejects.toThrow("listener failed");
  expect(native.off).toHaveBeenCalledTimes(1);
  expect(native.invoke).not.toHaveBeenCalled();
});


it("ignores a global recovery event in a replaced registration instead of acknowledging twice", async () => {
  native.invoke.mockResolvedValueOnce("old").mockResolvedValueOnce("new");
  const first = await tauriWindowApi.onCloseRequested?.(vi.fn().mockResolvedValue(undefined));
  const second = await tauriWindowApi.onCloseRequested?.(vi.fn().mockResolvedValue(undefined));
  const requests = native.listen.mock.calls.filter(call => call[0] === "editor-shutdown-requested");
  for (const call of requests) call[1]({ payload: { requestId: "quit-replacement", token: "new" } });
  await vi.waitFor(() => { expect(native.invoke).toHaveBeenCalledWith("window_shutdown_ack", { requestId: "quit-replacement", token: "new", saved: true }); });
  expect(native.invoke.mock.calls.filter(call => call[0] === "window_shutdown_ack")).toHaveLength(1);
  first?.(); expect(document.documentElement.inert).toBe(true);
  second?.(); expect(document.documentElement.inert).not.toBe(true);
});
