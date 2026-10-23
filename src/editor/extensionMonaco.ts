import * as monaco from "monaco-editor";

import type { ProviderInvoke, ProviderRegistration } from "../services/extensionHostBridge";
import type { ContributionBinding } from "../services/extensionContributionService";
import {
  documentationText,
  type HostCompletionItem,
  type HostHover,
  type HostLocation,
  type HostDocumentSymbol,
  type HostRange,
  INSERT_AS_SNIPPET,
  monacoCompletionKind,
  toMonacoRange,
} from "../services/extensionProviderConvert";
import type { ExtensionSnippet } from "../services/extensionSnippets";
import type { EditorService } from "../services/editorService";

/** Monaco's snippet completion kind. */
const SNIPPET_KIND = monaco.languages.CompletionItemKind.Snippet;

/**
 * The extension features that live in Monaco: languages an extension contributes, its snippets and the
 * editor actions (command palette, right-click menu). The services decide *what*; this only calls Monaco.
 */
export function createContributionBinding(editor: EditorService): ContributionBinding {
  const registered = new Set<string>();
  return {
    registerLanguage(language) {
      const key = `${language.id}|${language.extensions.join(",")}|${language.filenames.join(",")}`;
      if (registered.has(key)) return;
      registered.add(key);
      monaco.languages.register({
        id: language.id,
        extensions: language.extensions,
        filenames: language.filenames,
        aliases: language.aliases,
      });
    },
    registerSnippets(languageId, snippets: ExtensionSnippet[]) {
      const disposable = monaco.languages.registerCompletionItemProvider(languageId, {
        provideCompletionItems(model, position) {
          const word = model.getWordUntilPosition(position);
          const range = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn,
          };
          return {
            suggestions: snippets.flatMap((snippet) =>
              snippet.prefixes.map((prefix) => ({
                label: prefix,
                kind: SNIPPET_KIND,
                detail: snippet.name,
                documentation: snippet.description,
                insertText: snippet.body,
                insertTextRules: INSERT_AS_SNIPPET,
                range,
              })),
            ),
          };
        },
      });
      return () => {
        disposable.dispose();
      };
    },
    setEditorActions(actions) {
      editor.setExtensionActions(actions);
    },
  };
}

/**
 * Registers an extension's supported language provider in Monaco; every call goes to the
 * extension host through `invoke`. `pathOf` gives the file of a model (files without one are skipped).
 */
export function registerHostProvider(
  registration: ProviderRegistration,
  invoke: ProviderInvoke,
  pathOf: (model: monaco.editor.ITextModel) => string | null,
): () => void {
  const selector: monaco.languages.LanguageSelector = registration.selector;
  const ask = async (model: monaco.editor.ITextModel, position: monaco.Position | undefined,
    token: monaco.CancellationToken, context?: { includeDeclaration: boolean }) => {
    if (token.isCancellationRequested) return null;
    const path = pathOf(model);
    if (path === null) return null;
    return invoke({
      path,
      ...(position === undefined ? {} : { position: { line: position.lineNumber - 1, character: position.column - 1 } }),
      ...(context === undefined ? {} : { context }),
    }, token);
  };
  const disposables: monaco.IDisposable[] = [];
  if (registration.kind === "completion") {
    disposables.push(
      monaco.languages.registerCompletionItemProvider(selector, {
        triggerCharacters: registration.triggerCharacters,
        async provideCompletionItems(model, position, _context, token) {
          const items = ((await ask(model, position, token)) ?? []) as HostCompletionItem[];
          const word = model.getWordUntilPosition(position);
          const range = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn,
          };
          return {
            suggestions: items.map((item) => {
              const snippet = typeof item.insertText === "object";
              return {
                label: item.label,
                kind: monacoCompletionKind(item.kind),
                detail: item.detail,
                documentation: documentationText(item.documentation),
                insertText:
                  typeof item.insertText === "object"
                    ? item.insertText.snippet
                    : (item.insertText ?? item.label),
                insertTextRules: snippet ? INSERT_AS_SNIPPET : undefined,
                sortText: item.sortText,
                filterText: item.filterText,
                range,
              };
            }),
          };
        },
      }),
    );
  } else if (registration.kind === "hover") {
    disposables.push(
      monaco.languages.registerHoverProvider(selector, {
        async provideHover(model, position, token) {
          const hover = (await ask(model, position, token)) as HostHover | null;
          if (hover === null || hover.contents.length === 0) return null;
          return {
            contents: hover.contents.map((entry) => ({
              value: typeof entry === "string" ? entry : entry.value,
            })),
            range: hover.range === undefined ? undefined : toMonacoRange(hover.range),
          };
        },
      }),
    );
  } else if (registration.kind === "definition" || registration.kind === "typeDefinition" || registration.kind === "implementation") {
    const provide = async (model: monaco.editor.ITextModel, position: monaco.Position, token: monaco.CancellationToken) => {
      const locations = ((await ask(model, position, token)) ?? []) as HostLocation[];
      return locations.map((location) => ({
        uri: location.uri === undefined ? monaco.Uri.file(location.path) : monaco.Uri.parse(location.uri),
        range: toMonacoRange(location.range),
        ...(location.targetSelectionRange === undefined ? {} : { targetSelectionRange: toMonacoRange(location.targetSelectionRange) }),
        ...(location.originSelectionRange === undefined ? {} : { originSelectionRange: toMonacoRange(location.originSelectionRange) }),
      }));
    };
    if (registration.kind === "definition") disposables.push(monaco.languages.registerDefinitionProvider(selector, { provideDefinition: provide }));
    else if (registration.kind === "typeDefinition") disposables.push(monaco.languages.registerTypeDefinitionProvider(selector, { provideTypeDefinition: provide }));
    else disposables.push(monaco.languages.registerImplementationProvider(selector, { provideImplementation: provide }));
  } else if (registration.kind === "reference") {
    disposables.push(monaco.languages.registerReferenceProvider(selector, {
      async provideReferences(model, position, context, token) {
        const locations = ((await ask(model, position, token, context)) ?? []) as HostLocation[];
        return locations.map((location) => ({
          uri: location.uri === undefined ? monaco.Uri.file(location.path) : monaco.Uri.parse(location.uri),
          range: toMonacoRange(location.range),
        }));
      },
    }));
  } else if (registration.kind === "highlight") {
    disposables.push(monaco.languages.registerDocumentHighlightProvider(selector, {
      async provideDocumentHighlights(model, position, token) {
        const highlights = ((await ask(model, position, token)) ?? []) as { range: HostRange; kind?: number }[];
        return highlights.map((item) => ({ range: toMonacoRange(item.range), kind: item.kind ?? monaco.languages.DocumentHighlightKind.Text }));
      },
    }));
  } else if (registration.kind === "documentSymbol") {
    const convert = (symbol: HostDocumentSymbol): monaco.languages.DocumentSymbol => ({
      name: symbol.name, detail: symbol.detail, kind: symbol.kind,
      tags: (symbol.tags ?? []).filter((tag) => tag === monaco.languages.SymbolTag.Deprecated),
      range: toMonacoRange(symbol.range), selectionRange: toMonacoRange(symbol.selectionRange),
      children: (symbol.children ?? []).map(convert), containerName: symbol.containerName,
    });
    disposables.push(monaco.languages.registerDocumentSymbolProvider(selector, {
      displayName: registration.displayName,
      async provideDocumentSymbols(model, token) {
        const symbols = ((await ask(model, undefined, token)) ?? []) as HostDocumentSymbol[];
        return symbols.map(convert);
      },
    }));
  } else if (registration.kind === "folding") {
    disposables.push(monaco.languages.registerFoldingRangeProvider(selector, {
      async provideFoldingRanges(model, _context, token) {
        const ranges = ((await ask(model, undefined, token)) ?? []) as { start: number; end: number; kind?: number }[];
        return ranges.map((range) => ({
          start: range.start + 1, end: range.end + 1,
          kind: range.kind === 1 ? monaco.languages.FoldingRangeKind.Comment
            : range.kind === 2 ? monaco.languages.FoldingRangeKind.Imports
              : range.kind === 3 ? monaco.languages.FoldingRangeKind.Region : undefined,
        }));
      },
    }));
  }
  return () => {
    for (const disposable of disposables) disposable.dispose();
  };
}

