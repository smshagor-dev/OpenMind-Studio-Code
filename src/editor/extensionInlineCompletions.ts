import * as monaco from "monaco-editor";
import type {
  ProviderInvoke,
  ProviderRegistration,
} from "../services/extensionHostBridge";
import {
  type HostRange,
  toMonacoRange,
} from "../services/extensionProviderConvert";

interface WireItem {
  id: string;
  insertText: string | { snippet: string };
  range?: HostRange;
  filterText?: string;
  hasCommand: boolean;
}

export function registerInlineHostProvider(
  registration: ProviderRegistration,
  invoke: ProviderInvoke,
  pathOf: (model: monaco.editor.ITextModel) => string | null,
): (() => void) | null {
  if (registration.kind !== "inlineCompletion") return null;
  const commandId = `openmind.extensionInline.${registration.handle}`;
  const registerCommand = monaco.editor.registerCommand as (
    id: string,
    callback: (...args: unknown[]) => unknown,
  ) => monaco.IDisposable;
  const command = registerCommand(
    commandId,
    async (_accessor, path: unknown, itemId: unknown) => {
      if (typeof path !== "string" || typeof itemId !== "string")
        throw new Error("Invalid inline completion command arguments.");
      await invoke({ path, itemId, action: "command" });
    },
  );
  const lists = new WeakMap<
    monaco.languages.InlineCompletions,
    { path: string; ids: string[] }
  >();
  const provider = monaco.languages.registerInlineCompletionsProvider(
    registration.selector,
    {
      async provideInlineCompletions(model, position, context, token) {
        const cancelled = () => token.isCancellationRequested;
        const path = pathOf(model);
        if (path === null || cancelled()) return null;
        const version = model.getVersionId();
        const selected = context.selectedSuggestionInfo;
        const values = (await invoke(
          {
            path,
            position: {
              line: position.lineNumber - 1,
              character: position.column - 1,
            },
            context: {
              triggerKind:
                context.triggerKind ===
                monaco.languages.InlineCompletionTriggerKind.Explicit
                  ? 0
                  : 1,
              selectedCompletionInfo: selected
                ? {
                    range: {
                      startLine: selected.range.startLineNumber - 1,
                      startColumn: selected.range.startColumn - 1,
                      endLine: selected.range.endLineNumber - 1,
                      endColumn: selected.range.endColumn - 1,
                    },
                    text: selected.text,
                  }
                : undefined,
            },
          },
          token,
        )) as WireItem[] | null;
        if (!values) return null;
        const release = () => {
          void invoke({
            path,
            action: "release",
            itemIds: values.map((value) => value.id),
          }).catch(() => undefined);
        };
        if (
          cancelled() ||
          model.isDisposed() ||
          model.getVersionId() !== version
        ) {
          release();
          return null;
        }
        const items = values.flatMap((value) => {
          const word = model.getWordAtPosition(position);
          const range = value.range
            ? toMonacoRange(value.range)
            : {
                startLineNumber: position.lineNumber,
                endLineNumber: position.lineNumber,
                startColumn: word?.startColumn ?? position.column,
                endColumn: word?.endColumn ?? position.column,
              };
          if (
            value.filterText &&
            !value.filterText.startsWith(model.getValueInRange(range))
          )
            return [];
          return [
            {
              insertText: value.insertText,
              range,
              command: value.hasCommand
                ? {
                    id: commandId,
                    title: "Accept inline completion",
                    arguments: [path, value.id],
                  }
                : undefined,
            },
          ];
        });
        const list = { items };
        lists.set(list, { path, ids: values.map((value) => value.id) });
        return list;
      },
      disposeInlineCompletions(list) {
        const state = lists.get(list);
        if (!state) return;
        lists.delete(list);
        void invoke({
          path: state.path,
          action: "release",
          itemIds: state.ids,
        }).catch(() => undefined);
      },
    },
  );
  return () => {
    provider.dispose();
    command.dispose();
  };
}
