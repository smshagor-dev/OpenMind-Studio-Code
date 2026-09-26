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

  it("selectedText reports the selection with its language and lines, and nothing for an empty one", () => {
    const service = new EditorService(createFakeIpc());
    expect(service.selectedText()).toBeNull();
    const fake = createFakeEditor(model("hello world\nsecond line"));
    service.attach(fake.asEditor);
    expect(service.selectedText()).toMatchObject({
      text: "hello",
      languageId: "markdown",
      startLine: 1,
      endLine: 1,
    });
    fake.selections[0] = new monaco.Selection(1, 3, 1, 3);
    expect(service.selectedText()).toBeNull();
    fake.selections[0] = new monaco.Selection(1, 1, 2, 4);
    expect(service.selectedText()).toMatchObject({
      text: "hello world\nsec",
      startLine: 1,
      endLine: 2,
    });
  });

  it("insertAtCursor replaces the selection in one edit, and refuses without an editor", () => {
    const service = new EditorService(createFakeIpc());
    expect(service.insertAtCursor("x")).toBe(false);
    const fake = createFakeEditor(model("hello"));
    const executeEdits = vi.fn();
    const asEditor = { ...fake.editor, executeEdits } as unknown as CodeEditorLike;
    service.attach(asEditor);
    expect(service.insertAtCursor("bye")).toBe(true);
    expect(executeEdits).toHaveBeenCalledWith("ai", [
      { range: fake.selections[0], text: "bye", forceMoveMarkers: true },
    ]);
    expect(fake.editor.focus).toHaveBeenCalled();
    // A fake editor with no `executeEdits` can't take the text.
    const bare = new EditorService(createFakeIpc());
    bare.attach(createFakeEditor(model("hi")).asEditor);
    expect(bare.insertAtCursor("bye")).toBe(false);
  });

  it("pasteText pastes like Ctrl+V (Monaco's paste command with the text) and refuses without an editor", () => {
    const service = new EditorService(createFakeIpc());
    expect(service.pasteText("x")).toBe(false);
    const fake = createFakeEditor(model("hello"));
    service.attach(fake.asEditor);
    expect(service.pasteText("clip")).toBe(true);
    expect(fake.editor.focus).toHaveBeenCalled();
    expect(fake.editor.trigger).toHaveBeenCalledWith("menu", "paste", { text: "clip" });
  });

  it("offers extension and AI actions side by side in the palette, with their own ids", () => {
    const service = new EditorService(createFakeIpc());
    const addAction = vi.fn(() => ({ dispose: vi.fn() }));
    const asEditor = {
      ...createFakeEditor(model("hi")).editor,
      addAction,
    } as unknown as CodeEditorLike;
    service.attach(asEditor);
    service.setExtensionActions([
      { command: "hello.say", label: "Say Hello", inContextMenu: true },
    ]);
    service.setAiActions([
      { command: "ai.openChat", label: "AI: Open Chat", inContextMenu: false },
    ]);
    const calls = addAction.mock.calls as unknown as [
      { id: string; contextMenuGroupId?: string },
    ][];
    const last = calls.slice(-2).map(([action]) => action);
    expect(last.map((a) => a.id)).toEqual(["extension.hello.say", "ai.ai.openChat"]);
    expect(last[0]?.contextMenuGroupId).toBe("9_extensions");
    expect(last[1]?.contextMenuGroupId).toBeUndefined();
    // Clearing the AI actions (no provider any more) leaves only the extension's.
    service.setAiActions([]);
    const afterClear = (addAction.mock.calls as unknown as [{ id: string }][]).slice(-1)[0]?.[0];
    expect(afterClear?.id).toBe("extension.hello.say");
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
