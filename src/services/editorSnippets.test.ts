import * as monaco from "monaco-editor";
import { expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { EditorService } from "./editorService";

it("inserts native snippets into two ranges, links placeholders, navigates and undoes", () => {
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
    expect(service.insertSnippetFor(model.uri.toString(), "${1:name}=$1$0", [
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
    expect(service.insertSnippetFor(model.uri.toString(), "${1:x}$0", undefined, {}, id)).toBe(true);
    expect(model.getValue()).toBe("x x");
    void model.undo();
    expect(model.getValue()).toBe("one two");
    editor.updateOptions({ readOnly: true });
    expect(service.insertSnippetFor(model.uri.toString(), "blocked", undefined, {}, id)).toBe(false);
    expect(model.getValue()).toBe("one two");
    const insert = vi.spyOn(controller as unknown as { insert(): void }, "insert");
    expect(service.insertSnippetFor(model.uri.toString(), "late", undefined, {}, "stale-pane")).toBe(false);
    expect(insert).not.toHaveBeenCalled();
  } finally {
    detach(); editor.dispose(); model.dispose(); element.remove();
  }
});
