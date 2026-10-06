import * as monaco from "monaco-editor";
import { describe, expect, it, vi } from "vitest";

import { registerBuiltInLanguages } from "./builtinLanguages";

describe("Fortran and Pascal snippets", () => {
  it("are offered only in their own language, as snippets that replace the typed word", () => {
    const register = vi.spyOn(monaco.languages, "registerCompletionItemProvider");
    registerBuiltInLanguages();
    const providers = new Map(
      register.mock.calls.map(([selector, provider]) => [selector as string, provider]),
    );
    expect([...providers.keys()].sort()).toEqual(["fortran", "nasm", "pascal"]);

    const labels = (language: string, text: string) => {
      const model = monaco.editor.createModel(text, language);
      const position = new monaco.Position(1, text.length + 1);
      const list = providers
        .get(language)
        ?.provideCompletionItems(model, position, { triggerKind: 0 }, new monaco.CancellationTokenSource().token);
      model.dispose();
      const items = (list as monaco.languages.CompletionList | undefined)?.suggestions ?? [];
      for (const item of items) {
        expect(item.kind).toBe(monaco.languages.CompletionItemKind.Snippet);
        expect(item.insertTextRules).toBe(monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet);
        expect(item.range).toMatchObject({ startColumn: 1, endColumn: text.length + 1 });
      }
      return Object.fromEntries(items.map((item) => [item.label as string, item.insertText]));
    };

    const fortran = labels("fortran", "prog");
    expect(Object.keys(fortran)).toEqual(["program", "subroutine", "do", "if"]);
    expect(fortran.program).toBe("program ${1:name}\n  implicit none\n  ${0}\nend program ${1:name}");
    const pascal = labels("pascal", "prog");
    expect(Object.keys(pascal)).toEqual(["program", "procedure", "if", "for"]);
    expect(pascal.program).toBe("program ${1:Name};\n\nbegin\n  ${0}\nend.");
    register.mockRestore();
  });
});
