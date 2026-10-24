import * as monaco from "monaco-editor";
import { afterEach, expect, it } from "vitest";
import { EditorService } from "./editorService";
import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { parseEditorOptions } from "./extensionEditorOptions";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });
function rig() {
  const model = monaco.editor.createModel("one\n  two\n  three\n  four", "markdown");
  cleanup.push(() => { model.dispose(); });
  const service = new EditorService(createFakeIpc());
  const editors = [1, 2].map(column => {
    const element = document.createElement("div"); document.body.append(element);
    cleanup.push(() => { element.remove(); });
    const editor = monaco.editor.create(element, { model, dimension: { width: 600, height: 300 } });
    cleanup.push(() => { editor.dispose(); });
    const detach = service.attach(editor, { groupId: String(column), viewColumn: () => column });
    cleanup.push(detach);
    return editor;
  });
  return { model, service, editors, panes: service.snapshotEditors() };
}
it("applies all cursor styles and line number modes only to the requested Monaco pane", () => {
  const r = rig(), [left, right] = r.editors;
  for (const cursorStyle of [1, 2, 3, 4, 5, 6]) for (const lineNumbers of [0, 1, 2]) {
    expect(r.service.setOptionsFor(r.model.uri.toString(), { cursorStyle, lineNumbers }, r.panes[1]?.id)).toBe(true);
    expect(right?.getOption(monaco.editor.EditorOption.cursorStyle)).toBe(cursorStyle);
    expect(right?.getOption(monaco.editor.EditorOption.lineNumbers).renderType).toBe(lineNumbers);
    expect(left?.getOption(monaco.editor.EditorOption.cursorStyle)).toBe(1);
    expect(left?.getOption(monaco.editor.EditorOption.lineNumbers).renderType).toBe(1);
    expect(r.service.snapshotEditors()[1]).toMatchObject({ cursorStyle, lineNumbers });
  }
});
it("resolves independent indent sizes, linked tab sizes and auto indentation without changing text", () => {
  const r = rig(), text = r.model.getValue();
  r.service.setOptionsFor(r.model.uri.toString(), { tabSize: 8, indentSize: 3, insertSpaces: true });
  expect(r.service.optionsFor(r.model.uri.toString())).toMatchObject({tabSize:8,indentSize:3,insertSpaces:true});
  r.service.setOptionsFor(r.model.uri.toString(), { tabSize: 4 });
  expect(r.model.getOptions()).toMatchObject({tabSize:4,indentSize:3});
  r.service.setOptionsFor(r.model.uri.toString(), { indentSize: "tabSize" });
  r.service.setOptionsFor(r.model.uri.toString(), { tabSize: 6 });
  expect(r.model.getOptions()).toMatchObject({tabSize:6,indentSize:6});
  r.service.setOptionsFor(r.model.uri.toString(), { tabSize: "auto", insertSpaces: "auto", indentSize: 5 });
  expect(r.model.getOptions()).toMatchObject({tabSize:2,indentSize:5,insertSpaces:true});
  expect(r.model.getValue()).toBe(text);
});
it("prevalidates the entire option batch and rejects a stale pane before mutation", () => {
  const r = rig(), before = r.service.snapshotEditors();
  for (const options of [{tabSize:8,cursorStyle:9},{indentSize:0},{lineNumbers:3},{cursorStyle:NaN},{indentSize:"auto"},{extra:true}]) {
    expect(() => r.service.setOptionsFor(r.model.uri.toString(), options as never)).toThrow();
    expect(r.service.snapshotEditors()).toEqual(before);
  }
  expect(r.service.setOptionsFor(r.model.uri.toString(), {cursorStyle:2}, "closed-pane")).toBe(false);
  expect(r.service.snapshotEditors()).toEqual(before);
});
it("announces visual configuration changes even when the model and selection stay the same", () => {
  const r = rig(); let updates = 0;
  const off = r.service.subscribe(() => { updates++; }); cleanup.push(off);
  r.editors[0]?.updateOptions({cursorStyle:"block",lineNumbers:"relative"});
  expect(updates).toBeGreaterThan(0);
  expect(r.service.snapshotEditors()[0]).toMatchObject({cursorStyle:2,lineNumbers:2});
});
it("rejects malformed and fractional options before reaching Monaco", () => {
  for (const value of [null, [], {indentSize:1.5}, {cursorStyle:"block"}, {lineNumbers:-1}, {insertSpaces:2}]) expect(() => parseEditorOptions(value)).toThrow();
});
