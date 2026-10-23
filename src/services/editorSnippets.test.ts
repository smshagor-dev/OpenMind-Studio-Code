import * as monaco from "monaco-editor";
import { expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { EditorService } from "./editorService";

it("inserts native snippets into two ranges, links placeholders, navigates and undoes", async () => {
  const element = document.createElement("div");
  document.body.append(element);
  const model = monaco.editor.createModel("one two");
  const editor = monaco.editor.create(element, { model, automaticLayout: false, dimension: { width: 600, height: 300 } });
  const service = new EditorService(createFakeIpc());
  const detach = service.attach(editor);
  try {
    const pane = service.snapshotEditors()[0];
    if (!pane) throw new Error("Expected a visible editor.");
    const id = pane.id;
    expect(await service.insertSnippetFor(model.uri.toString(), "${1:name}=$1$0", [
      { startLine: 0, startColumn: 0, endLine: 0, endColumn: 3 },
      { startLine: 0, startColumn: 4, endLine: 0, endColumn: 7 },
    ], { undoStopBefore: true, undoStopAfter: true }, id)).toBe(true);
    expect(model.getValue()).toBe("name=name name=name");
    expect(editor.getSelections()?.map(s => model.getValueInRange(s))).toEqual(["name", "name", "name", "name"]);
    const controller = editor.getContribution("snippetController2") as unknown as { next(): void };
    controller.next();
    expect(editor.getSelections()?.every(s => s.isEmpty())).toBe(true);
    void model.undo();
    expect(model.getValue()).toBe("one two");
    editor.setSelections([new monaco.Selection(1, 1, 1, 4), new monaco.Selection(1, 5, 1, 8)]);
    expect(await service.insertSnippetFor(model.uri.toString(), "${1:x}$0", undefined, {}, id)).toBe(true);
    expect(model.getValue()).toBe("x x");
    void model.undo();
    expect(model.getValue()).toBe("one two");
    editor.updateOptions({ readOnly: true });
    expect(await service.insertSnippetFor(model.uri.toString(), "blocked", undefined, {}, id)).toBe(false);
    expect(model.getValue()).toBe("one two");
    const insert = vi.spyOn(controller as unknown as { insert(): void }, "insert");
    expect(await service.insertSnippetFor(model.uri.toString(), "late", undefined, {}, "stale-pane")).toBe(false);
    expect(insert).not.toHaveBeenCalled();
  } finally {
    detach(); editor.dispose(); model.dispose(); element.remove();
  }
});

function clipboardRig() {
  const clipboardReadText = vi.fn().mockResolvedValue("first\nsecond");
  const service = new EditorService(createFakeIpc({ clipboardReadText }));
  const model = monaco.editor.createModel("a b"), element = document.createElement("div");
  document.body.append(element);
  const editor = monaco.editor.create(element, { model, dimension: { width: 600, height: 300 } });
  const detach = service.attach(editor);
  const pane = service.snapshotEditors()[0];
  if (!pane) throw Error("Expected editor");
  return { model, editor, service, clipboardReadText, id: pane.id,
    cleanup() { detach(); editor.dispose(); model.dispose(); element.remove(); } };
}

it("resolves native clipboard snippets, multiline cursor spreading, transforms and empty fallbacks", async () => {
  const r = clipboardRig();
  try {
    r.editor.setSelections([new monaco.Selection(1, 1, 1, 2), new monaco.Selection(1, 3, 1, 4)]);
    expect(await r.service.insertSnippetFor(r.model.uri.toString(), "${CLIPBOARD}$0", undefined, {}, r.id)).toBe(true);
    expect(r.model.getValue()).toBe("first second");
    expect(r.clipboardReadText).toHaveBeenCalledOnce();
    void r.model.undo();
    r.editor.setSelection(new monaco.Selection(1, 1, 1, 2));
    r.clipboardReadText.mockResolvedValueOnce("alpha");
    expect(await r.service.insertSnippetFor(r.model.uri.toString(), "${CLIPBOARD/(.*)/${1:/upcase}/}$0", undefined, {}, r.id)).toBe(true);
    expect(r.model.getValue()).toBe("ALPHA b");
    void r.model.undo();
    r.clipboardReadText.mockResolvedValueOnce("");
    r.editor.setSelection(new monaco.Selection(1, 1, 1, 2));
    expect(await r.service.insertSnippetFor(r.model.uri.toString(), "${CLIPBOARD:fallback}$0", undefined, {}, r.id)).toBe(true);
    expect(r.model.getValue()).toBe("fallback b");
    void r.model.undo();
    r.editor.setSelection(new monaco.Selection(1, 1, 1, 2));
    const before = r.clipboardReadText.mock.calls.length;
    expect(await r.service.insertSnippetFor(r.model.uri.toString(), "$CLIPBOARD", [], {}, r.id)).toBe(true);
    expect(r.clipboardReadText).toHaveBeenCalledTimes(before);
    expect(await r.service.insertSnippetFor(r.model.uri.toString(), "\\$CLIPBOARD", undefined, {}, r.id)).toBe(true);
    expect(r.model.getValue()).toBe("$CLIPBOARD b");
    expect(r.clipboardReadText).toHaveBeenCalledTimes(before);
    const unchanged = r.model.getValue();
    r.clipboardReadText.mockRejectedValueOnce(Error("Clipboard denied"));
    await expect(r.service.insertSnippetFor(r.model.uri.toString(), "$CLIPBOARD", undefined, {}, r.id)).rejects.toThrow("Clipboard denied");
    expect(r.model.getValue()).toBe(unchanged);
  } finally { r.cleanup(); }
});

it("refuses stale model, selection, pane and caller state after awaiting clipboard access", async () => {
  const r = clipboardRig();
  const other = monaco.editor.createModel("other");
  try {
    for (const change of ["model", "selection", "pane", "readonly", "caller"]) {
      r.model.setValue("a b"); r.editor.setModel(r.model); r.editor.updateOptions({ readOnly: false });
      r.editor.setSelection(new monaco.Selection(1, 1, 1, 2));
      const id = r.service.snapshotEditors()[0]?.id;
      let resolve: (text: string) => void = () => {};
      r.clipboardReadText.mockImplementationOnce(() => new Promise<string>(done => { resolve = done; }));
      let current = true;
      const pending = r.service.insertSnippetFor(r.model.uri.toString(), "$CLIPBOARD", undefined, {}, id, () => current);
      if (change === "model") r.model.applyEdits([{ range: new monaco.Range(1, 4, 1, 4), text: "!" }]);
      if (change === "selection") r.editor.setSelection(new monaco.Selection(1, 3, 1, 4));
      if (change === "pane") { r.editor.setModel(other); r.editor.setModel(r.model); }
      if (change === "readonly") r.editor.updateOptions({ readOnly: true });
      if (change === "caller") current = false;
      const expected = r.model.getValue(); resolve("PASTED");
      expect(await pending).toBe(false);
      expect(r.model.getValue()).toBe(expected);
    }
  } finally { r.cleanup(); other.dispose(); }
});

it("keeps explicit snippet ranges independent of cursor movement during clipboard reads", async () => {
  const r = clipboardRig();
  try {
    let resolve: (text: string) => void = () => {};
    r.clipboardReadText.mockImplementationOnce(() => new Promise<string>(done => { resolve = done; }));
    const pending = r.service.insertSnippetFor(r.model.uri.toString(), "$CLIPBOARD", [
      { startLine: 0, startColumn: 0, endLine: 0, endColumn: 1 },
    ], {}, r.id);
    r.editor.setSelection(new monaco.Selection(1, 3, 1, 4));
    resolve("chosen");
    expect(await pending).toBe(true);
    expect(r.model.getValue()).toBe("chosen b");
  } finally { r.cleanup(); }
});
