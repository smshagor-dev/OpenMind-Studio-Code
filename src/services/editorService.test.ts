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
    onDidChangeModel: vi.fn<(listener: () => void) => { dispose: typeof dispose }>(() => ({
      dispose,
    })),
    onDidChangeModelLanguage: vi.fn(() => ({ dispose })),
    onDidChangeModelOptions: vi.fn(() => ({ dispose })),
    onDidFocusEditorWidget: vi.fn<(listener: () => void) => { dispose: typeof dispose }>(() => ({
      dispose,
    })),
    setSelection: vi.fn(),
    revealRangeInCenter: vi.fn(),
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
  // "markdown" (not e.g. "typescript"/"javascript"/"css"/"html"/"json"): those languages lazily
  // load a worker-backed language service the first time a model uses them, which jsdom can't run
  // (no real Worker/module-loading environment) and which leaks an async rejection past this test
  // file's teardown — see the "Editor Test Stability Gate" entry in CLAUDE.md's milestone tracker.
  function model(content: string, language = "markdown") {
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
      languageId: "markdown",
    });
    expect(listener).toHaveBeenCalled();
  });

  it("detach clears status and disposes listeners", () => {
    const service = new EditorService(createFakeIpc());
    const fake = createFakeEditor(model("x"));
    const detach = service.attach(fake.asEditor);

    detach();

    expect(service.getStatus()).toBeNull();
    expect(fake.dispose).toHaveBeenCalledTimes(5);
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

  describe("several editors (one per group) and reveal", () => {
    it("commands act on the editor that last had focus", () => {
      const service = new EditorService(createFakeIpc());
      const first = createFakeEditor(model("one"));
      const second = createFakeEditor(model("two"));
      service.attach(first.asEditor);
      service.attach(second.asEditor);

      service.run("undo");
      expect(second.editor.trigger).toHaveBeenCalledTimes(1);
      expect(first.editor.trigger).not.toHaveBeenCalled();

      // The first editor gets focus.
      const focusHandler = first.editor.onDidFocusEditorWidget.mock.calls[0]?.[0] as () => void;
      focusHandler();
      service.run("redo");
      expect(first.editor.trigger).toHaveBeenCalledTimes(1);
    });

    it("detaching the current editor falls back to another one that is still mounted", () => {
      const service = new EditorService(createFakeIpc());
      const first = createFakeEditor(model("one"));
      const second = createFakeEditor(model("two"));
      service.attach(first.asEditor);
      const detachSecond = service.attach(second.asEditor);

      detachSecond();
      service.run("undo");

      expect(first.editor.trigger).toHaveBeenCalledTimes(1);
      expect(service.hasEditor()).toBe(true);
    });

    it("reveal selects and centers the range in the editor showing that model", () => {
      const service = new EditorService(createFakeIpc());
      const shown = model("hello world");
      const fake = createFakeEditor(shown);
      service.attach(fake.asEditor);

      service.reveal({ uri: shown.uri.toString(), line: 1, column: 7, length: 5 });

      const range = { startLineNumber: 1, startColumn: 7, endLineNumber: 1, endColumn: 12 };
      expect(fake.editor.setSelection).toHaveBeenCalledWith(range);
      expect(fake.editor.revealRangeInCenter).toHaveBeenCalledWith(range);
      expect(fake.editor.focus).toHaveBeenCalled();
    });

    it("reveal waits for the model to be shown, then applies once", () => {
      const service = new EditorService(createFakeIpc());
      const target = model("later");
      const other = model("current");
      let current = other;
      const fake = createFakeEditor(other);
      fake.editor.getModel.mockImplementation(() => current);
      service.attach(fake.asEditor);

      service.reveal({ uri: target.uri.toString(), line: 1, column: 1, length: 2 });
      expect(fake.editor.setSelection).not.toHaveBeenCalled();

      current = target;
      const modelChanged = fake.editor.onDidChangeModel.mock.calls[0]?.[0] as () => void;
      modelChanged();
      modelChanged();

      expect(fake.editor.setSelection).toHaveBeenCalledTimes(1);
    });

    it("a reveal for a file that never shows up expires instead of firing later", () => {
      vi.useFakeTimers();
      try {
        const service = new EditorService(createFakeIpc());
        const target = model("x");
        const other = model("y");
        let current = other;
        const fake = createFakeEditor(other);
        fake.editor.getModel.mockImplementation(() => current);
        service.attach(fake.asEditor);
        service.reveal({ uri: target.uri.toString(), line: 1, column: 1, length: 1 });

        vi.advanceTimersByTime(6000);
        current = target;
        (fake.editor.onDidChangeModel.mock.calls[0]?.[0] as () => void)();

        expect(fake.editor.setSelection).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
