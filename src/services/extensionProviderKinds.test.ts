import * as monaco from "monaco-editor";
import { describe, expect, it } from "vitest";

import {
  KIND_TO_MONACO,
  monacoCompletionKind,
  toMarkers,
  VSCODE_KIND_NAMES,
} from "./extensionProviderConvert";

describe("completion kinds from extensions", () => {
  it("map every VS Code kind to Monaco's kind of the same name", () => {
    const monacoKinds = monaco.languages.CompletionItemKind as unknown as Record<string, number>;
    expect(KIND_TO_MONACO).toHaveLength(VSCODE_KIND_NAMES.length);
    VSCODE_KIND_NAMES.forEach((name, vscodeKind) => {
      expect([name, monacoCompletionKind(vscodeKind)]).toEqual([name, monacoKinds[name]]);
    });
  });

  it("an unknown or missing kind is plain text", () => {
    expect(monacoCompletionKind(undefined)).toBe(monaco.languages.CompletionItemKind.Text);
    expect(monacoCompletionKind(99)).toBe(monaco.languages.CompletionItemKind.Text);
  });
});

describe("diagnostic tags from extensions", () => {
  it("preserves VS Code marker tags while discarding unsupported values", () => {
    const markers = toMarkers([{
      range: { startLine: 0, startColumn: 1, endLine: 0, endColumn: 4 },
      message: "unused",
      severity: 1,
      tags: [1, 2, 900],
    }]);
    expect(markers[0]).toMatchObject({
      startLineNumber: 1,
      startColumn: 2,
      endColumn: 5,
      tags: [monaco.MarkerTag.Unnecessary, monaco.MarkerTag.Deprecated],
    });
  });
});
