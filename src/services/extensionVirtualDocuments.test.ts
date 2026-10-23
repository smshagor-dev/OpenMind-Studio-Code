import { createRequire } from "node:module";
import { afterEach, expect, it } from "vitest";
import { waitFor } from "@testing-library/react";
import { BufferManager } from "./bufferManager";
import { DocumentService } from "./documentService";
import { WorkspaceService } from "./workspaceService";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import { HostBridge, type BridgeDeps } from "./extensionHostBridge";
import { createFakeIpc } from "../testUtils/fakeIpcClient";

interface Fixture {
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  messages: { method?: string; params: Record<string, unknown> }[];
  onNotification(listener: (message: { method: string; params: Record<string, unknown> }) => void): () => void;
}
const require = createRequire(import.meta.url);
const { fixture } = require("../../crates/extensions/tests/node/rpc-fixture.cjs") as {
  fixture(t: { after(callback: () => Promise<void>): void }, definitions: Record<string, { code: string; permissions: string[] }>): Promise<Fixture>;
};
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it("refreshes a real extension's virtual preview without changing focus or reopening a closed tab", async () => {
  const ipc = createFakeIpc(), events = new EventBus<AppEvents>(), buffers = new BufferManager();
  const workspace = new WorkspaceService(new DocumentService(ipc, buffers, events), ipc, events);
  cleanups.push(() => { workspace.dispose(); buffers.disposeAll(); });
  const host = await fixture({ after: callback => cleanups.push(callback) }, { "test.preview": { permissions: ["commands", "workspaceRead"], code: `
    const v = require('vscode'); const changes = new v.EventEmitter(); const uri = v.Uri.parse('generated:/preview.js'); let value = 'original';
    exports.activate = () => {
      v.workspace.registerTextDocumentContentProvider('generated', { onDidChange: changes.event, provideTextDocumentContent: () => value });
      v.commands.registerCommand('preview.open', () => v.window.showTextDocument(uri));
      v.commands.registerCommand('preview.change', text => { value = text; changes.fire(uri); });
      v.commands.registerCommand('preview.documents', () => v.workspace.textDocuments.length);
    };` } });
  workspace.filePreviews.onRelease(document => { if (document.model?.type === 'virtualText') host.notify('host/documentClosed', { path: document.path }); });
  const bridge = new HostBridge({
    showVirtualDocument: async request => { workspace.openVirtualDocument({ uri: request.uri, text: request.text, language: request.languageId, extension: request.extension, readonly: request.readonly }); },
    updateVirtualDocument: request => { workspace.updateVirtualDocument({ uri: request.uri, text: request.text, language: request.languageId, extension: request.extension, readonly: true }); },
  } as BridgeDeps);
  cleanups.push(host.onNotification(message => { if (message.method === "workspace/virtualDocumentChanged") bridge.handleNotification(message.method, message.params); }));
  await host.request('host/activate', { id: 'test.preview' }); await host.request('host/executeCommand', { command: 'preview.open' });
  const opening = host.messages.find(message => message.method === 'ui/showVirtualDocument'); if (!opening) throw new Error('Missing virtual document request');
  await bridge.handleRequest('ui/showVirtualDocument', opening.params);
  const uri = String(opening.params.uri);
  const id = workspace.filePreviews.virtualId(uri); if (id === null) throw new Error('Preview was not opened');
  expect(workspace.filePreviews.get(id)?.model).toMatchObject({ type: 'virtualText', text: 'original', readonly: true });
  const other = workspace.openVirtualDocument({ uri: 'other:/focus.txt', text: 'focused', language: 'plaintext', extension: 'test.other', readonly: true });
  expect(workspace.getState().activeId).toBe(other);
  await host.request('host/executeCommand', { command: 'preview.change', args: ['refreshed'] });
  await waitFor(() => expect(workspace.filePreviews.get(id)?.model).toMatchObject({ text: 'refreshed' }));
  expect(workspace.getState().activeId).toBe(other);
  const tab = workspace.getState().tabs.find(value => value.docId === id); if (!tab) throw new Error('Missing original tab');
  await workspace.close(tab.id);
  expect(workspace.filePreviews.virtualId(uri)).toBeNull();
  await waitFor(async () => expect(await host.request('host/executeCommand', { command: 'preview.documents' })).toBe(0));
  await host.request('host/executeCommand', { command: 'preview.change', args: ['closed update'] });
  expect(host.messages.some(message => message.method === 'workspace/virtualDocumentChanged' && message.params.text === 'closed update')).toBe(false);
  expect(workspace.filePreviews.virtualId(uri)).toBeNull(); expect(workspace.getState().activeId).toBe(other);
});
