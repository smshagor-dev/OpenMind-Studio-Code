import * as monaco from "monaco-editor";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { type CodeEditorLike, EditorService } from "./editorService";

function createFakeEditor(model: monaco.editor.ITextModel | null) {
  let selectionListener: (() => void) | null = null;
  const dispose = vi.fn();
  const selections = [new monaco.Selection(1, 1, 1, 6)];
  const editor = {
    focus: vi.fn(),
    trigger: vi.fn(),
    updateOptions: vi.fn(),
    getSelections: vi.fn(() => selections),
    getModel: vi.fn(() => model),
    onDidChangeCursorSelection: vi.fn((listener: () => void) => {
      selectionListener = listener;
      return { dispose };
    }),
    onDidChangeModel: vi.fn(() => ({ dispose })),
    onDidChangeModelLanguage: vi.fn(() => ({ dispose })),
    onDidChangeModelOptions: vi.fn(() => ({ dispose })),
  };
  return {
    editor,
    asEditor: editor as unknown as CodeEditorLike,
    selections,
    dispose,
    fireSelection: () => selectionListener?.(),
  };
}

describe("EditorService", () => {
  const models: monaco.editor.ITextModel[] = [];
  function model(content: string, language = "typescript") {
    const created = monaco.editor.createModel(content, language);
    models.push(created);
    return created;
  }

  afterEach(() => {
    for (const created of models.splice(0)) created.dispose();
  });

  it("run focuses the attached editor and triggers the action", () => {
    const service = new EditorService(createFakeIpc());
    const fake = createFakeEditor(model("hello"));
    service.attach(fake.asEditor);

    service.run("editor.action.commentLine");

    expect(fake.editor.focus).toHaveBeenCalled();
    expect(fake.editor.trigger).toHaveBeenCalledWith("menu", "editor.action.commentLine", null);
  });

  it("run is a no-op without an editor or without a model", () => {
    const service = new EditorService(createFakeIpc());
    expect(() => {
      service.run("undo");
    }).not.toThrow();

    const fake = createFakeEditor(null);
    service.attach(fake.asEditor);
    service.run("undo");

    expect(service.hasEditor()).toBe(false);
    expect(fake.editor.trigger).not.toHaveBeenCalled();
  });

  it("publishes cursor, selection and language status", () => {
    const service = new EditorService(createFakeIpc());
    const fake = createFakeEditor(model("hello world"));
    const listener = vi.fn();
    service.subscribe(listener);

    service.attach(fake.asEditor);
    fake.selections[0] = new monaco.Selection(1, 1, 1, 3);
    fake.fireSelection();

    expect(service.getStatus()).toMatchObject({
      line: 1,
      column: 3,
      selectedChars: 2,
      selectionCount: 1,
      languageId: "typescript",
    });
    expect(listener).toHaveBeenCalled();
  });

  it("detach clears status and disposes listeners", () => {
    const service = new EditorService(createFakeIpc());
    const fake = createFakeEditor(model("x"));
    const detach = service.attach(fake.asEditor);

    detach();

    expect(service.getStatus()).toBeNull();
    expect(fake.dispose).toHaveBeenCalledTimes(4);
  });

  it("toggleOption updates the editor and persists the options", async () => {
    const ipc = createFakeIpc();
    const service = new EditorService(ipc);
    const fake = createFakeEditor(model("x"));
    service.attach(fake.asEditor);

    await service.toggleOption("wordWrap");

    expect(service.getOptions().wordWrap).toBe(true);
    expect(fake.editor.updateOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ wordWrap: "on" }),
    );
    expect(ipc.settingsSet).toHaveBeenCalledWith(
      "editor.viewOptions",
      expect.stringContaining('"wordWrap":true'),
    );
  });

  it("initialize restores saved options and ignores unknown or invalid fields", async () => {
    const ipc = createFakeIpc({
      settingsGet: vi.fn().mockResolvedValue('{"minimap":false,"wordWrap":"yes","bogus":true}'),
    });
    const service = new EditorService(ipc);

    await service.initialize();

    expect(service.getOptions().minimap).toBe(false);
    expect(service.getOptions().wordWrap).toBe(false);
    expect(service.getOptions()).not.toHaveProperty("bogus");
  });
});
