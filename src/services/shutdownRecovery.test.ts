import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { BufferManager } from "./bufferManager";
import { DocumentService } from "./documentService";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import { editorLayoutKey, parseLayout } from "./editorLayoutService";
import { freezeWorkbenchInput, ShutdownRecovery } from "./shutdownRecovery";
import { WorkspaceService } from "./workspaceService";

const cleanups: (() => void)[] = [];
beforeEach(() => { document.documentElement.inert = false; document.documentElement.removeAttribute("aria-busy"); });
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); document.documentElement.inert = false; document.documentElement.removeAttribute("aria-busy"); });
const request = { requestId: "quit-1", token: "page-1" };

function rig(flush: () => Promise<boolean> = () => Promise.resolve(true)) {
  let token = "page-1";
  const acknowledge = vi.fn().mockResolvedValue(undefined), onError = vi.fn();
  const service = new ShutdownRecovery({ currentToken: () => token, flush, acknowledge, freezeInput: freezeWorkbenchInput, onError });
  cleanups.push(() => { service.dispose(); });
  return { service, acknowledge, onError, replacePage: () => { token = "page-2"; } };
}

it("freezes input before persistence, coalesces duplicate requests and waits for native finish to release input", async () => {
  let finish: ((saved: boolean) => void) | undefined;
  const flush = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
  const r = rig(flush), pending = r.service.request(request);
  expect(document.documentElement.inert).toBe(true);
  await r.service.request(request);
  expect(flush).toHaveBeenCalledTimes(1); expect(r.acknowledge).not.toHaveBeenCalled();
  finish?.(true); await pending;
  expect(r.acknowledge).toHaveBeenCalledWith(request, true);
  expect(document.documentElement.inert).toBe(true);
  r.service.finish({ requestId: request.requestId });
  expect(document.documentElement.inert).toBe(false);
});

it("negatively acknowledges a failed recovery without allowing input until cancellation arrives", async () => {
  const r = rig(() => Promise.resolve(false)); await r.service.request(request);
  expect(r.acknowledge).toHaveBeenCalledWith(request, false);
  expect(document.documentElement.inert).toBe(true);
  r.service.finish({ requestId: request.requestId, error: "Quit cancelled" });
  expect(document.documentElement.inert).toBe(false);
  expect(r.onError).toHaveBeenCalledWith(expect.objectContaining({ message: "Quit cancelled" }));
});

it("reports a thrown persistence failure and sends a negative reply", async () => {
  const error = Error("disk full"), r = rig(() => Promise.reject(error));
  await r.service.request(request);
  expect(r.onError).toHaveBeenCalledWith(error);
  expect(r.acknowledge).toHaveBeenCalledWith(request, false);
});

it("cancellation restores input and rejects a late successful persistence completion", async () => {
  let finish: ((saved: boolean) => void) | undefined;
  const r = rig(() => new Promise<boolean>(resolve => { finish = resolve; }));
  const pending = r.service.request(request);
  r.service.finish({ requestId: request.requestId });
  finish?.(true); await pending;
  expect(r.acknowledge).not.toHaveBeenCalled(); expect(document.documentElement.inert).toBe(false);
});

it("keeps a replacement request active when an old request finishes or is cancelled late", async () => {
  let finish: ((saved: boolean) => void) | undefined;
  const flush = vi.fn<() => Promise<boolean>>().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(true);
  const r = rig(flush), pending = r.service.request(request);
  const next = { ...request, requestId: "quit-2" }; await r.service.request(next);
  r.service.finish({ requestId: request.requestId }); finish?.(true); await pending;
  expect(document.documentElement.inert).toBe(true);
  expect(r.acknowledge).toHaveBeenCalledExactlyOnceWith(next, true);
  r.service.finish({ requestId: next.requestId }); expect(document.documentElement.inert).toBe(false);
});

it("does not acknowledge from a replaced page and releases input on teardown", async () => {
  let finish: ((saved: boolean) => void) | undefined;
  const r = rig(() => new Promise<boolean>(resolve => { finish = resolve; }));
  const pending = r.service.request(request); r.replacePage(); finish?.(true); await pending;
  expect(r.acknowledge).not.toHaveBeenCalled(); r.service.dispose();
  expect(document.documentElement.inert).toBe(false);
  await r.service.request({ requestId: "later", token: "page-2" });
  expect(r.acknowledge).not.toHaveBeenCalled();
});

it("ignores invalid or unrelated page requests", async () => {
  const flush = vi.fn().mockResolvedValue(true), r = rig(flush);
  for (const value of [null, {}, { requestId: "", token: "page-1" }, { ...request, token: "other-page" }]) await r.service.request(value);
  expect(flush).not.toHaveBeenCalled(); expect(document.documentElement.inert).toBe(false);
});

it("reports acknowledgement failure without dropping the active input barrier", async () => {
  const r = rig(); r.acknowledge.mockRejectedValueOnce(Error("native disconnected"));
  await r.service.request(request); expect(r.onError).toHaveBeenCalledTimes(1);
  expect(document.documentElement.inert).toBe(true);
  r.service.finish({ requestId: request.requestId }); expect(document.documentElement.inert).toBe(false);
});

it("preserves pre-existing inert and accessibility state on cancellation", async () => {
  document.documentElement.inert = true; document.documentElement.setAttribute("aria-busy", "false");
  const r = rig(); await r.service.request(request); r.service.finish({ requestId: request.requestId });
  expect(document.documentElement.inert).toBe(true);
  expect(document.documentElement.getAttribute("aria-busy")).toBe("false");
});

it("backs up both a hidden native buffer and an extra window's untitled buffer before acknowledging", async () => {
  const settings = new Map<string, string>();
  for (const label of ["main", "window-2"]) {
    const ipc = createFakeIpc({ settingsGet: key => Promise.resolve(settings.get(key) ?? null), settingsSet: (key, value) => { settings.set(key, value); return Promise.resolve(); } });
    const events = new EventBus<AppEvents>(), buffers = new BufferManager();
    const documents = new DocumentService(ipc, buffers, events), workspace = new WorkspaceService(documents, ipc, events, { windowLabel: label });
    cleanups.push(() => { workspace.dispose(); buffers.disposeAll(); });
    if (label === "main") {
      vi.mocked(ipc.documentOpen).mockResolvedValueOnce({ path: "/tmp/hidden.txt", content: "disk", encoding: "utf8", lineEnding: "lf" });
      const id = await documents.openFromPath("/tmp/hidden.txt"); buffers.setValue(id, "hidden main edits");
    } else documents.createUntitled("extra window edits");
    const ack = vi.fn(() => {
      expect(parseLayout(settings.get(editorLayoutKey(label)) ?? "")?.buffers?.[0]?.text).toBe(label === "main" ? "hidden main edits" : "extra window edits");
      return Promise.resolve();
    });
    const recovery = new ShutdownRecovery({ currentToken: () => label, flush: () => workspace.flushSession(), acknowledge: ack, freezeInput: () => () => undefined, onError: error => { throw error; } });
    cleanups.push(() => { recovery.dispose(); });
    await recovery.request({ requestId: "all-windows", token: label }); expect(ack).toHaveBeenCalledTimes(1);
    expect(ipc.documentSave).not.toHaveBeenCalled();
  }
  expect(settings.size).toBe(2);
});


it("keeps input blocked until every overlapping owner releases, regardless of release order", () => {
  const first = freezeWorkbenchInput(), second = freezeWorkbenchInput();
  first(); first(); expect(document.documentElement.inert).toBe(true);
  second(); expect(document.documentElement.inert).toBe(false);
  expect(document.documentElement.hasAttribute("aria-busy")).toBe(false);
});
