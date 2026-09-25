import * as monaco from "monaco-editor";
import { describe, expect, it } from "vitest";

import {
  KIND_TO_MONACO,
  monacoCompletionKind,
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
