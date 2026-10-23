import { registerInlineHostProvider } from "./extensionInlineCompletions";
import { registerAdvancedHostProvider } from "./extensionAdvancedProviders";
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
  const inline = registerInlineHostProvider(registration, invoke, pathOf);
  if (inline) return inline;
  const advanced = registerAdvancedHostProvider(registration, invoke, pathOf);
  if (advanced) return advanced;
  const selector: monaco.languages.LanguageSelector = registration.selector;
  const ask = async (model: monaco.editor.ITextModel, position: monaco.Position | undefined,
    token: monaco.CancellationToken, context?: Parameters<ProviderInvoke>[0]["context"]) => {
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
    const commandId = `openmind.extensionCompletion.${registration.handle}`;
    disposables.push(monaco.editor.registerCommand(commandId, async (_accessor, path: unknown, itemId: unknown) => {
      if (typeof path !== "string" || typeof itemId !== "string") throw new Error("Invalid extension completion command arguments.");
      await invoke({ path, itemId, action: "command" });
    }));
    const metadata = new WeakMap<monaco.languages.CompletionItem, { id: string; path: string }>();
    const convert = (item: HostCompletionItem, fallback: monaco.IRange, path: string | null): monaco.languages.CompletionItem => ({
      label: item.labelDetails ? { label: item.label, ...item.labelDetails } : item.label,
      kind: monacoCompletionKind(item.kind), detail: item.detail, documentation: documentationText(item.documentation),
      insertText: typeof item.insertText === "object" ? item.insertText.snippet : item.insertText ?? item.label,
      insertTextRules: (typeof item.insertText === "object" ? INSERT_AS_SNIPPET : 0) | (item.keepWhitespace ? monaco.languages.CompletionItemInsertTextRule.KeepWhitespace : 0),
      sortText: item.sortText, filterText: item.filterText, preselect: item.preselect, commitCharacters: item.commitCharacters,
      command: item.hasCommand && item.id && path !== null ? { id: commandId, title: item.label, arguments: [path, item.id] } : undefined,
      tags: item.tags?.filter(tag => tag === monaco.languages.CompletionItemTag.Deprecated),
      range: item.range ? "insert" in item.range ? { insert: toMonacoRange(item.range.insert), replace: toMonacoRange(item.range.replace) } : toMonacoRange(item.range) : fallback,
      additionalTextEdits: item.additionalTextEdits?.map(edit => ({ range: toMonacoRange(edit.range), text: edit.newText })),
    });
    disposables.push(monaco.languages.registerCompletionItemProvider(selector, {
      triggerCharacters: registration.triggerCharacters,
      async provideCompletionItems(model, position, context, token) {
        const result = await ask(model, position, token, context) as HostCompletionItem[] | { items: HostCompletionItem[]; isIncomplete: boolean } | null;
        const items = Array.isArray(result) ? result : result?.items ?? [];
        const word = model.getWordUntilPosition(position);
        const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
        const path = pathOf(model);
        const suggestions = items.map(item => { const value = convert(item, range, path); if (item.id && path !== null) metadata.set(value, { id: item.id, path }); return value; });
        return { suggestions, incomplete: !Array.isArray(result) && !!result?.isIncomplete,
          dispose() { for (const item of suggestions) metadata.delete(item); } };
      },
      async resolveCompletionItem(item, token) {
        const original = metadata.get(item); if (!original || token.isCancellationRequested) return item;
        const result = await invoke({ path: original.path, action: "resolve", itemId: original.id }, token) as HostCompletionItem | null;
        if (!result) return item;
        const fallback = "insert" in item.range ? item.range.insert : item.range;
        const value = convert(result, fallback, original.path); metadata.set(value, original); return value;
      },
    }));
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
  } else if (registration.kind === "definition" || registration.kind === "typeDefinition" || registration.kind === "implementation" || registration.kind === "declaration") {
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
    else if (registration.kind === "declaration") disposables.push(monaco.languages.registerDeclarationProvider(selector, { provideDeclaration: provide }));
    else disposables.push(monaco.languages.registerImplementationProvider(selector, { provideImplementation: provide }));
  } else if (registration.kind === "signatureHelp") {
    disposables.push(monaco.languages.registerSignatureHelpProvider(selector, {
      signatureHelpTriggerCharacters: registration.triggerCharacters,
      signatureHelpRetriggerCharacters: registration.retriggerCharacters,
      async provideSignatureHelp(model, position, token, context) {
        const help = await ask(model, position, token, context) as monaco.languages.SignatureHelp | null;
        return help ? { value: help, dispose() { /* This result owns no persistent host registrations. */ } } : null;
      },
    }));
  } else if (registration.kind === "selectionRange") {
    type Selection = { range: HostRange; parent?: Selection };
    disposables.push(monaco.languages.registerSelectionRangeProvider(selector, {
      async provideSelectionRanges(model, positions, token) {
        const path = pathOf(model); if (path === null || token.isCancellationRequested) return null;
        const values = await invoke({ path, positions: positions.map(position => ({ line: position.lineNumber - 1, character: position.column - 1 })) }, token) as Selection[] | null;
        return values?.map(value => {
          const result: monaco.languages.SelectionRange[] = [];
          for (let current: Selection | undefined = value; current; current = current.parent) result.push({ range: toMonacoRange(current.range) });
          return result;
        }) ?? null;
      },
    }));
  } else if (registration.kind === "linkedEditing") {
    disposables.push(monaco.languages.registerLinkedEditingRangeProvider(selector, {
      async provideLinkedEditingRanges(model, position, token) {
        const value = await ask(model, position, token) as { ranges: HostRange[]; wordPattern?: { source: string; flags: string } } | null;
        return value ? { ranges: value.ranges.map(toMonacoRange), wordPattern: value.wordPattern ? new RegExp(value.wordPattern.source, value.wordPattern.flags) : undefined } : null;
      },
    }));
  } else if (registration.kind === "onTypeFormatting") {
    disposables.push(monaco.languages.registerOnTypeFormattingEditProvider(selector, {
      autoFormatTriggerCharacters: registration.triggerCharacters ?? [],
      async provideOnTypeFormattingEdits(model, position, character, options, token) {
        const path = pathOf(model); if (path === null || token.isCancellationRequested) return null;
        const values = await invoke({ path, position: { line: position.lineNumber - 1, character: position.column - 1 }, character, options }, token) as { range: HostRange; newText: string }[] | null;
        return values?.map(value => ({ range: toMonacoRange(value.range), text: value.newText })) ?? null;
      },
    }));
  } else if (registration.kind === "documentLink") {
    type Link = { id: string; range: HostRange; target?: string; tooltip?: string };
    const metadata = new WeakMap<monaco.languages.ILink, { path: string; id: string }>();
    disposables.push(monaco.languages.registerLinkProvider(selector, {
      async provideLinks(model, token) {
        const path = pathOf(model); if (path === null || token.isCancellationRequested) return null;
        const values = await ask(model, undefined, token) as Link[] | null;
        if (!values) return null;
        const links = values.map(value => { const link = { range: toMonacoRange(value.range), url: value.target, tooltip: value.tooltip }; metadata.set(link, { path, id: value.id }); return link; });
        return { links, dispose() { for (const link of links) metadata.delete(link); } };
      },
      async resolveLink(link, token) {
        const item = metadata.get(link); if (!item || token.isCancellationRequested) return null;
        const value = await invoke({ path: item.path, action: "resolve", itemId: item.id }, token) as Link | null;
        return value ? { range: toMonacoRange(value.range), url: value.target, tooltip: value.tooltip } : null;
      },
    }));
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

