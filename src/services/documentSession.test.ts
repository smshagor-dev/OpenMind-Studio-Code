import { afterEach, expect, it, vi } from "vitest";
import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { AutoSaveService } from "./autoSaveService";
import { BufferManager } from "./bufferManager";
import { DocumentService } from "./documentService";
import { EditorGroupService } from "./editorGroupService";
import { EditorLayoutService, parseLayout } from "./editorLayoutService";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import { HostDocumentSync } from "./extensionHostSync";
import { WorkspaceService } from "./workspaceService";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.useRealTimers(); });

function rig(settings = new Map<string, string>()) {
  const ipc = createFakeIpc({
    settingsGet: vi.fn((key: string) => Promise.resolve(settings.get(key) ?? null)),
    settingsSet: vi.fn((key: string, value: string) => { settings.set(key, value); return Promise.resolve(); }),
  });
  const events = new EventBus<AppEvents>(), buffers = new BufferManager(), groups = new EditorGroupService();
  const documents = new DocumentService(ipc, buffers, events), workspace = new WorkspaceService(documents, ipc, events, { groups });
  cleanups.push(() => { workspace.dispose(); buffers.disposeAll(); });
  return { ipc, events, buffers, groups, documents, workspace, settings };
}

it("restores split virtual buffers, readonly state, untitled identities, language and unsaved text without filesystem reads", async () => {
  const first = rig();
  const writable = first.documents.openVirtual("memory://store/draft.txt?revision=1", "saved", "plaintext");
  const locked = first.documents.openVirtual("generated:///result.txt", "read only", "plaintext", true);
  const untitled = first.documents.createUntitled("নতুন লেখা", "markdown");
  const untitledUri = first.documents.hostPath(untitled);
  first.workspace.openDocument(writable, "text");
  first.workspace.splitRight();
  first.workspace.openDocument(untitled, "text");
  first.workspace.openDocument(locked, "text");
  first.buffers.setValue(writable, "unsaved বাংলা");
  expect(await first.workspace.flushSession()).toBe(true);
  const second = rig(new Map(first.settings));
  await second.workspace.restoreSession();
  expect(second.workspace.getState().groups).toHaveLength(2);
  const restored = second.documents.idForHostPath("memory://store/draft.txt?revision=1");
  if (!restored) throw Error("Missing recovered document");
  expect(second.groups.tabsForDoc(restored)).toHaveLength(2);
  expect(second.documents.contentOf(restored)).toBe("unsaved বাংলা");
  expect(second.documents.savedText(restored)).toBe("saved");
  expect(second.documents.isDirty(restored)).toBe(true);
  const recoveredUntitled = second.documents.idForHostPath(untitledUri);
  if (!recoveredUntitled) throw Error("Missing recovered untitled");
  expect(second.documents.contentOf(recoveredUntitled)).toBe("নতুন লেখা");
  expect(second.documents.languageOf(recoveredUntitled)).toBe("markdown");
  const readonly = second.documents.idForHostPath("generated:///result.txt");
  if (!readonly) throw Error("Missing recovered readonly document");
  expect(second.documents.isReadOnly(readonly)).toBe(true);
  expect(second.documents.autoSaveIds()).toEqual([restored]);
  expect(second.ipc.documentOpen).not.toHaveBeenCalled();
  const sync = new HostDocumentSync({ documents: second.documents, events: second.events, notify: () => undefined });
  expect(sync.initial().documents).toContainEqual(expect.objectContaining({ path: "memory://store/draft.txt?revision=1", native: true, isDirty: true }));
  expect(sync.initial().documents).toContainEqual(expect.objectContaining({ path: untitledUri, isUntitled: true, isDirty: true }));
});

it("restores untitled naming and EOL-only dirty state without reusing a recovered generated URI", () => {
  const r = rig();
  const uri = "untitled://openmind/untitled-2";
  const id = r.documents.restoreBuffer({ uri, kind: "untitled", text: "one\ntwo", savedText: "one\r\ntwo", language: "plaintext", readonly: false, number: 7 });
  expect(r.documents.isDirty(id)).toBe(true);
  expect(r.documents.snapshot(id).title).toBe("Untitled-7");
  const fresh = r.documents.createUntitled();
  expect(r.documents.hostPath(fresh)).not.toBe(uri);
  const snapshot = r.documents.recoverySnapshot(id);
  if (!snapshot) throw Error("Missing recovery snapshot");
  expect(r.documents.restoreBuffer(snapshot)).toBe(id);
});

it("rejects malformed recovery resources and never opens their URI through native filesystem IPC", async () => {
  const layout = { version: 2, activeGroup: 0, weights: [1], groups: [{ tabs: [{ path: "file:///etc/invalid", kind: "text" }, { path: "memory:///missing", kind: "text" }], activeIndex: 0 }],
    buffers: [{ uri: "file:///etc/invalid", kind: "virtual", text: "bad", savedText: "", language: "plaintext", readonly: false }] };
  const r = rig(new Map([["editor.layout", JSON.stringify(layout)]]));
  await r.workspace.restoreSession();
  expect(r.documents.allIds()).toEqual([]);
  expect(r.workspace.getState().tabs).toEqual([]);
  expect(r.ipc.documentOpen).not.toHaveBeenCalled();
  expect(parseLayout('{"version":1,"groups":[{"tabs":[]}]}')).not.toBeNull();
});

it("orders recovery writes so a slow older snapshot cannot replace the latest text", async () => {
  let text = "first", finish: (() => void) | undefined;
  const values: string[] = [];
  const ipc = createFakeIpc({ settingsSet: vi.fn((_key: string, value: string) => {
    values.push(value);
    return values.length === 1 ? new Promise<void>(resolve => { finish = resolve; }) : Promise.resolve();
  }) });
  const layout = new EditorLayoutService(ipc, new EditorGroupService(), () => null, () => undefined, () => [
    { uri: "memory:///draft", kind: "virtual", text, savedText: "", language: "plaintext", readonly: false },
  ]);
  const first = layout.save(); text = "second"; const second = layout.save();
  await vi.waitFor(() => { expect(values).toHaveLength(1); });
  finish?.(); expect(await first).toBe(true); expect(await second).toBe(true);
  expect(values.map(value => (JSON.parse(value) as { buffers: { text: string }[] }).buffers[0]?.text)).toEqual(["first", "second"]);
  layout.dispose();
});

it("flushes edits arriving during a recovery write and reports failure without marking the session saved", async () => {
  const r = rig(); const id = r.documents.createUntitled("first");
  await r.workspace.flushSession();
  let finish: (() => void) | undefined;
  vi.mocked(r.ipc.settingsSet).mockImplementationOnce((_key, value) => new Promise<void>(resolve => { finish = () => { r.settings.set("editor.layout", value); resolve(); }; }));
  const pending = r.workspace.flushSession();
  await vi.waitFor(() => { expect(finish).toBeTypeOf("function"); });
  r.buffers.setValue(id, "latest"); finish?.();
  expect(await pending).toBe(true);
  expect(parseLayout(r.settings.get("editor.layout") ?? "")?.buffers?.[0]?.text).toBe("latest");
  vi.mocked(r.ipc.settingsSet).mockRejectedValueOnce(Error("disk full"));
  expect(await r.workspace.flushSession()).toBe(false);
});

function autosave(r: ReturnType<typeof rig>, mode: string) {
  let active: string | null = r.documents.autoSaveIds()[0] ?? null;
  let focus: () => void = () => undefined;
  let blur: () => void = () => undefined;
  const service = new AutoSaveService({
    documents: r.documents, events: r.events,
    settings: { string: () => mode, number: () => 100, set: () => Promise.resolve(), onChange: () => () => undefined },
    save: (id) => r.documents.save(id), activeDocId: () => active,
    onActiveChanged: handler => { focus = handler; return () => undefined; },
    onWindowBlur: handler => { blur = handler; return () => undefined; },
  });
  service.start(); cleanups.push(() => { service.stop(); });
  return { service, blur: () => { blur(); }, leave: () => { active = null; focus(); } };
}

it.each(["afterDelay", "onFocusChange", "onWindowChange"])("autosaves writable virtual buffers under %s while leaving protected and untitled buffers alone", async mode => {
  vi.useFakeTimers();
  const r = rig();
  const writable = r.documents.openVirtual("memory:///write", "saved", "plaintext");
  const readonly = r.documents.openVirtual("memory:///readonly", "protected", "plaintext", true);
  r.documents.createUntitled("unsaved");
  const save = vi.fn().mockResolvedValue(undefined); r.documents.setVirtualSaver(save);
  const service = autosave(r, mode);
  r.buffers.setValue(writable, "edited"); r.buffers.setValue(readonly, "protected change");
  if (mode === "onFocusChange") service.leave();
  if (mode === "onWindowChange") service.blur();
  await vi.advanceTimersByTimeAsync(150);
  expect(save).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledWith("memory:///write", "edited");
  expect(r.documents.isDirty(writable)).toBe(false);
  expect(r.ipc.saveDocumentDialog).not.toHaveBeenCalled();
  expect(r.ipc.documentSave).not.toHaveBeenCalled();
});

it("serializes slow provider autosaves and saves the newer edit after the first write completes", async () => {
  vi.useFakeTimers();
  const r = rig(); const id = r.documents.openVirtual("memory:///write", "saved", "plaintext");
  let finish: (() => void) | undefined;
  const save = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; })).mockResolvedValue(undefined);
  r.documents.setVirtualSaver(save); autosave(r, "afterDelay");
  r.buffers.setValue(id, "first"); await vi.advanceTimersByTimeAsync(150);
  r.buffers.setValue(id, "second"); await vi.advanceTimersByTimeAsync(150);
  expect(save).toHaveBeenCalledTimes(1);
  finish?.(); await vi.advanceTimersByTimeAsync(150);
  expect(save).toHaveBeenCalledTimes(2);
  expect(save).toHaveBeenLastCalledWith("memory:///write", "second");
  expect(r.documents.isDirty(id)).toBe(false);
});

it("retains failed provider autosaves without a retry loop and retries when the host becomes available", async () => {
  vi.useFakeTimers();
  const r = rig(); const id = r.documents.openVirtual("memory:///write", "saved", "plaintext");
  const save = vi.fn().mockRejectedValueOnce(Error("provider unavailable")).mockResolvedValue(undefined);
  r.documents.setVirtualSaver(save); autosave(r, "afterDelay");
  r.buffers.setValue(id, "edited"); await vi.advanceTimersByTimeAsync(1000);
  expect(save).toHaveBeenCalledTimes(1); expect(r.documents.isDirty(id)).toBe(true);
  r.events.emit("extensionsChanged", undefined); await vi.advanceTimersByTimeAsync(150);
  expect(save).toHaveBeenCalledTimes(2); expect(r.documents.isDirty(id)).toBe(false);
});

it("does not let a late provider save change the new local identity after Save As", async () => {
  const r = rig(); const id = r.documents.openVirtual("memory:///write", "saved", "plaintext");
  let finish: (() => void) | undefined;
  r.documents.setVirtualSaver(() => new Promise<void>(resolve => { finish = resolve; }));
  r.buffers.setValue(id, "provider write"); const pending = r.documents.save(id);
  vi.mocked(r.ipc.saveDocumentDialog).mockResolvedValueOnce("/tmp/export.txt");
  r.buffers.setValue(id, "local export"); await r.documents.saveAs(id);
  finish?.(); await pending;
  expect(r.documents.snapshot(id)).toMatchObject({ path: "/tmp/export.txt", dirty: false });
  expect(r.documents.savedText(id)).toBe("local export");
  expect(r.documents.isVirtual(id)).toBe(false);
});

it("preserves existing recovery data when reading the database fails", async () => {
  const saved = JSON.stringify({ version: 2, activeGroup: 0, weights: [1], groups: [{ tabs: [] }] });
  const r = rig(new Map([["editor.layout", saved]]));
  vi.mocked(r.ipc.settingsGet).mockRejectedValueOnce(Error("database unavailable"));
  await r.workspace.restoreSession();
  r.documents.createUntitled("keep this open");
  expect(await r.workspace.flushSession()).toBe(false);
  expect(r.settings.get("editor.layout")).toBe(saved);
  expect(r.ipc.settingsSet).not.toHaveBeenCalled();
});

it("autosaves an already dirty recovered provider buffer when the workbench starts", async () => {
  vi.useFakeTimers();
  const r = rig();
  const id = r.documents.restoreBuffer({ uri: "memory:///recovered", kind: "virtual", text: "recovered edits", savedText: "old", language: "plaintext", readonly: false });
  const save = vi.fn().mockResolvedValue(undefined); r.documents.setVirtualSaver(save);
  autosave(r, "afterDelay"); await vi.advanceTimersByTimeAsync(150);
  expect(save).toHaveBeenCalledWith("memory:///recovered", "recovered edits");
  expect(r.documents.isDirty(id)).toBe(false);
});
