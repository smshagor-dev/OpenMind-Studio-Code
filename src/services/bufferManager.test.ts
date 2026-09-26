import { afterEach, describe, expect, it, vi } from "vitest";

import { BufferManager } from "./bufferManager";

describe("BufferManager", () => {
  let manager: BufferManager;

  afterEach(() => {
    manager.disposeAll();
  });

  it("creates a model with the given initial content", () => {
    manager = new BufferManager();

    manager.create("a", "hello");

    expect(manager.getValue("a")).toBe("hello");
  });

  it("throws when creating a buffer id that already exists", () => {
    manager = new BufferManager();
    manager.create("a", "hello");

    expect(() => manager.create("a", "again")).toThrow(/already exists/);
  });

  it("setValue updates the model's content", () => {
    manager = new BufferManager();
    manager.create("a", "hello");

    manager.setValue("a", "world");

    expect(manager.getValue("a")).toBe("world");
  });

  it("onDidChangeContent fires when the model's content changes", () => {
    manager = new BufferManager();
    manager.create("a", "hello");
    const listener = vi.fn();
    manager.onDidChangeContent("a", listener);

    manager.setValue("a", "world");

    expect(listener).toHaveBeenCalled();
  });

  it("returned unsubscribe function stops further notifications", () => {
    manager = new BufferManager();
    manager.create("a", "hello");
    const listener = vi.fn();
    const unsubscribe = manager.onDidChangeContent("a", listener);
    unsubscribe();

    manager.setValue("a", "world");

    expect(listener).not.toHaveBeenCalled();
  });

  it("dispose removes the buffer so further access throws", () => {
    manager = new BufferManager();
    manager.create("a", "hello");

    manager.dispose("a");

    expect(() => manager.getValue("a")).toThrow(/does not exist/);
  });

  it("get returns undefined for a buffer that was never created", () => {
    manager = new BufferManager();

    expect(manager.get("missing")).toBeUndefined();
  });

  it("disposeAll clears every buffer", () => {
    manager = new BufferManager();
    manager.create("a", "1");
    manager.create("b", "2");

    manager.disposeAll();

    expect(manager.get("a")).toBeUndefined();
    expect(manager.get("b")).toBeUndefined();
  });

  describe("what Format Document needs from a buffer", () => {
    it("replaces the text as one edit that undo takes back, and reports the line ending and indentation", () => {
      manager = new BufferManager();
      const original = '{"a":' + "\n" + "1}";
      const model = manager.create("a", original, "plaintext");
      model.updateOptions({ tabSize: 2, insertSpaces: true });
      expect(manager.eolOf("a")).toBe("\n");
      expect(manager.indentUnitOf("a")).toBe("  ");
      model.updateOptions({ insertSpaces: false });
      expect(manager.indentUnitOf("a")).toBe("\t");

      manager.replaceContent("a", '{\n  "a": 1\n}');
      expect(manager.getValue("a")).toBe('{\n  "a": 1\n}');
      void model.undo();
      expect(manager.getValue("a")).toBe(original);
    });

    it("a CRLF model reports CRLF", () => {
      manager = new BufferManager();
      manager.create("a", "x\r\ny");
      expect(manager.eolOf("a")).toBe("\r\n");
    });

    it("applies language-server edits to a copy of the text, leaving the model alone", () => {
      manager = new BufferManager();
      manager.create("a", "let  a =1;\n");
      const out = manager.textWithEdits("a", [
        { range: { startLineNumber: 1, startColumn: 4, endLineNumber: 1, endColumn: 5 }, text: "" },
        {
          range: { startLineNumber: 1, startColumn: 9, endLineNumber: 1, endColumn: 9 },
          text: " ",
        },
      ]);
      expect(out).toBe("let a = 1;\n");
      expect(manager.getValue("a")).toBe("let  a =1;\n");
    });
  });
});
