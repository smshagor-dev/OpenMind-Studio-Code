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

it("recovers unsaved native files with their encoding and baseline without writing to disk", async () => {
  const first = rig();
  vi.mocked(first.ipc.documentOpen).mockResolvedValueOnce({ path: "/tmp/local.txt", content: "original\r\n", encoding: "utf16-le", lineEnding: "crlf" });
  const id = await first.documents.openFromPath("/tmp/local.txt");
  first.workspace.openDocument(id, "text"); first.workspace.splitRight();
  first.buffers.setValue(id, "unsaved বাংলা\r\n");
  await first.workspace.flushSession();
  const again = rig(new Map(first.settings));
  vi.mocked(again.ipc.documentRead).mockResolvedValue({ state: "file", content: "original\r\n", encoding: "utf16-le", lineEnding: "crlf" });
  await again.workspace.restoreSession();
  const recovered = again.documents.idForPath("/tmp/local.txt");
  if (!recovered) throw Error("Missing recovered file");
  expect(again.documents.contentOf(recovered)).toBe("unsaved বাংলা\r\n");
  expect(again.documents.savedText(recovered)).toBe("original\r\n");
  expect(again.documents.snapshot(recovered)).toMatchObject({ encoding: "utf16-le", dirty: true, external: "none" });
  expect(again.groups.tabsForDoc(recovered)).toHaveLength(2);
  expect(again.ipc.documentOpen).not.toHaveBeenCalled();
  expect(again.ipc.documentSave).not.toHaveBeenCalled();
  await again.documents.save(recovered);
  expect(again.ipc.documentSave).toHaveBeenCalledWith("/tmp/local.txt", "unsaved বাংলা\r\n", "utf16-le");
  await again.workspace.flushSession();
  expect(parseLayout(again.settings.get("editor.layout") ?? "")?.buffers).toBeUndefined();
});

it("keeps recovered file edits separate from changed disk text until the user resolves the conflict", async () => {
  const r = rig();
  vi.mocked(r.ipc.documentRead).mockResolvedValueOnce({ state: "file", content: "someone else's change", encoding: "utf8", lineEnding: "lf" });
  const id = await r.documents.restoreFileBuffer({ uri: "/tmp/conflict.txt", kind: "file", text: "my edits", savedText: "original", language: "plaintext", readonly: false, encoding: "utf8", lineEnding: "lf" });
  expect(r.documents.contentOf(id)).toBe("my edits");
  expect(r.documents.diskContentOf(id)).toBe("someone else's change");
  expect(r.documents.externalState(id)).toBe("changed");
  await expect(r.documents.save(id)).rejects.toThrow("differs from disk");
  vi.mocked(r.ipc.saveDocumentDialog).mockResolvedValueOnce("/tmp/conflict.txt");
  await expect(r.documents.saveAs(id)).rejects.toThrow("disk conflict");
  expect(r.ipc.documentSave).not.toHaveBeenCalled();
  r.documents.keepMine(id);
  await r.documents.save(id);
  expect(r.ipc.documentSave).toHaveBeenCalledWith("/tmp/conflict.txt", "my edits", "utf8");
});

it("allows a recovered conflict to be exported to another path without touching the original", async () => {
  const r = rig();
  vi.mocked(r.ipc.documentRead).mockResolvedValueOnce({ state: "file", content: "changed on disk", encoding: "utf8", lineEnding: "lf" });
  const id = await r.documents.restoreFileBuffer({ uri: "/tmp/original.txt", kind: "file", text: "recovered", savedText: "old disk", language: "plaintext", readonly: false, encoding: "utf8", lineEnding: "lf" });
  vi.mocked(r.ipc.saveDocumentDialog).mockResolvedValueOnce("/tmp/copy.txt");
  await r.documents.saveAs(id);
  expect(r.ipc.documentSave).toHaveBeenCalledExactlyOnceWith("/tmp/copy.txt", "recovered", "utf8");
  expect(r.documents.snapshot(id)).toMatchObject({ path: "/tmp/copy.txt", external: "none", dirty: false });
});

it.each(["missing", "unreadable"])("retains recovered native text when the disk file is %s", async state => {
  const r = rig();
  vi.mocked(r.ipc.documentRead).mockResolvedValueOnce(state === "missing" ? { state: "missing" } : { state: "unreadable", reason: "permission denied" });
  const id = await r.documents.restoreFileBuffer({ uri: "/tmp/unavailable.txt", kind: "file", text: "keep these edits", savedText: "old", language: "plaintext", readonly: false, encoding: "utf8-bom", lineEnding: "lf" });
  expect(r.documents.contentOf(id)).toBe("keep these edits");
  expect(r.documents.externalState(id)).toBe(state === "missing" ? "deleted" : "changed");
  expect(r.ipc.documentSave).not.toHaveBeenCalled();
  if (state === "missing") {
    await r.documents.save(id);
    expect(r.ipc.documentSave).toHaveBeenCalledWith("/tmp/unavailable.txt", "keep these edits", "utf8-bom");
  } else await expect(r.documents.save(id)).rejects.toThrow("differs from disk");
});

it("preserves recovered EOL-only changes and protects against disk encoding changes", async () => {
  const r = rig();
  vi.mocked(r.ipc.documentRead).mockResolvedValueOnce({ state: "file", content: "one\r\ntwo", encoding: "utf8", lineEnding: "crlf" });
  const id = await r.documents.restoreFileBuffer({ uri: "/tmp/eol.txt", kind: "file", text: "one\ntwo", savedText: "one\r\ntwo", language: "plaintext", readonly: false, encoding: "utf8", lineEnding: "crlf" });
  expect(r.documents.isDirty(id)).toBe(true);
  expect(r.documents.externalState(id)).toBe("none");
  vi.mocked(r.ipc.documentRead).mockResolvedValueOnce({ state: "file", content: "old", encoding: "utf16-be", lineEnding: "lf" });
  const changed = await r.documents.restoreFileBuffer({ uri: "/tmp/encoding.txt", kind: "file", text: "new", savedText: "old", language: "plaintext", readonly: false, encoding: "utf8", lineEnding: "lf" });
  expect(r.documents.externalState(changed)).toBe("changed");
  await expect(r.documents.save(changed)).rejects.toThrow("differs from disk");
});

it("treats an externally saved matching recovered buffer as clean and never replaces a newer open buffer", async () => {
  const r = rig();
  vi.mocked(r.ipc.documentRead).mockResolvedValueOnce({ state: "file", content: "already saved", encoding: "utf8", lineEnding: "lf" });
  const saved = { uri: "/tmp/matching.txt", kind: "file" as const, text: "already saved", savedText: "old", language: "plaintext", readonly: false, encoding: "utf8" as const, lineEnding: "lf" as const };
  const id = await r.documents.restoreFileBuffer(saved);
  expect(r.documents.isDirty(id)).toBe(false);
  r.buffers.setValue(id, "newer in memory");
  expect(await r.documents.restoreFileBuffer(saved)).toBe(id);
  expect(r.documents.contentOf(id)).toBe("newer in memory");
  expect(r.ipc.documentRead).toHaveBeenCalledTimes(1);
});

it("does not autosave a recovered disk conflict and retries after an explicit Keep My Changes", async () => {
  vi.useFakeTimers();
  const r = rig();
  vi.mocked(r.ipc.documentRead).mockResolvedValueOnce({ state: "file", content: "theirs", encoding: "utf8", lineEnding: "lf" });
  const id = await r.documents.restoreFileBuffer({ uri: "/tmp/protected.txt", kind: "file", text: "mine", savedText: "original", language: "plaintext", readonly: false, encoding: "utf8", lineEnding: "lf" });
  autosave(r, "afterDelay"); await vi.advanceTimersByTimeAsync(1000);
  expect(r.ipc.documentSave).not.toHaveBeenCalled();
  r.documents.keepMine(id); await vi.advanceTimersByTimeAsync(150);
  expect(r.ipc.documentSave).toHaveBeenCalledWith("/tmp/protected.txt", "mine", "utf8");
});

it("backs up later native edits after the debounce and removes their snapshot after a successful save", async () => {
  vi.useFakeTimers();
  const r = rig();
  vi.mocked(r.ipc.documentOpen).mockResolvedValueOnce({ path: "/tmp/debounce.txt", content: "disk", encoding: "utf8", lineEnding: "lf" });
  const id = await r.documents.openFromPath("/tmp/debounce.txt");
  r.workspace.openDocument(id, "text", { preview: false });
  await r.workspace.flushSession();
  r.buffers.setValue(id, "later edit");
  await vi.advanceTimersByTimeAsync(350);
  expect(parseLayout(r.settings.get("editor.layout") ?? "")?.buffers?.[0]).toMatchObject({ kind: "file", text: "later edit" });
  expect(r.ipc.documentSave).not.toHaveBeenCalled();
  await r.documents.save(id); await vi.advanceTimersByTimeAsync(350);
  expect(parseLayout(r.settings.get("editor.layout") ?? "")?.buffers).toBeUndefined();
});

it("makes an unsaved native buffer that had no tab discoverable after recovery", async () => {
  const r = rig();
  vi.mocked(r.ipc.documentOpen).mockResolvedValueOnce({ path: "/tmp/hidden.txt", content: "disk", encoding: "utf8", lineEnding: "lf" });
  const id = await r.documents.openFromPath("/tmp/hidden.txt"); r.buffers.setValue(id, "hidden unsaved text");
  await r.workspace.flushSession();
  const again = rig(new Map(r.settings));
  vi.mocked(again.ipc.documentRead).mockResolvedValueOnce({ state: "file", content: "disk", encoding: "utf8", lineEnding: "lf" });
  await again.workspace.restoreSession();
  expect(again.workspace.getState().tabs).toContainEqual(expect.objectContaining({ path: "/tmp/hidden.txt", dirty: true, preview: false }));
  expect(again.ipc.documentSave).not.toHaveBeenCalled();
});
