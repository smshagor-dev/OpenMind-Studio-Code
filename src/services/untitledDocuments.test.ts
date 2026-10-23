import { virtualDocumentWrite } from "./extensionVirtualDocuments";
import { createRequire } from "node:module";
import * as monaco from "monaco-editor";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
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

// jsdom has no Worker; these tests exercise the editor and host, not Monaco's TypeScript worker.
const tsDefaults = monaco.typescript.typescriptDefaults;
const originalTsMode = tsDefaults.modeConfiguration;
beforeAll(() => { tsDefaults.setModeConfiguration({ ...originalTsMode, diagnostics: false, codeActions: false }); });
afterAll(() => { tsDefaults.setModeConfiguration(originalTsMode); });

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
      if (pane) { pane.native.updateOptions({ readOnly: documents.isReadOnly(group.activeTabId ?? "") }); if (pane.native.getModel() !== model) pane.native.setModel(model); continue; }
      const element = document.createElement("div"); document.body.append(element);
      const native = monaco.editor.create(element, { model, readOnly: documents.isReadOnly(group.activeTabId ?? ""), dimension: { width: 600, height: 300 }, overviewRulerLanes: 0, minimap: { enabled: false } });
      const detach = editor.attach(native, { groupId: group.id, viewColumn: () => groups.getState().groups.findIndex(value => value.id === group.id) + 1 });
      native.updateOptions({ minimap: { enabled: false } });
      panes.set(group.id, { native, off: detach, element });
    }
  });
  const api = new ExtensionEditorService({ documents, editor, sync, hasTextTab: id => groups.tabsForDoc(id).some(value => value.tab.kind === "text") });
  const opening = new ExtensionDocumentOpening({ documents, editor, groups, workspace });
  cleanups.push(() => { opening.reset(); api.resetDecorations(); off(); sync.stop(); for (const pane of panes.values()) { pane.off(); pane.native.dispose(); pane.element.remove(); } workspace.dispose(); buffers.disposeAll(); });
  return { ipc, documents, buffers, groups, workspace, sync, api, opening, notifications, panes, editor,
    connect(value: Host) { host = value; sync.start(); } };
}

it("runs untitled creation, show, edits, snippets, decorations and Save As through a real stdio extension host", async () => {
  const r = rig();
  const bridge = new HostBridge({
    createUntitled: (content, language, named) => { const id = r.documents.createUntitled(content, language, named); const data = r.sync.describe(id); if (!data) throw Error("missing document"); return data; },
    showTextDocument: (path, options, context) => r.opening.show(path, options, context),
    editorApi: r.api,
    saveDocument: async path => { const id = r.documents.idForHostPath(path); if (!id) return false; await r.documents.save(id); return r.documents.snapshot(id).path !== null && !r.documents.isDirty(id); },
  } as BridgeDeps);
  const host = await fixture({ after: fn => cleanups.push(fn) }, { "test.untitled": { permissions: ["commands", "workspaceRead", "workspaceWrite", "filesystemOutsideWorkspace"], code: `
    const v=require('vscode');let doc,editor,type;exports.activate=()=>{
      v.commands.registerCommand('newUnsaved',async()=>{doc=await v.workspace.openTextDocument({content:'hello',language:'markdown'});editor=await v.window.showTextDocument(doc,{viewColumn:2});await editor.edit(b=>b.insert(new v.Position(0,5),'!'));await editor.insertSnippet(new v.SnippetString(' world'),new v.Position(0,6));type=v.window.createTextEditorDecorationType({color:'red'});editor.setDecorations(type,[new v.Range(0,0,0,5)]);return{uri:doc.uri.toString(),scheme:doc.uri.scheme,untitled:doc.isUntitled,dirty:doc.isDirty,text:doc.getText(),column:editor.viewColumn}});
      v.commands.registerCommand('saveUnsaved',async()=>{const saved=await doc.save();return{saved,oldClosed:doc.isClosed,oldText:doc.getText(),untitled:editor.document.isUntitled,file:editor.document.fileName,text:editor.document.getText(),dirty:editor.document.isDirty}});
      v.commands.registerCommand('namedUnsaved',async()=>{const named=await v.workspace.openTextDocument(v.Uri.file('/tmp/named.ts').with({scheme:'untitled'}));const pane=await v.window.showTextDocument(named);await pane.edit(b=>b.insert(new v.Position(0,0),'let a=1;'));const language=named.languageId;const saved=await named.save();return{language,saved,oldClosed:named.isClosed,oldText:named.getText(),path:pane.document.fileName,untitled:pane.document.isUntitled}});
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
  expect(await host.request("host/executeCommand", { command: "namedUnsaved" })).toEqual({ language: "typescript", saved: true, oldClosed: true, oldText: "let a=1;", path: "/tmp/named.ts", untitled: false });
  expect(r.ipc.saveDocumentDialog).toHaveBeenCalledTimes(1);
  expect(r.ipc.documentSave).toHaveBeenLastCalledWith("/tmp/named.ts", "let a=1;", "utf8");
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

it("keeps associated untitled URI identity through pending edits and saves directly to its inferred-language path", async () => {
  const r = rig(); r.sync.start();
  const uri = "untitled:///tmp/named%20document.ts";
  const id = r.documents.createUntitled("", "plaintext", { uri, associatedPath: "/tmp/named document.ts" });
  expect(r.documents.createUntitled("", "plaintext", { uri, associatedPath: "/tmp/named document.ts" })).toBe(id);
  expect(r.documents.snapshot(id)).toMatchObject({ path: null, title: "named document.ts", dirty: true });
  expect(r.documents.languageOf(id)).toBe("typescript");
  expect(r.documents.hostPath(id)).toBe(uri);
  r.buffers.setValue(id, "const answer = 42;");
  await r.documents.save(id);
  expect(r.ipc.documentOpen).not.toHaveBeenCalled();
  expect(r.ipc.saveDocumentDialog).not.toHaveBeenCalled();
  expect(r.ipc.documentSave).toHaveBeenCalledWith("/tmp/named document.ts", "const answer = 42;", "utf8");
  const closed = r.notifications.findIndex(value => value.method === "host/documentClosed");
  expect(r.notifications[closed - 1]).toMatchObject({ method: "host/documentChanged", params: { path: uri, text: "const answer = 42;", isUntitled: true } });
  expect(r.notifications[closed]).toMatchObject({ params: { path: uri } });
  expect(r.notifications[closed + 1]).toMatchObject({ method: "host/documentOpened", params: { path: "/tmp/named document.ts" } });
  expect(r.documents.snapshot(id)).toMatchObject({ path: "/tmp/named document.ts", dirty: false });
  expect(r.documents.idForHostPath(uri)).toBeNull();
});

it("preserves named untitled identity on initial sync, failed save, and close, without assigning relative names to disk", async () => {
  const r = rig();
  const uri = "untitled:///tmp/broken.py";
  const id = r.documents.createUntitled("", "plaintext", { uri, associatedPath: "/tmp/broken.py" });
  expect(r.sync.initial().documents).toContainEqual(expect.objectContaining({ path: uri, isUntitled: true, languageId: "python", isDirty: true }));
  r.sync.start();
  vi.mocked(r.ipc.documentSave).mockRejectedValueOnce(Error("disk full"));
  await expect(r.documents.save(id)).rejects.toThrow("disk full");
  expect(r.documents.hostPath(id)).toBe(uri);
  r.documents.close(id);
  expect(r.notifications.at(-1)).toMatchObject({ method: "host/documentClosed", params: { path: uri } });
  const relative = r.documents.createUntitled("draft", "plaintext", { uri: "untitled:Draft.md" });
  expect(r.documents.languageOf(relative)).toBe("markdown");
  expect(r.documents.snapshot(relative).title).toBe("Draft.md");
  vi.mocked(r.ipc.saveDocumentDialog).mockResolvedValueOnce(null);
  await r.documents.save(relative);
  expect(r.documents.snapshot(relative)).toMatchObject({ path: null, dirty: true });
  expect(r.ipc.saveDocumentDialog).toHaveBeenCalledWith(undefined);
});

it("edits and saves a writable virtual provider through native Monaco and a real stdio host", async () => {
  const r = rig();
  const bridge = new HostBridge({
    openVirtualTextDocument: (uri, content, language, readonly, version) => {
      const id = r.documents.openVirtual(uri, content, language, readonly, version);
      const data = r.sync.describe(id); if (!data) throw Error("missing model"); return data;
    },
    showTextDocument: (path, options, context) => r.opening.show(path, options, context),
    editorApi: r.api,
    saveDocument: async path => {
      const id = r.documents.idForHostPath(path); if (!id) return false;
      await r.documents.save(id); return !r.documents.isDirty(id);
    },
  } as BridgeDeps);
  const host = await fixture({ after: fn => cleanups.push(fn) }, { "test.virtualEdit": { permissions: ["commands", "workspaceRead", "workspaceWrite"], code: `
    const v=require('vscode');let doc,editor,reads=0,writes=[],value='hello',fail=false,registration;const changes=new v.EventEmitter();
    exports.activate=()=>{
      registration=v.workspace.registerFileSystemProvider('editable',{onDidChangeFile:changes.event,stat:()=>({type:1,size:5,mtime:0,ctime:0}),readDirectory:()=>[],readFile:()=>{reads++;return Buffer.from(value)},writeFile:(uri,bytes)=>{if(fail)throw Error('provider failed');value=Buffer.from(bytes).toString('utf8');writes.push({uri:uri.toString(),value})}},{isReadonly:false});
      v.commands.registerCommand('virtualOpen',async()=>{
        const uri=v.Uri.parse('editable://store/test%20file.txt?revision=1');
        doc=await v.workspace.openTextDocument(uri);
        const changes=new v.WorkspaceEdit();changes.insert(doc.uri,new v.Position(0,5),'!');
        const unshownEdit=await v.workspace.applyEdit(changes);
        editor=await v.window.showTextDocument(doc,{viewColumn:2,preview:false});
        await editor.insertSnippet(new v.SnippetString(' বাংলা'),new v.Position(0,6));
        return{unshownEdit,text:doc.getText(),dirty:doc.isDirty,untitled:doc.isUntitled,column:editor.viewColumn};
      });
      v.commands.registerCommand('virtualSave',async()=>({saved:await doc.save(),text:doc.getText(),dirty:doc.isDirty,writes,reads}));
      v.commands.registerCommand('virtualRefresh',()=>{value='external';changes.fire([{type:v.FileChangeType.Changed,uri:doc.uri}])});
      v.commands.registerCommand('virtualFail',async()=>{await editor.edit(b=>b.insert(new v.Position(0,0),'>'));fail=true;return doc.save()});
      v.commands.registerCommand('virtualDispose',()=>registration.dispose());
      v.commands.registerCommand('virtualSnapshot',()=>({text:doc.getText(),dirty:doc.isDirty,closed:doc.isClosed}));
    };` } }, { handleRequest: (method, params) => bridge.handleRequest(method, params) });
  r.documents.setVirtualSaver(async (uri, content) => { await host.request("host/fs", virtualDocumentWrite(uri, content)); });
  r.connect(host);
  await host.request("host/activate", { id: "test.virtualEdit" });
  expect(await host.request("host/executeCommand", { command: "virtualOpen" })).toEqual({ unshownEdit: true, text: "hello! বাংলা", dirty: true, untitled: false, column: 2 });
  expect(await host.request("host/executeCommand", { command: "virtualSave" })).toEqual({ saved: true, text: "hello! বাংলা", dirty: false, reads: 1, writes: [{ uri: "editable://store/test%20file.txt?revision=1", value: "hello! বাংলা" }] });
  const refreshed = new Promise<void>(resolve => {
    cleanups.push(host.onNotification(value => {
      if (value.method === "workspace/virtualDocumentChanged") {
        r.documents.updateVirtual(String(value.params.uri), String(value.params.text));
        r.sync.flush(); resolve();
      }
    }));
  });
  await host.request("host/executeCommand", { command: "virtualRefresh" });
  await refreshed;
  expect(await host.request("host/executeCommand", { command: "virtualSnapshot" })).toEqual({ text: "external", dirty: false, closed: false });
  await expect(host.request("host/executeCommand", { command: "virtualFail" })).rejects.toThrow("provider failed");
  expect(await host.request("host/executeCommand", { command: "virtualSnapshot" })).toEqual({ text: ">external", dirty: true, closed: false });
  await host.request("host/executeCommand", { command: "virtualDispose" });
  await expect(host.request("host/executeCommand", { command: "virtualSave" })).rejects.toThrow("No file system provider");
  expect(r.ipc.documentOpen).not.toHaveBeenCalled();
  expect(r.ipc.documentSave).not.toHaveBeenCalled();
  expect(r.ipc.saveDocumentDialog).not.toHaveBeenCalled();
});

it("protects dirty virtual text from refresh and keeps edits made while a provider save is pending", async () => {
  const r = rig(); r.sync.start();
  const mixed = r.documents.openVirtual("editable:///mixed.txt", "one\r\ntwo\nthree", "plaintext");
  expect(r.documents.isDirty(mixed)).toBe(false);
  expect(r.documents.updateVirtual("editable:///mixed.txt", "new\nexternal\r\ntext")).toBe(true);
  expect(r.documents.isDirty(mixed)).toBe(false);
  const id = r.documents.openVirtual("editable:///draft.txt", "original", "plaintext");
  expect(r.notifications.some(value => value.method === "host/documentOpened" && (value.params as { isUntitled?: boolean }).isUntitled)).toBe(false);
  expect(r.documents.updateVirtual("editable:///draft.txt", "external")).toBe(true);
  r.buffers.setValue(id, "saving");
  expect(r.documents.updateVirtual("editable:///draft.txt", "overwrite")).toBe(false);
  let finish: (() => void) | undefined;
  r.documents.setVirtualSaver(() => new Promise<void>(resolve => { finish = resolve; }));
  const saved = r.documents.save(id);
  r.buffers.setValue(id, "newer");
  finish?.(); await saved;
  expect(r.documents.contentOf(id)).toBe("newer");
  expect(r.documents.isDirty(id)).toBe(true);
  expect(r.sync.initial().documents).toContainEqual(expect.objectContaining({ path: "editable:///draft.txt", text: "newer", virtual: true, native: true, isDirty: true }));
  vi.mocked(r.ipc.saveDocumentDialog).mockResolvedValueOnce(null);
  await r.documents.saveAs(id);
  r.documents.close(id);
  expect(r.notifications.at(-1)).toMatchObject({ method: "host/documentClosed", params: { path: "editable:///draft.txt" } });
});

it("Save All persists an edited virtual buffer even before it has a tab", async () => {
  const r = rig(); r.sync.start();
  const id = r.documents.openVirtual("editable:///hidden.txt", "before", "plaintext");
  const save = vi.fn().mockResolvedValue(undefined);
  r.documents.setVirtualSaver(save);
  r.buffers.setValue(id, "after");
  await r.workspace.saveAll();
  expect(save).toHaveBeenCalledWith("editable:///hidden.txt", "after");
  expect(r.documents.isDirty(id)).toBe(false);
  expect(r.ipc.documentSave).not.toHaveBeenCalled();
});

it("shows read-only content as a native editor without duplicate opens or a version reset, and refreshes it without allowing writes", async () => {
  const r = rig();
  const bridge = new HostBridge({
    openVirtualTextDocument: (uri, content, language, readonly, version) => {
      const id = r.documents.openVirtual(uri, content, language, readonly, version);
      const data = r.sync.describe(id); if (!data) throw Error("missing model"); return data;
    },
    showTextDocument: (path, options, context) => r.opening.show(path, options, context),
    editorApi: r.api,
  } as BridgeDeps);
  const host = await fixture({ after: fn => cleanups.push(fn) }, { "test.locked": { permissions: ["commands", "workspaceRead", "workspaceWrite"], code: `
    const v=require('vscode');let text='initial',doc,editor,opened=0;const changed=new v.EventEmitter();
    exports.activate=()=>{
      v.workspace.registerTextDocumentContentProvider('readonlytext',{onDidChange:changed.event,provideTextDocumentContent:()=>text});
      v.workspace.onDidOpenTextDocument(()=>opened++);
      v.commands.registerCommand('lockedOpen',async()=>{doc=await v.workspace.openTextDocument(v.Uri.parse('readonlytext:/locked.txt?keep=1#part'));return{version:doc.version,opened}});
      v.commands.registerCommand('lockedChange',value=>{text=value;changed.fire(doc.uri)});
      v.commands.registerCommand('lockedShow',async()=>{editor=await v.window.showTextDocument(doc,{viewColumn:2,preview:false,selection:new v.Range(0,0,0,4)});const type=v.window.createTextEditorDecorationType({color:'red'});editor.setDecorations(type,[new v.Range(0,0,0,4)]);return{same:editor.document===doc,text:doc.getText(),version:doc.version,opened,column:editor.viewColumn,selection:editor.selection.end.character,saved:await doc.save()}});
      v.commands.registerCommand('lockedEdit',()=>editor.edit(b=>b.insert(new v.Position(0,0),'bad')));
      v.commands.registerCommand('lockedSnippet',()=>editor.insertSnippet(new v.SnippetString('bad')));
      v.commands.registerCommand('lockedReopen',async()=>{const reopened=await v.workspace.openTextDocument(doc.uri);return{same:reopened===doc,oldClosed:doc.isClosed,oldText:doc.getText(),text:reopened.getText(),fileText:editor.document.getText()}});
      v.commands.registerCommand('lockedExportState',()=>({oldClosed:doc.isClosed,oldUntitled:doc.isUntitled,scheme:editor.document.uri.scheme,file:editor.document.fileName,text:editor.document.getText(),dirty:editor.document.isDirty}));
      v.commands.registerCommand('lockedState',()=>({text:doc.getText(),version:doc.version,dirty:doc.isDirty,opened,closed:doc.isClosed}));
    };` } }, { handleRequest: (method, params) => bridge.handleRequest(method, params) });
  let refreshDone: (() => void) | undefined;
  cleanups.push(host.onNotification(value => {
    if (value.method.startsWith("editor/")) bridge.handleNotification(value.method, value.params);
    if (value.method === "workspace/virtualDocumentChanged") {
      r.documents.updateVirtual(String(value.params.uri), String(value.params.text));
      r.sync.flush(); refreshDone?.(); refreshDone = undefined;
    }
  }));
  r.connect(host); await host.request("host/activate", { id: "test.locked" });
  expect(await host.request("host/executeCommand", { command: "lockedOpen" })).toEqual({ version: 1, opened: 1 });
  const before = new Promise<void>(resolve => { refreshDone = resolve; });
  await host.request("host/executeCommand", { command: "lockedChange", args: ["before showing"] }); await before;
  expect(await host.request("host/executeCommand", { command: "lockedShow" })).toEqual({ same: true, text: "before showing", version: 2, opened: 1, column: 2, selection: 4, saved: false });
  const id = r.documents.allIds()[0]; if (!id) throw Error("missing readonly model");
  const pane = [...r.panes.values()][0]; if (!pane) throw Error("missing readonly pane");
  expect(pane.native.getOption(monaco.editor.EditorOption.readOnly)).toBe(true);
  pane.native.trigger("keyboard", "type", { text: "cannot type" });
  expect(r.editor.insertAtCursor("cannot insert")).toBe(false);
  expect(r.editor.pasteText("cannot paste")).toBe(false);
  expect(await r.editor.copySelection(true)).toBe(false);
  expect(r.documents.contentOf(id)).toBe("before showing");
  expect(r.buffers.get(id)?.getAllDecorations().some(value => value.options.className?.startsWith("openmind-decoration-"))).toBe(true);
  await expect(host.request("host/executeCommand", { command: "lockedEdit" })).rejects.toThrow("read-only");
  await expect(host.request("host/executeCommand", { command: "lockedSnippet" })).rejects.toThrow("read-only");
  const after = new Promise<void>(resolve => { refreshDone = resolve; });
  await host.request("host/executeCommand", { command: "lockedChange", args: ["refreshed"] }); await after;
  expect(await host.request("host/executeCommand", { command: "lockedState" })).toEqual({ text: "refreshed", version: 3, dirty: false, opened: 1, closed: false });
  await r.workspace.saveAs(id);
  expect(await host.request("host/executeCommand", { command: "lockedExportState" })).toEqual({ oldClosed: true, oldUntitled: false, scheme: "file", file: "/tmp/saved.md", text: "refreshed", dirty: false });
  expect(r.ipc.documentSave).toHaveBeenCalledWith("/tmp/saved.md", "refreshed", "utf8");
  await host.request("host/executeCommand", { command: "lockedChange", args: ["new provider text"] });
  expect(await host.request("host/executeCommand", { command: "lockedReopen" })).toEqual({ same: false, oldClosed: true, oldText: "refreshed", text: "new provider text", fileText: "refreshed" });
  await r.workspace.close(id);
  expect(await host.request("host/executeCommand", { command: "lockedState" })).toMatchObject({ closed: true, text: "refreshed" });
});

it("preflights read-only virtual targets before any workspace edit and prevents service writes and saves", async () => {
  const r = rig(); r.sync.start();
  const writable = r.documents.openVirtual("editable:///write.txt", "original", "plaintext");
  const locked = r.documents.openVirtual("locked:///read.txt", "protected", "plaintext", true, 20);
  const save = vi.fn().mockResolvedValue(undefined); r.documents.setVirtualSaver(save);
  const edit = { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0, text: "bad" };
  expect(r.api.applyWorkspaceEdit({ files: [{ path: r.documents.hostPath(writable), version: 1, edits: [edit] }, { path: r.documents.hostPath(locked), version: 20, edits: [edit] }] })).toEqual({ applied: false, reason: "The virtual document is read-only." });
  expect(r.documents.contentOf(writable)).toBe("original");
  expect(r.documents.contentOf(locked)).toBe("protected");
  expect(() => { r.documents.replaceText(locked, "bad"); }).toThrow("read-only");
  expect(() => { r.documents.applyHostEdits(locked, [edit]); }).toThrow("read-only");
  await expect(r.documents.save(locked)).rejects.toThrow("read-only");
  expect(save).not.toHaveBeenCalled();
  expect(r.sync.initial().documents).toContainEqual(expect.objectContaining({ path: "locked:///read.txt", readonly: true, version: 20, isDirty: false }));
});

it("exports protected virtual text to a local file and changes its identity, language, and write permissions only after success", async () => {
  const r = rig(); r.sync.start();
  const uri = "generated:///report.txt?revision=1";
  const id = r.documents.openVirtual(uri, "provider text", "plaintext", true, 8);
  r.workspace.openDocument(id, "text");
  const providerSave = vi.fn(); r.documents.setVirtualSaver(providerSave);
  vi.mocked(r.ipc.saveDocumentDialog).mockResolvedValueOnce(null);
  await r.documents.saveAs(id);
  expect(r.documents.hostPath(id)).toBe(uri);
  expect(r.documents.isReadOnly(id)).toBe(true);
  expect(r.ipc.documentSave).not.toHaveBeenCalled();
  vi.mocked(r.ipc.documentSave).mockRejectedValueOnce(Error("disk full"));
  await expect(r.documents.saveAs(id)).rejects.toThrow("disk full");
  expect(r.documents.hostPath(id)).toBe(uri);
  expect(r.documents.isReadOnly(id)).toBe(true);
  await r.documents.saveAs(id);
  expect(r.ipc.saveDocumentDialog).toHaveBeenLastCalledWith("report.txt");
  expect(r.ipc.documentSave).toHaveBeenLastCalledWith("/tmp/saved.md", "provider text", "utf8");
  expect(providerSave).not.toHaveBeenCalled();
  expect(r.documents.isVirtual(id)).toBe(false);
  expect(r.documents.isReadOnly(id)).toBe(false);
  expect(r.documents.languageOf(id)).toBe("markdown");
  expect(r.sync.describe(id)).toMatchObject({ path: "/tmp/saved.md", version: 1, isDirty: false });
  expect(r.notifications).toContainEqual({ method: "host/documentClosed", params: { path: uri } });
  expect(r.api.applyWorkspaceEdit({ files: [{ path: "/tmp/saved.md", version: 1, edits: [{ startLine: 0, startColumn: 0, endLine: 0, endColumn: 0, text: "editable " }] }] })).toEqual({ applied: true });
  expect(r.documents.contentOf(id)).toBe("editable provider text");
});

it("prevents virtual Save As collisions and preserves edits made while the local write is pending", async () => {
  const r = rig(); r.sync.start();
  const id = r.documents.openVirtual("editable:///source.txt", "original", "plaintext");
  vi.mocked(r.ipc.documentOpen).mockResolvedValueOnce({ path: "/tmp/saved.md", content: "existing", encoding: "utf8", lineEnding: "lf" });
  const existing = await r.documents.openFromPath("/tmp/saved.md");
  await expect(r.documents.saveAs(id)).rejects.toThrow("already open");
  expect(r.ipc.documentSave).not.toHaveBeenCalled();
  expect(r.documents.contentOf(existing)).toBe("existing");
  expect(r.documents.isVirtual(id)).toBe(true);
  vi.mocked(r.ipc.saveDocumentDialog).mockResolvedValueOnce("/tmp/export.md");
  let finish: (() => void) | undefined;
  vi.mocked(r.ipc.documentSave).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const pending = r.documents.saveAs(id);
  await vi.waitFor(() => { expect(finish).toBeTypeOf("function"); });
  r.buffers.setValue(id, "newer text");
  finish?.(); await pending;
  expect(r.documents.snapshot(id)).toMatchObject({ path: "/tmp/export.md", dirty: true });
  expect(r.documents.contentOf(id)).toBe("newer text");
  expect(r.sync.describe(id)).toMatchObject({ path: "/tmp/export.md", text: "newer text", isDirty: true });
  expect(r.notifications.filter(value => value.method === "host/documentChanged").map(value => value.params)).toContainEqual(expect.objectContaining({ path: "editable:///source.txt", text: "newer text", virtual: true, isUntitled: false }));
});
