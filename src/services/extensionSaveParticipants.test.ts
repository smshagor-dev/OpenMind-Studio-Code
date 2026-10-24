import { createRequire } from "node:module";
import { expect, it, vi } from "vitest";
import { BufferManager } from "./bufferManager";
import { DocumentService } from "./documentService";
import { HostDocumentSync } from "./extensionHostSync";
import { ExtensionEditorService } from "./extensionEditorService";
import { createWorkbenchAutoSave } from "./autoSaveService";
import { ExtensionSaveParticipants } from "./extensionSaveParticipants";
import type { EditorService } from "./editorService";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import { createFakeIpc } from "../testUtils/fakeIpcClient";
const require = createRequire(import.meta.url);
interface Host { request(method: string, params?: unknown): Promise<unknown>; notify(method: string, params?: unknown): void }
const { fixture } = require("../../crates/extensions/tests/node/rpc-fixture.cjs") as { fixture: (t: { after(callback: () => Promise<void>): void }, definitions: Record<string, { code: string; permissions: string[] }>) => Promise<Host> };
const path = "/workspace/save.txt";
const edit = { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0, text: "prefix:" };
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function rig(request: (params: unknown) => Promise<unknown>, timeoutMs = 1750) {
  const buffers = new BufferManager(); const events = new EventBus<AppEvents>();
  const ipc = createFakeIpc({ documentOpen: vi.fn().mockResolvedValue({ path, content: "body", encoding: "utf8", lineEnding: "lf" }) });
  const documents = new DocumentService(ipc, buffers, events); const id = await documents.openFromPath(path);
  const sync = new HostDocumentSync({ documents, events, notify: vi.fn() }); sync.initial(); sync.start();
  const editor = new ExtensionEditorService({ documents, sync, editor: {} as EditorService, hasTextTab: () => true });
  const applyEdits = vi.fn((params: unknown) => editor.applyEdits(params));
  const service = new ExtensionSaveParticipants({ documents, sync, isRunning: () => true, request, applyEdits, timeoutMs });
  documents.setSaveParticipant((id, reason) => service.run(id, reason));
  return { buffers, events, ipc, documents, id, sync, service, applyEdits, close: () => { sync.stop(); buffers.disposeAll(); } };
}
it("saves current text after a bounded timeout and never applies a late reply", async () => {
  const pending = deferred<unknown>(); const r = await rig(() => pending.promise, 10);
  try {
    r.buffers.setValue(r.id, "new text"); await r.documents.save(r.id);
    expect(r.ipc.documentSave).toHaveBeenCalledWith(path, "new text", "utf8");
    pending.resolve({ files: [{ path, version: 2, edits: [edit] }] }); await Promise.resolve(); await Promise.resolve();
    expect(r.applyEdits).not.toHaveBeenCalled(); expect(r.documents.contentOf(r.id)).toBe("new text");
  } finally { r.close(); }
});
it("discards stale replies after typing or host reset and rejects other-document edits", async () => {
  for (const kind of ["typing", "reset", "other"] as const) {
    const pending = deferred<unknown>(); const r = await rig(() => pending.promise);
    try {
      const saving = r.documents.save(r.id);
      await Promise.resolve();
      if (kind === "typing") r.buffers.setValue(r.id, "typed while waiting");
      if (kind === "reset") r.service.reset();
      pending.resolve({ files: [{ path: kind === "other" ? "/other" : path, version: 1, edits: [edit] }] }); await saving;
      expect(r.documents.contentOf(r.id)).toBe(kind === "typing" ? "typed while waiting" : "body");
    } finally { r.close(); }
  }
});
it("keeps malformed or conflicting edits atomic and still permits saving", async () => {
  const r = await rig(() => Promise.resolve({ files: [{ path, version: 2, edits: [{ ...edit, endColumn: 3 }, { ...edit, startColumn: 1, endColumn: 2 }] }] }));
  try { r.buffers.setValue(r.id, "body modified"); await r.documents.save(r.id); expect(r.documents.contentOf(r.id)).toBe("body modified"); expect(r.applyEdits).toHaveBeenCalledOnce(); expect(r.applyEdits.mock.results[0]?.value).toMatchObject({ applied: false }); } finally { r.close(); }
});
it("runs save contributions for untitled Save As and writable virtual documents", async () => {
  const r = await rig(() => Promise.resolve({ files: [] })); const participant = vi.fn().mockResolvedValue(undefined); r.documents.setSaveParticipant(participant);
  try {
    const untitled = r.documents.createUntitled("draft"); vi.mocked(r.ipc.saveDocumentDialog).mockResolvedValue("/workspace/new.txt"); await r.documents.save(untitled, { reason: 1 });
    expect(participant).toHaveBeenCalledWith(untitled, 1);
    const virtual = r.documents.openVirtual("test://host/file", "virtual", "plaintext", false); r.documents.setVirtualSaver(() => Promise.resolve());
    await r.documents.save(virtual, { reason: 2 }); expect(participant).toHaveBeenCalledWith(virtual, 2);
  } finally { r.close(); }
});
it("does not dispatch for cancelled Save As and never blocks saving when a hook rejects", async () => {
  const r = await rig(() => Promise.resolve({ files: [] })); const participant = vi.fn().mockRejectedValue(new Error("failure")); r.documents.setSaveParticipant(participant);
  try {
    const untitled = r.documents.createUntitled("draft"); vi.mocked(r.ipc.saveDocumentDialog).mockResolvedValue(null); await r.documents.save(untitled); expect(participant).not.toHaveBeenCalled();
    r.buffers.setValue(r.id, "preserved"); await r.documents.save(r.id); expect(r.ipc.documentSave).toHaveBeenCalledWith(path, "preserved", "utf8");
  } finally { r.close(); }
});
it("applies real stdio host save edits to Monaco before disk write and didSave delivery", async () => {
  const cleanups: (() => Promise<void>)[] = []; let host: Host | undefined;
  const r = await rig(params => { if (!host) throw new Error("Host not initialized"); return host.request("host/willSaveDocument", params); });
  // Forward this real document's lifecycle to the actual host.
  r.sync.stop(); const sync = new HostDocumentSync({ documents: r.documents, events: r.events, notify: (method, params) => { host?.notify(method, params); } });
  const editor = new ExtensionEditorService({ documents: r.documents, sync, editor: {} as EditorService, hasTextTab: () => true });
  const service = new ExtensionSaveParticipants({ documents: r.documents, sync, isRunning: () => true, request: params => { if (!host) throw new Error("Host not initialized"); return host.request("host/willSaveDocument", params); }, applyEdits: params => editor.applyEdits(params) });
  r.documents.setSaveParticipant((id, reason) => service.run(id, reason));
  try {
    host = await fixture({ after: callback => { cleanups.push(callback); } }, { "test.save": { permissions: ["commands", "workspaceRead", "workspaceWrite"], code: `const v=require('vscode');const events=[];exports.activate=()=>{v.workspace.onWillSaveTextDocument(e=>{events.push('will:'+e.reason+':'+e.document.getText());e.waitUntil(Promise.resolve([v.TextEdit.insert(new v.Position(0,0),'prefix:')]));});v.workspace.onDidSaveTextDocument(d=>events.push('saved:'+d.getText()));v.commands.registerCommand('events',()=>events);};` } });
    await host.request("host/init", sync.initial()); sync.start(); await host.request("host/activate", { id: "test.save" });
    await r.documents.save(r.id);
    expect(r.ipc.documentSave).toHaveBeenCalledWith(path, "prefix:body", "utf8"); expect(r.documents.isDirty(r.id)).toBe(false);
    expect(await host.request("host/executeCommand", { command: "events" })).toEqual(["will:1:body", "saved:prefix:body"]);
  } finally { sync.stop(); r.close(); for (const close of cleanups.reverse()) await close(); }
});

it("does not write or apply a reply after the document has closed", async () => {
  const pending = deferred<unknown>(); const r = await rig(() => pending.promise);
  try {
    const saving = r.documents.save(r.id); await Promise.resolve(); r.documents.close(r.id);
    pending.resolve({ files: [{ path, version: 1, edits: [edit] }] }); await saving;
    expect(r.ipc.documentSave).not.toHaveBeenCalled(); expect(r.applyEdits).not.toHaveBeenCalled();
  } finally { r.close(); }
});
it("propagates after-delay and focus-out reasons from workbench autosave", async () => {
  vi.useFakeTimers(); const r = await rig(() => Promise.resolve({ files: [] })); let mode = "afterDelay";
  const participant = vi.fn().mockResolvedValue(undefined); r.documents.setSaveParticipant(participant);
  const service = createWorkbenchAutoSave({ events: r.events, documents: r.documents,
    settings: { string: () => mode, number: () => 10, set: () => Promise.resolve(), onChange: () => () => undefined },
    workspace: { getState: () => ({ activeId: r.id }), save: (id, options) => r.documents.save(id, options), subscribe: () => () => undefined } });
  try {
    r.buffers.setValue(r.id, "delay"); service.start(); await vi.advanceTimersByTimeAsync(200);
    expect(participant).toHaveBeenCalledWith(r.id, 2); service.stop(); participant.mockClear();
    mode = "onWindowChange"; r.buffers.setValue(r.id, "focus"); service.start(); window.dispatchEvent(new Event("blur")); await vi.runAllTimersAsync();
    expect(participant).toHaveBeenCalledWith(r.id, 3);
  } finally { service.stop(); r.close(); vi.useRealTimers(); }
});
