import * as monaco from "monaco-editor";
import { expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { BufferManager } from "./bufferManager";
import { DocumentService } from "./documentService";
import { EditorService } from "./editorService";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import { ExtensionDecorations } from "./extensionDecorations";

async function rig() {
  const ipc = createFakeIpc({ documentOpen: vi.fn().mockResolvedValue({ path: "/workspace/test.txt", content: "hello world", encoding: "utf8", lineEnding: "lf" }) });
  const buffers = new BufferManager();
  const documents = new DocumentService(ipc, buffers, new EventBus<AppEvents>());
  const id = await documents.openFromPath("/workspace/test.txt");
  const model = buffers.get(id);
  if (!model) throw Error("Expected model");
  const service = new EditorService(ipc);
  const elements = [document.createElement("div"), document.createElement("div")];
  const editors = elements.map(element => {
    document.body.append(element);
    return monaco.editor.create(element, { model, dimension: { width: 600, height: 300 } });
  });
  const detach = editors.map(editor => service.attach(editor));
  const decorations = new ExtensionDecorations(service, documents);
  const panes = service.snapshotEditors();
  const source = { extension: "test.decorations", key: "test.decorations:type" };
  const range = { startLine: 0, startColumn: 0, endLine: 0, endColumn: 5 };
  return { documents, model, service, decorations, editors, panes, source, range,
    set(index: number, values: unknown[]) {
      decorations.set({ ...source, path: "/workspace/test.txt", editorId: panes[index]?.id, decorations: values });
    },
    own() { return model.getAllDecorations().filter(d => d.options.className?.startsWith("openmind-decoration-")); },
    cleanup() { decorations.reset(); detach.forEach(off => { off(); }); editors.forEach(editor => { editor.dispose(); }); elements.forEach(element => { element.remove(); }); buffers.disposeAll(); },
  };
}

it("keeps split-pane decorations separate, renders attachments and strips trusted hover capabilities", async () => {
  const r = await rig();
  try {
    r.decorations.create({ ...r.source, options: { backgroundColor: "#ff0000", color: "#00ff00", rangeBehavior: 1,
      before: { contentText: "hint ", color: "#888888" }, dark: { backgroundColor: "#0000ff" } } });
    r.set(0, [{ range: r.range, hoverMessage: [{ value: "**hover**", isTrusted: true, supportHtml: true }] }]);
    r.set(1, [{ range: { ...r.range, startColumn: 6, endColumn: 11 }, renderOptions: { after: { contentText: " end" } } }]);
    expect(r.own()).toHaveLength(2);
    expect(r.own()[0]?.options.before?.content).toBe("hint ");
    expect(r.own()[0]?.options.hoverMessage).toEqual([{ value: "**hover**", isTrusted: false, supportHtml: false }]);
    expect(r.own()[1]?.options.after?.content).toBe(" end");
    expect(r.model.getValue()).toBe("hello world");
    const styles = [...document.querySelectorAll<HTMLStyleElement>("style[data-extension-decoration]")];
    expect(styles).toHaveLength(2);
    expect(styles[0]?.textContent).toContain('html[data-theme="dark"]');
    expect(styles[0]?.textContent).toContain("background-color: rgb(0, 0, 255)");
    r.set(0, [{ range: { startLine: 0, startColumn: 5, endLine: 0, endColumn: 5 } }]);
    expect(r.own().find(d => d.range.isEmpty())?.options.showIfCollapsed).toBe(true);
    r.set(0, []);
    expect(r.own()).toHaveLength(1);
    r.decorations.dispose({ ...r.source, extension: "other.extension" });
    expect(r.own()).toHaveLength(1);
    r.decorations.dispose(r.source);
    expect(r.own()).toHaveLength(0);
    expect(document.querySelectorAll("style[data-extension-decoration]")).toHaveLength(0);
  } finally { r.cleanup(); }
});

it("prevalidates every range, rejects stale panes and cleans up model switches, editors and host restarts", async () => {
  const r = await rig();
  const replacement = monaco.editor.createModel("replacement");
  try {
    r.decorations.create({ ...r.source, options: { color: "red" } });
    r.set(0, [{ range: r.range }, { range: r.range }]);
    expect(r.own()).toHaveLength(2); // Overlap is legal for decorations.
    expect(() => { r.set(0, [{ range: r.range }, { range: { ...r.range, endColumn: 1000 } }]); }).toThrow("outside the document");
    expect(r.own()).toHaveLength(2);
    r.decorations.set({ ...r.source, path: "/workspace/test.txt", editorId: "stale", decorations: [] });
    expect(r.own()).toHaveLength(2);
    r.editors[0]?.setModel(replacement);
    expect(r.own()).toHaveLength(0);
    expect(document.querySelectorAll("style[data-extension-decoration]")).toHaveLength(0);
    r.set(1, [{ range: r.range }]);
    r.editors[1]?.dispose();
    expect(r.own()).toHaveLength(0);
    expect(document.querySelectorAll("style[data-extension-decoration]")).toHaveLength(0);
    r.decorations.reset();
    r.set(1, [{ range: r.range }]);
    expect(r.own()).toHaveLength(0);
  } finally { r.cleanup(); replacement.dispose(); }
});

it("tracks edge growth natively and reuses styles across repeated ranges", async () => {
  const r = await rig();
  try {
    r.decorations.create({ ...r.source, options: { rangeBehavior: 1, color: { id: "editor.foreground" }, cursor: "url(https://example.invalid/cursor), auto" } });
    r.set(0, Array.from({ length: 100 }, () => ({ range: r.range })));
    const sheet = document.querySelector("style[data-extension-decoration]")?.textContent ?? "";
    expect(sheet).toContain("var(--vscode-editor-foreground)");
    expect(sheet).not.toContain("example.invalid");
    expect(new Set(sheet.match(/openmind-decoration-\d+/g)).size).toBe(1);
    const other = { ...r.source, key: "open-range" };
    r.decorations.create({ ...other, options: { rangeBehavior: 0, isWholeLine: true, overviewRulerColor: { id: "editorWarning.foreground" }, overviewRulerLane: 2 } });
    r.decorations.set({ ...other, path: "/workspace/test.txt", editorId: r.panes[1]?.id, decorations: [{ range: r.range }] });
    r.model.applyEdits([{ range: new monaco.Range(1, 1, 1, 1), text: "!" }]);
    const closed = r.own().find(d => d.options.stickiness === monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges);
    const open = r.own().find(d => d.options.stickiness === monaco.editor.TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges);
    expect(closed?.range).toEqual(new monaco.Range(1, 2, 1, 7));
    expect(open?.range).toEqual(new monaco.Range(1, 1, 1, 7));
    expect(open?.options.isWholeLine).toBe(true);
    expect(open?.options.overviewRuler?.color).toEqual({ id: "editorWarning.foreground" });
    r.decorations.reset();
    expect(r.own()).toHaveLength(0);
    expect(document.querySelectorAll("style[data-extension-decoration]")).toHaveLength(0);
  } finally { r.cleanup(); }
});
