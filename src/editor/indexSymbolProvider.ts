import * as monaco from "monaco-editor";

import type { TextSymbol } from "../services/searchIpc";

const KINDS: Record<string, monaco.languages.SymbolKind> = {
  function: monaco.languages.SymbolKind.Function,
  method: monaco.languages.SymbolKind.Method,
  class: monaco.languages.SymbolKind.Class,
  interface: monaco.languages.SymbolKind.Interface,
  enum: monaco.languages.SymbolKind.Enum,
  struct: monaco.languages.SymbolKind.Struct,
  trait: monaco.languages.SymbolKind.Interface,
  type: monaco.languages.SymbolKind.TypeParameter,
  module: monaco.languages.SymbolKind.Module,
  constant: monaco.languages.SymbolKind.Constant,
  variable: monaco.languages.SymbolKind.Variable,
  heading: monaco.languages.SymbolKind.String,
  key: monaco.languages.SymbolKind.Key,
};

export interface IndexSymbolDeps {
  /** The symbols of a piece of text for a language id (line-based patterns; the backend does the reading). */
  textSymbols: (language: string, text: string) => Promise<TextSymbol[]>;
  /** A language server already answers document symbols for this model: the fallback stays silent. */
  languageServerHandles: (modelUri: string) => boolean;
}

/**
 * Go to Symbol in Editor (Ctrl+Shift+O) and the outline for files no language server covers: the symbols come from
 * the same heuristic, line-based reader the workspace index uses, applied to the open (even unsaved) text. When a
 * server handles the file it answers alone and this provider returns nothing. Not perfect: see the index notes.
 */
export function registerIndexSymbolProvider(deps: IndexSymbolDeps): monaco.IDisposable {
  return monaco.languages.registerDocumentSymbolProvider(
    { pattern: "**" },
    {
      displayName: "OpenMind symbols",
      async provideDocumentSymbols(model) {
        if (deps.languageServerHandles(model.uri.toString())) return [];
        const symbols = await deps.textSymbols(model.getLanguageId(), model.getValue());
        return symbols.map((symbol) => {
          const endColumn = model.getLineMaxColumn(symbol.line);
          return {
            name: symbol.name,
            detail: symbol.container ?? "",
            kind: KINDS[symbol.kind] ?? monaco.languages.SymbolKind.Variable,
            tags: [],
            range: {
              startLineNumber: symbol.line,
              startColumn: 1,
              endLineNumber: symbol.line,
              endColumn,
            },
            selectionRange: {
              startLineNumber: symbol.line,
              startColumn: symbol.column,
              endLineNumber: symbol.line,
              endColumn: symbol.column + symbol.name.length,
            },
          };
        });
      },
    },
  );
}
