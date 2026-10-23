import { createRequire } from "node:module";
import * as monaco from "monaco-editor";
import { afterEach, expect, it, vi } from "vitest";
import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { BufferManager } from "./bufferManager";
import { DocumentService } from "./documentService";
import { EditorService } from "./editorService";
import { EditorGroupService } from "./editorGroupService";
import { WorkspaceService } from "./workspaceService";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import { HostDocumentSync } from "./extensionHostSync";
import { ExtensionEditorService } from "./extensionEditorService";
import { ExtensionDocumentOpening } from "./extensionDocumentOpening";
import { HostBridge, type BridgeDeps } from "./extensionHostBridge";

interface Host {
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  onNotification(listener: (value: { method: string; params: Record<string, unknown> }) => void): () => void;
}
const require = createRequire(import.meta.url);
const { fixture } = require("../../crates/extensions/tests/node/rpc-fixture.cjs") as {
  fixture: (t: { after(fn: () => Promise<void>): void }, definitions: Record<string, { code: string; permissions: string[] }>, options: { handleRequest(method: string, params: unknown): Promise<unknown> }) => Promise<Host>;
};
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const off of cleanups.splice(0).reverse()) await off(); });

function rig() {
  const ipc = createFakeIpc({ saveDocumentDialog: vi.fn().mockResolvedValue("/tmp/saved.md") });
  const events = new EventBus<AppEvents>(), buffers = new BufferManager(), groups = new EditorGroupService();
  const documents = new DocumentService(ipc, buffers, events), editor = new EditorService(ipc);
  const workspace = new WorkspaceService(documents, ipc, events, { groups });
  const notifications: { method: string; params: unknown }[] = [];
  let host: Host | undefined;
  const sync = new HostDocumentSync({ documents, events,
    notify: (method, params) => { notifications.push({ method, params }); host?.notify(method, params); },
    visibleEditors: () => editor.snapshotEditors().flatMap(value => {
      const id = documents.idForModelUri(value.uri);
      return id ? [{ ...value, path: documents.hostPath(id), active: value.groupId === groups.getState().activeGroupId }] : [];
    }), currentActiveId: () => groups.activeTab()?.docId ?? null, onSelectionChange: fn => editor.subscribe(fn) });
  const panes = new Map<string, { native: monaco.editor.IStandaloneCodeEditor; off: () => void; element: HTMLDivElement }>();
  const off = groups.subscribe(() => {
    for (const group of groups.getState().groups) {
      const model = group.activeTabId ? buffers.get(group.activeTabId) : undefined;
      if (!model) continue;
      const pane = panes.get(group.id);
      if (pane) { if (pane.native.getModel() !== model) pane.native.setModel(model); continue; }
      const element = document.createElement("div"); document.body.append(element);
      const native = monaco.editor.create(element, { model, dimension: { width: 600, height: 300 }, overviewRulerLanes: 0, minimap: { enabled: false } });
      const detach = editor.attach(native, { groupId: group.id, viewColumn: () => groups.getState().groups.findIndex(value => value.id === group.id) + 1 });
      native.updateOptions({ minimap: { enabled: false } });
      panes.set(group.id, { native, off: detach, element });
    }
  });
  const api = new ExtensionEditorService({ documents, editor, sync, hasTextTab: id => groups.tabsForDoc(id).some(value => value.tab.kind === "text") });
  const opening = new ExtensionDocumentOpening({ documents, editor, groups, workspace });
  cleanups.push(() => { opening.reset(); api.resetDecorations(); off(); sync.stop(); for (const pane of panes.values()) { pane.off(); pane.native.dispose(); pane.element.remove(); } workspace.dispose(); buffers.disposeAll(); });
  return { ipc, documents, buffers, groups, workspace, sync, api, opening, notifications,
    connect(value: Host) { host = value; sync.start(); } };
}

it("runs untitled creation, show, edits, snippets, decorations and Save As through a real stdio extension host", async () => {
  const r = rig();
  const bridge = new HostBridge({
    createUntitled: (content, language) => { const id = r.documents.createUntitled(content, language); const data = r.sync.describe(id); if (!data) throw Error("missing document"); return data; },
    showTextDocument: (path, options, context) => r.opening.show(path, options, context),
    editorApi: r.api,
    saveDocument: async path => { const id = r.documents.idForHostPath(path); if (!id) return false; await r.documents.save(id); return r.documents.snapshot(id).path !== null && !r.documents.isDirty(id); },
  } as BridgeDeps);
  const host = await fixture({ after: fn => cleanups.push(fn) }, { "test.untitled": { permissions: ["commands", "workspaceRead", "workspaceWrite"], code: `
    const v=require('vscode');let doc,editor,type;exports.activate=()=>{
      v.commands.registerCommand('newUnsaved',async()=>{doc=await v.workspace.openTextDocument({content:'hello',language:'markdown'});editor=await v.window.showTextDocument(doc,{viewColumn:2});await editor.edit(b=>b.insert(new v.Position(0,5),'!'));await editor.insertSnippet(new v.SnippetString(' world'),new v.Position(0,6));type=v.window.createTextEditorDecorationType({color:'red'});editor.setDecorations(type,[new v.Range(0,0,0,5)]);return{uri:doc.uri.toString(),scheme:doc.uri.scheme,untitled:doc.isUntitled,dirty:doc.isDirty,text:doc.getText(),column:editor.viewColumn}});
      v.commands.registerCommand('saveUnsaved',async()=>{const saved=await doc.save();return{saved,oldClosed:doc.isClosed,oldText:doc.getText(),untitled:editor.document.isUntitled,file:editor.document.fileName,text:editor.document.getText(),dirty:editor.document.isDirty}});
      v.commands.registerCommand('editSaved',async()=>({applied:await editor.edit(b=>b.insert(new v.Position(0,0),'>')),text:editor.document.getText()}));
    };` } }, { handleRequest: (method, params) => bridge.handleRequest(method, params) });
  cleanups.push(host.onNotification(value => { if (value.method.startsWith("editor/")) bridge.handleNotification(value.method, value.params); }));
  r.connect(host);
  await host.request("host/activate", { id: "test.untitled" });
  const created = await host.request("host/executeCommand", { command: "newUnsaved" });
  expect(created).toMatchObject({ scheme: "untitled", untitled: true, dirty: true, text: "hello! world", column: 2 });
  const modelId = r.documents.allIds()[0];
  if (!modelId) throw Error("Missing model");
  expect(r.buffers.get(modelId)?.getAllDecorations().some(value => value.options.className?.startsWith("openmind-decoration-"))).toBe(true);
  expect(r.documents.languageOf(modelId)).toBe("markdown");
  expect(r.ipc.documentOpen).not.toHaveBeenCalled();
  expect(r.ipc.documentSave).not.toHaveBeenCalled();
  expect(await host.request("host/executeCommand", { command: "saveUnsaved" })).toEqual({ saved: true, oldClosed: true, oldText: "hello! world", untitled: false, file: "/tmp/saved.md", text: "hello! world", dirty: false });
  expect(r.ipc.documentSave).toHaveBeenCalledWith("/tmp/saved.md", "hello! world", "utf8");
  expect(await host.request("host/executeCommand", { command: "editSaved" })).toEqual({ applied: true, text: ">hello! world" });
});

it("keeps cancelled and failed saves untitled and dirty, and rejects collisions with another open document", async () => {
  const r = rig();
  const id = r.documents.createUntitled("unsaved");
  vi.mocked(r.ipc.saveDocumentDialog).mockResolvedValueOnce(null);
  await r.documents.save(id);
  expect(r.documents.snapshot(id)).toMatchObject({ path: null, dirty: true });
  vi.mocked(r.ipc.documentSave).mockRejectedValueOnce(Error("disk full"));
  await expect(r.documents.save(id)).rejects.toThrow("disk full");
  expect(r.documents.snapshot(id)).toMatchObject({ path: null, dirty: true });
  vi.mocked(r.ipc.documentOpen).mockResolvedValueOnce({ path: "/tmp/saved.md", content: "existing", encoding: "utf8", lineEnding: "lf" });
  await r.documents.openFromPath("/tmp/saved.md");
  await expect(r.documents.save(id)).rejects.toThrow("already open");
});

it("syncs preexisting untitled models and flushes final text before closing their identity", () => {
  const r = rig(); const id = r.documents.createUntitled("initial", "markdown");
  expect(r.sync.initial().documents).toContainEqual(expect.objectContaining({ path: r.documents.hostPath(id), isUntitled: true, text: "initial" }));
  r.sync.start(); r.buffers.setValue(id, "latest"); r.documents.close(id);
  const last = r.notifications.slice(-2);
  expect(last[0]).toMatchObject({ method: "host/documentChanged", params: { text: "latest", isUntitled: true } });
  expect(last[1]).toMatchObject({ method: "host/documentClosed", params: { path: `untitled://openmind/${id}` } });
  expect(r.documents.idForHostPath(`untitled://openmind/${id}`)).toBeNull();
});

it("allows workspace edits on an unshown untitled buffer without filesystem access", () => {
  const r = rig(); r.sync.start();
  const id = r.documents.createUntitled("hello");
  const path = r.documents.hostPath(id);
  expect(r.api.applyWorkspaceEdit({ files: [{ path, version: 1, edits: [{ startLine: 0, startColumn: 0, endLine: 0, endColumn: 5, text: "changed" }] }] })).toEqual({ applied: true });
  expect(r.documents.contentOf(id)).toBe("changed");
  expect(r.ipc.documentOpen).not.toHaveBeenCalled();
  expect(r.ipc.documentSave).not.toHaveBeenCalled();
});
