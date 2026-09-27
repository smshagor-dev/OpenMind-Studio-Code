import { describe, expect, it, vi } from "vitest";

import { ExtensionFormatterRegistry, toEditorEdits } from "./extensionFormatters";

describe("ExtensionFormatterRegistry", () => {
  it("offers one formatter per extension for its languages and removes it on dispose", async () => {
    const registry = new ExtensionFormatterRegistry();
    const edit = { range: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 3 }, newText: "abc" };
    const invoke = vi.fn(() => Promise.resolve([edit]));
    const off = registry.register(
      {
        handle: "h1",
        kind: "formatting",
        extension: "pub.fmt",
        selector: [{ language: "plaintext" }],
        displayName: "Fmt",
      },
      invoke,
    );
    registry.register(
      { handle: "h2", kind: "formatting", extension: "pub.fmt", selector: [{ language: "plaintext" }] },
      invoke,
    );
    registry.register(
      { handle: "h3", kind: "hover", extension: "pub.fmt", selector: [{ language: "plaintext" }] },
      invoke,
    );
    const found = registry.forLanguage("plaintext");
    expect(found.map((f) => [f.id, f.name])).toEqual([["ext:pub.fmt", "Fmt (extension)"]]);
    expect(registry.forLanguage("python")).toEqual([]);
    expect(await found[0]?.format("C:/a.txt", { tabSize: 2, insertSpaces: true })).toEqual([edit]);
    expect(invoke).toHaveBeenCalledWith({ path: "C:/a.txt", options: { tabSize: 2, insertSpaces: true } });
    off();
    registry.clear();
    expect(registry.forLanguage("plaintext")).toEqual([]);
  });

  it("treats a non-array answer as no edits and converts edits to 1-based ranges", async () => {
    const registry = new ExtensionFormatterRegistry();
    registry.register(
      { handle: "h", kind: "formatting", extension: "x.y", selector: [{ language: "*" }] },
      () => Promise.resolve(null),
    );
    expect(await registry.forLanguage("anything")[0]?.format("p", { tabSize: 4, insertSpaces: false })).toEqual(
      [],
    );
    expect(
      toEditorEdits([{ range: { startLine: 1, startColumn: 2, endLine: 3, endColumn: 4 }, newText: "t" }]),
    ).toEqual([{ range: { startLineNumber: 2, startColumn: 3, endLineNumber: 4, endColumn: 5 }, text: "t" }]);
  });
});
