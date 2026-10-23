import * as monaco from "monaco-editor";
import { expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { BufferManager } from "./bufferManager";
import { DocumentService } from "./documentService";
import { EditorGroupService } from "./editorGroupService";
import { EditorService } from "./editorService";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import { parseTextDocumentShowOptions } from "./extensionDocumentOptions";
import { ExtensionDocumentOpening } from "./extensionDocumentOpening";
import { PreviewEditorService } from "./previewEditorService";
import { WorkspaceService } from "./workspaceService";

function rig(mount = true) {
  const ipc = createFakeIpc({ documentOpen: vi.fn().mockImplementation((path: string) => Promise.resolve({ path, content: "hello world", encoding: "utf8", lineEnding: "lf" })) });
  const buffers = new BufferManager(), events = new EventBus<AppEvents>(), groups = new EditorGroupService();
  const documents = new DocumentService(ipc, buffers, events), editor = new EditorService(ipc), previews = new PreviewEditorService(ipc);
  const workspace = new WorkspaceService(documents, ipc, events, { groups, previews });
  const panes = new Map<string, { native: monaco.editor.IStandaloneCodeEditor; focus: ReturnType<typeof vi.spyOn>; detach: () => void; element: HTMLDivElement }>();
  const render = () => {
    for (const group of groups.getState().groups) {
      const model = group.activeTabId ? buffers.get(group.activeTabId) : null;
      if (!model) continue;
      const existing = panes.get(group.id);
      if (existing) { if (existing.native.getModel() !== model) existing.native.setModel(model); continue; }
      const element = document.createElement("div"); document.body.append(element);
      const native = monaco.editor.create(element, { model, dimension: { width: 600, height: 300 } });
      const focus = vi.spyOn(native, "focus");
      const detach = editor.attach(native, { groupId: group.id, active: () => groups.getState().activeGroupId === group.id,
        viewColumn: () => groups.getState().groups.findIndex(value => value.id === group.id) + 1 });
      native.onDidFocusEditorWidget(() => { groups.setActiveGroup(group.id); });
      panes.set(group.id, { native, focus, detach, element });
    }
  };
  const off = mount ? groups.subscribe(render) : () => {};
  const service = new ExtensionDocumentOpening({ documents, workspace, groups, editor });
  return { service, workspace, groups, editor, panes, previews, ipc,
    cleanup() { service.reset(); off(); for (const pane of panes.values()) { pane.detach(); pane.native.dispose(); pane.element.remove(); } workspace.dispose(); buffers.disposeAll(); } };
}

it("opens the requested split pane with selection and preview while preserving the previous focused group", async () => {
  const r = rig();
  try {
    await r.service.show("/workspace/old.txt", {});
    const left = r.groups.getState().activeGroupId, current = r.editor.current();
    const shown = await r.service.show("/workspace/new.txt", { viewColumn: 2, preserveFocus: true, preview: true,
      selection: { startLine: 0, startColumn: 1, endLine: 0, endColumn: 4 } });
    const right = r.groups.getState().groups[1];
    expect(r.groups.getState().activeGroupId).toBe(left);
    expect(r.editor.current()).toBe(current);
    expect(right?.tabs[0]?.preview).toBe(true);
    const pane = right && r.panes.get(right.id);
    expect(pane?.focus).not.toHaveBeenCalled();
    expect(pane?.native.getSelection()).toEqual(new monaco.Selection(1, 2, 1, 5));
    expect(r.editor.snapshotEditors().find(value => value.id === shown.editorId)?.groupId).toBe(right?.id);
    const first = await r.service.show("/workspace/new.txt", { viewColumn: 1 });
    expect(first.editorId).not.toBe(shown.editorId);
    expect(r.groups.getState().groups).toHaveLength(2);
    expect(r.panes.get(left)?.native.getModel()).toBe(pane?.native.getModel());
    expect(r.panes.get(left)?.focus).toHaveBeenCalled();
    await r.service.show("/workspace/new.txt", { viewColumn: 2, preserveFocus: true,
      selection: { startLine: 99, startColumn: 99, endLine: 99, endColumn: 99 } });
    expect(pane?.native.getSelection()).toEqual(new monaco.Selection(1, 12, 1, 12));
  } finally { r.cleanup(); }
});

it("supports Active, Beside and explicit columns through Nine and honors disabled preview editors", async () => {
  const r = rig();
  try {
    await r.previews.setEnabled(false);
    await r.service.show("/workspace/a.txt", {});
    await r.service.show("/workspace/b.txt", { viewColumn: -2, preview: true });
    expect(r.groups.getState().groups).toHaveLength(2);
    expect(r.groups.activeGroup().tabs[0]?.preview).toBe(false);
    await r.service.show("/workspace/c.txt", { viewColumn: -1 });
    expect(r.groups.getState().groups).toHaveLength(2);
    expect(r.groups.getState().activeGroupId).toBe(r.groups.getState().groups[1]?.id);
    await r.service.show("/workspace/nine.txt", { viewColumn: 9 });
    expect(r.groups.getState().groups).toHaveLength(9);
    await expect(r.service.show("/workspace/ten.txt", { viewColumn: -2 })).rejects.toThrow("No additional");
    expect(r.groups.getState().groups).toHaveLength(9);
  } finally { r.cleanup(); }
});

it("cancels only the owning request, cancels on host reset and refuses failed opens without extra groups", async () => {
  const r = rig(false);
  try {
    const pending = r.service.show("/workspace/wait.txt", { viewColumn: 2 }, { extension: "one", requestId: "show" });
    const rejected = expect(pending).rejects.toThrow("cancelled");
    await vi.waitFor(() => { expect(r.groups.getState().groups[1]?.activeTabId).toBeTruthy(); });
    r.service.cancel("other", "show");
    r.service.cancel("one", "show");
    await rejected;
    const closed = r.service.show("/workspace/closed.txt", { viewColumn: 2 }, { extension: "one", requestId: "closed" });
    const closedRejected = expect(closed).rejects.toThrow("closed before");
    await vi.waitFor(() => { expect(r.workspace.getState().tabs.some(tab => tab.path === "/workspace/closed.txt")).toBe(true); });
    const tab = r.groups.activeTab();
    if (!tab) throw Error("Expected a tab");
    await r.workspace.closeTab(r.groups.getState().activeGroupId, tab.id);
    await closedRejected;
    const reset = r.service.show("/workspace/reset.txt", {}, { extension: "one", requestId: "reset" });
    const resetRejected = expect(reset).rejects.toThrow();
    r.service.reset(); await resetRejected;
    const count = r.groups.getState().groups.length;
    vi.mocked(r.ipc.documentOpen).mockRejectedValueOnce(Error("unreadable"));
    await expect(r.service.show("/workspace/missing.txt", { viewColumn: 9 })).rejects.toThrow("unreadable");
    expect(r.groups.getState().groups).toHaveLength(count);
  } finally { r.cleanup(); }
});

it("rejects invalid wire options before opening files", () => {
  expect(() => parseTextDocumentShowOptions({ viewColumn: 10 })).toThrow("view column");
  expect(() => parseTextDocumentShowOptions({ preserveFocus: "true" })).toThrow("boolean");
  expect(() => parseTextDocumentShowOptions({ selection: { startLine: 0, startColumn: 2, endLine: 0, endColumn: 1 } })).toThrow("selection");
  expect(parseTextDocumentShowOptions({ viewColumn: -2, preview: false })).toEqual({ viewColumn: -2, preview: false });
});
