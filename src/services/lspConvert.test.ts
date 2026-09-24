import * as monaco from "monaco-editor";
import { describe, expect, it } from "vitest";

import {
  convertCompletionItem,
  convertCompletionList,
  convertHover,
  convertLocations,
  convertSignatureHelp,
  convertSymbols,
  convertTextEdits,
  convertWorkspaceEdit,
  toLspPosition,
  toMarker,
  toMonacoRange,
} from "./lspConvert";
import { lspLanguageId, monacoLanguageFor } from "./lspLanguages";
import { pathToUri, uriToPath } from "./lspUri";

const range = (sl: number, sc: number, el: number, ec: number) => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec },
});

describe("URIs and languages", () => {
  const backslash = String.fromCharCode(92);

  it("a Windows path with spaces round-trips through a file URI", () => {
    const uri = pathToUri(`C:${backslash}My Site${backslash}src${backslash}a b.ts`);
    expect(uri).toBe("file:///C:/My%20Site/src/a%20b.ts");
    expect(uriToPath(uri)).toBe("C:/My Site/src/a b.ts");
  });

  it("understands the encoded drive colon servers send, and refuses other schemes", () => {
    expect(uriToPath("file:///c%3A/My%20Site/x.py")).toBe("c:/My Site/x.py");
    expect(uriToPath("untitled:Untitled-1")).toBeNull();
    expect(uriToPath("file://server/share/a.ts")).toBeNull();
    expect(uriToPath("file:///C:/a%zz")).toBeNull();
  });

  it("non-ASCII characters are UTF-8 percent-encoded", () => {
    expect(pathToUri("C:/proj/ü.php")).toBe("file:///C:/proj/%C3%BC.php");
    expect(uriToPath("file:///C:/proj/%C3%BC.php")).toBe("C:/proj/ü.php");
  });

  it("language ids match the backend's, and JSX files are their own language", () => {
    expect(lspLanguageId("C:/x/App.tsx")).toBe("typescriptreact");
    expect(lspLanguageId("a.mjs")).toBe("javascript");
    expect(lspLanguageId("tool.py")).toBe("python");
    expect(lspLanguageId("index.php")).toBe("php");
    expect(lspLanguageId("notes.txt")).toBeNull();
    expect(lspLanguageId("README")).toBeNull();
    expect(monacoLanguageFor("typescriptreact")).toBe("typescript");
    expect(monacoLanguageFor("python")).toBe("python");
  });
});

describe("positions and diagnostics", () => {
  it("0-based LSP positions become 1-based Monaco ones and back", () => {
    expect(toMonacoRange(range(0, 0, 1, 4))).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 2,
      endColumn: 5,
    });
    expect(toLspPosition({ lineNumber: 3, column: 7 })).toEqual({ line: 2, character: 6 });
  });

  it("a diagnostic becomes a Monaco marker with severity, code, source and tags", () => {
    const marker = toMarker({
      range: range(4, 2, 4, 9),
      severity: 2,
      code: 2304,
      source: "ts",
      message: "Cannot find name 'foo'.",
      tags: [1, 2],
    });
    expect(marker.severity).toBe(monaco.MarkerSeverity.Warning);
    expect(marker.message).toBe("Cannot find name 'foo'.");
    expect(marker.code).toBe("2304");
    expect(marker.source).toBe("ts");
    expect([marker.startLineNumber, marker.startColumn]).toEqual([5, 3]);
    expect([marker.endLineNumber, marker.endColumn]).toEqual([5, 10]);
    expect(marker.tags).toEqual([monaco.MarkerTag.Unnecessary, monaco.MarkerTag.Deprecated]);
  });

  it("maps all four severities and treats a missing one as an error", () => {
    const severity = (value?: number) =>
      toMarker({ range: range(0, 0, 0, 1), message: "m", severity: value }).severity;
    expect(severity(1)).toBe(monaco.MarkerSeverity.Error);
    expect(severity(2)).toBe(monaco.MarkerSeverity.Warning);
    expect(severity(3)).toBe(monaco.MarkerSeverity.Info);
    expect(severity(4)).toBe(monaco.MarkerSeverity.Hint);
    expect(severity(undefined)).toBe(monaco.MarkerSeverity.Error);
  });
});

describe("hover, completion and signatures", () => {
  it("hover contents: markdown, code blocks and arrays", () => {
    const hover = convertHover({
      contents: [{ language: "typescript", value: "let a: number" }, "Docs **here**"],
      range: range(0, 4, 0, 5),
    });
    expect(hover?.contents).toEqual([
      { value: "```typescript\nlet a: number\n```" },
      { value: "Docs **here**" },
    ]);
    expect(hover?.range?.startColumn).toBe(5);
    expect(convertHover({ contents: { kind: "markdown", value: "x" } })?.contents).toEqual([
      { value: "x" },
    ]);
    expect(convertHover(null)).toBeNull();
    expect(convertHover({ contents: "" })).toBeNull();
  });

  it("plain-text hover is escaped so it can't be read as markdown", () => {
    const hover = convertHover({ contents: { kind: "plaintext", value: "a*b" } });
    expect(hover?.contents[0]?.value).toBe("a\\*b");
  });

  const wordRange = { startLineNumber: 1, startColumn: 5, endLineNumber: 1, endColumn: 8 };

  it("a completion item keeps kind, detail, docs, snippet format and its own edit", () => {
    const item = convertCompletionItem(
      {
        label: "log",
        kind: 2,
        detail: "(method) Console.log()",
        documentation: { kind: "markdown", value: "Prints." },
        insertTextFormat: 2,
        textEdit: { range: range(0, 4, 0, 7), newText: "log($1)" },
        sortText: "0",
        additionalTextEdits: [{ range: range(0, 0, 0, 0), newText: "import x;\n" }],
      },
      wordRange,
    );
    expect(item?.kind).toBe(monaco.languages.CompletionItemKind.Method);
    expect(item?.insertText).toBe("log($1)");
    expect(item?.insertTextRules).toBe(
      monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
    );
    expect(item?.range).toEqual({
      startLineNumber: 1,
      startColumn: 5,
      endLineNumber: 1,
      endColumn: 8,
    });
    expect(item?.documentation).toEqual({ value: "Prints." });
    expect(item?.additionalTextEdits?.[0]?.text).toBe("import x;\n");
    expect(item?.lspItem).toBeDefined();
  });

  it("an item without an edit takes the word range and its label as text; insert/replace ranges are kept", () => {
    const plain = convertCompletionItem({ label: "foo" }, wordRange);
    expect(plain?.insertText).toBe("foo");
    expect(plain?.range).toEqual(wordRange);
    const both = convertCompletionItem(
      {
        label: "x",
        textEdit: { insert: range(0, 1, 0, 2), replace: range(0, 1, 0, 4), newText: "xy" },
      },
      wordRange,
    );
    expect(both?.range).toEqual({
      insert: { startLineNumber: 1, startColumn: 2, endLineNumber: 1, endColumn: 3 },
      replace: { startLineNumber: 1, startColumn: 2, endLineNumber: 1, endColumn: 5 },
    });
  });

  it("a completion list reports incompleteness and drops malformed items", () => {
    const list = convertCompletionList(
      { isIncomplete: true, items: [{ label: "a" }, { nope: 1 }, { label: "b" }] },
      wordRange,
    );
    expect(list.suggestions.map((s) => s.insertText)).toEqual(["a", "b"]);
    expect(list.incomplete).toBe(true);
    expect(convertCompletionList([{ label: "z" }], wordRange).incomplete).toBe(false);
    expect(convertCompletionList(null, wordRange).suggestions).toEqual([]);
  });

  it("signature help keeps signatures, parameters and the active ones", () => {
    const help = convertSignatureHelp({
      signatures: [{ label: "f(a, b)", parameters: [{ label: "a" }, { label: [3, 4] }] }],
      activeSignature: 0,
      activeParameter: 1,
    });
    expect(help?.signatures[0]?.parameters).toHaveLength(2);
    expect(help?.activeParameter).toBe(1);
    expect(convertSignatureHelp({ signatures: [] })).toBeNull();
  });
});

describe("locations, edits and symbols", () => {
  it("a Location, a Location[] and LocationLink[] all become plain locations", () => {
    const one = { uri: "file:///c%3A/My%20Site/a.ts", range: range(1, 0, 1, 3) };
    expect(convertLocations(one)).toEqual([{ path: "c:/My Site/a.ts", range: one.range }]);
    expect(convertLocations([one, one])).toHaveLength(2);
    const link = {
      targetUri: "file:///C:/b.ts",
      targetRange: range(0, 0, 9, 0),
      targetSelectionRange: range(2, 1, 2, 4),
    };
    expect(convertLocations([link])).toEqual([
      { path: "C:/b.ts", range: link.targetSelectionRange },
    ]);
    expect(convertLocations(null)).toEqual([]);
  });

  it("locations that aren't files are dropped", () => {
    expect(convertLocations([{ uri: "untitled:1", range: range(0, 0, 0, 1) }])).toEqual([]);
  });

  it("text edits become Monaco edits", () => {
    expect(convertTextEdits([{ range: range(0, 0, 0, 3), newText: "abc" }, { bad: true }])).toEqual(
      [
        {
          range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 },
          text: "abc",
        },
      ],
    );
    expect(convertTextEdits(null)).toEqual([]);
  });

  it("a workspace edit is grouped per file, from `changes` or `documentChanges`", () => {
    const edit = { range: range(0, 0, 0, 1), newText: "n" };
    const fromChanges = convertWorkspaceEdit({
      changes: { "file:///C:/a.ts": [edit], "file:///C:/b.ts": [edit, edit] },
    });
    expect(fromChanges.files.map((f) => [f.path, f.edits.length])).toEqual([
      ["C:/a.ts", 1],
      ["C:/b.ts", 2],
    ]);
    const fromDocs = convertWorkspaceEdit({
      documentChanges: [{ textDocument: { uri: "file:///C:/a.ts", version: 1 }, edits: [edit] }],
    });
    expect(fromDocs.files[0]?.path).toBe("C:/a.ts");
    expect(fromDocs.unsupported).toBeNull();
  });

  it("file operations inside a workspace edit are reported, not silently ignored", () => {
    const result = convertWorkspaceEdit({
      documentChanges: [{ kind: "rename", oldUri: "file:///C:/a.ts", newUri: "file:///C:/b.ts" }],
    });
    expect(result.unsupported).toContain("rename");
  });

  it("symbols: hierarchical and flat", () => {
    const tree = convertSymbols([
      {
        name: "Foo",
        kind: 5,
        range: range(0, 0, 9, 1),
        selectionRange: range(0, 6, 0, 9),
        children: [
          { name: "bar", kind: 6, range: range(1, 2, 3, 3), selectionRange: range(1, 2, 1, 5) },
        ],
      },
    ]);
    expect(tree[0]?.name).toBe("Foo");
    expect(tree[0]?.kind).toBe(monaco.languages.SymbolKind.Class);
    expect(tree[0]?.children?.[0]?.name).toBe("bar");
    const flat = convertSymbols([
      {
        name: "f",
        kind: 12,
        containerName: "M",
        location: { uri: "file:///C:/a.py", range: range(2, 0, 4, 0) },
      },
    ]);
    expect(flat[0]?.range.startLineNumber).toBe(3);
    expect(flat[0]?.containerName).toBe("M");
  });
});
