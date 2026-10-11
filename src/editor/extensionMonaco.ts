import * as monaco from "monaco-editor";

import type { ProviderInvoke, ProviderRegistration } from "../services/extensionHostBridge";
import type { ContributionBinding } from "../services/extensionContributionService";
import {
  documentationText,
  type HostCompletionItem,
  type HostHover,
  type HostLocation,
  INSERT_AS_SNIPPET,
  monacoCompletionKind,
  toMonacoRange,
} from "../services/extensionProviderConvert";
import type { ExtensionSnippet } from "../services/extensionSnippets";
import type { EditorService } from "../services/editorService";

/** Monaco's snippet completion kind. */
const SNIPPET_KIND = monaco.languages.CompletionItemKind.Snippet;

function languagesOf(registration: ProviderRegistration): string[] {
  const languages = registration.selector.map((entry) => entry.language ?? "*");
  return [...new Set(languages.length === 0 ? ["*"] : languages)];
}

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
 * Registers an extension's completion, hover or definition provider in Monaco; every call goes to the
 * extension host through `invoke`. `pathOf` gives the file of a model (files without one are skipped).
 */
export function registerHostProvider(
  registration: ProviderRegistration,
  invoke: ProviderInvoke,
  pathOf: (model: monaco.editor.ITextModel) => string | null,
): () => void {
  const selector = languagesOf(registration);
  const ask = async (model: monaco.editor.ITextModel, position: monaco.Position) => {
    const path = pathOf(model);
    if (path === null) return null;
    return invoke({
      path,
      position: { line: position.lineNumber - 1, character: position.column - 1 },
    });
  };
  const disposables: monaco.IDisposable[] = [];
  if (registration.kind === "completion") {
    disposables.push(
      monaco.languages.registerCompletionItemProvider(selector, {
        triggerCharacters: registration.triggerCharacters,
        async provideCompletionItems(model, position) {
          const items = ((await ask(model, position)) ?? []) as HostCompletionItem[];
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
        async provideHover(model, position) {
          const hover = (await ask(model, position)) as HostHover | null;
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
  } else {
    disposables.push(
      monaco.languages.registerDefinitionProvider(selector, {
        async provideDefinition(model, position) {
          const locations = ((await ask(model, position)) ?? []) as HostLocation[];
          return locations.map((location) => ({
            uri: monaco.Uri.file(location.path),
            range: toMonacoRange(location.range),
          }));
        },
      }),
    );
  }
  return () => {
    for (const disposable of disposables) disposable.dispose();
  };
}
