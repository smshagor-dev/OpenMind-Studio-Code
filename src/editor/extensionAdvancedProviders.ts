import * as monaco from "monaco-editor";
import type {
  ProviderInvoke,
  ProviderRegistration,
} from "../services/extensionHostBridge";
import {
  type HostRange,
  toMonacoRange,
} from "../services/extensionProviderConvert";

interface WireEdit {
  edits: { uri: string; range: HostRange; newText: string; version?: number }[];
}
interface WireItem {
  id: string;
  title: string;
  range: HostRange;
  hasCommand: boolean;
  edit?: WireEdit;
  kind?: string;
  isPreferred?: boolean;
  disabled?: string;
}
const wireRange = (range: monaco.IRange): HostRange => ({
  startLine: range.startLineNumber - 1,
  startColumn: range.startColumn - 1,
  endLine: range.endLineNumber - 1,
  endColumn: range.endColumn - 1,
});
const workspaceEdit = (edit: WireEdit): monaco.languages.WorkspaceEdit => ({
  edits: edit.edits.map((value) => ({
    resource: monaco.Uri.parse(value.uri),
    versionId: value.version,
    textEdit: { range: toMonacoRange(value.range), text: value.newText },
  })),
});

/** Language actions keep extension objects and command arguments in the host. */
export function registerAdvancedHostProvider(
  registration: ProviderRegistration,
  invoke: ProviderInvoke,
  pathOf: (model: monaco.editor.ITextModel) => string | null,
): (() => void) | null {
  const selector = registration.selector;
  const disposables: monaco.IDisposable[] = [];
  const request = (
    model: monaco.editor.ITextModel,
    payload: Omit<Parameters<ProviderInvoke>[0], "path">,
    token: monaco.CancellationToken,
  ) => {
    const path = pathOf(model);
    return path === null || token.isCancellationRequested
      ? Promise.resolve(null)
      : invoke({ path, ...payload }, token);
  };
  if (registration.kind === "rename") {
    disposables.push(
      monaco.languages.registerRenameProvider(selector, {
        async provideRenameEdits(model, position, newName, token) {
          const value = (await request(
            model,
            {
              position: {
                line: position.lineNumber - 1,
                character: position.column - 1,
              },
              newName,
            },
            token,
          )) as WireEdit | null;
          return value ? workspaceEdit(value) : null;
        },
        async resolveRenameLocation(model, position, token) {
          const value = (await request(
            model,
            {
              action: "prepare",
              position: {
                line: position.lineNumber - 1,
                character: position.column - 1,
              },
            },
            token,
          )) as {
            range?: HostRange;
            placeholder?: string;
            defaultBehavior?: boolean;
          } | null;
          if (!value) return null;
          if (value.range) {
            const range = toMonacoRange(value.range);
            return {
              range,
              text: value.placeholder ?? model.getValueInRange(range),
            };
          }
          const word = model.getWordAtPosition(position);
          return word
            ? {
                range: {
                  startLineNumber: position.lineNumber,
                  endLineNumber: position.lineNumber,
                  startColumn: word.startColumn,
                  endColumn: word.endColumn,
                },
                text: word.word,
              }
            : null;
        },
      }),
    );
  } else if (
    registration.kind === "codeAction" ||
    registration.kind === "codeLens" ||
    registration.kind === "inlayHints"
  ) {
    const commandId = `openmind.extensionLanguage.${registration.handle}`;
    const registerCommand = monaco.editor.registerCommand as (
      id: string,
      callback: (...args: unknown[]) => unknown,
    ) => monaco.IDisposable;
    disposables.push(
      registerCommand(
        commandId,
        async (
          _accessor,
          path: unknown,
          itemId: unknown,
          partIndex?: unknown,
        ) => {
          if (typeof path !== "string" || typeof itemId !== "string")
            throw new Error("Invalid extension language command arguments.");
          await invoke({
            path,
            action: "command",
            itemId,
            ...(typeof partIndex === "number" ? { partIndex } : {}),
          });
        },
      ),
    );
    const metadata = new WeakMap<object, { path: string; id: string }>();
    const command = (
      value: WireItem,
      path: string,
    ): monaco.languages.Command | undefined =>
      value.hasCommand
        ? { id: commandId, title: value.title, arguments: [path, value.id] }
        : undefined;
    const release = (path: string, values: WireItem[]) => {
      void invoke({
        path,
        action: "release",
        itemIds: values.map((value) => value.id),
      }).catch(() => undefined);
    };
    if (registration.kind === "inlayHints") {
      interface Hint {
        id: string;
        position: { line: number; character: number };
        kind?: 1 | 2;
        label:
          | string
          | {
              value: string;
              tooltip?: string | { value: string };
              hasCommand?: boolean;
              location?: { uri: string; range: HostRange };
            }[];
        tooltip?: string | { value: string };
        paddingLeft?: boolean;
        paddingRight?: boolean;
        textEdits?: { range: HostRange; newText: string }[];
      }
      const convert = (
        value: Hint,
        path: string,
      ): monaco.languages.InlayHint => {
        const hint = {
          position: {
            lineNumber: value.position.line + 1,
            column: value.position.character + 1,
          },
          label:
            typeof value.label === "string"
              ? value.label
              : value.label.map((part, index) => ({
                  label: part.value,
                  tooltip: part.tooltip,
                  command: part.hasCommand
                    ? {
                        id: commandId,
                        title: part.value,
                        arguments: [path, value.id, index],
                      }
                    : undefined,
                  location: part.location
                    ? {
                        uri: monaco.Uri.parse(part.location.uri),
                        range: toMonacoRange(part.location.range),
                      }
                    : undefined,
                })),
          kind: value.kind === 1 ? monaco.languages.InlayHintKind.Type : value.kind === 2 ? monaco.languages.InlayHintKind.Parameter : undefined,
          tooltip: value.tooltip,
          paddingLeft: value.paddingLeft,
          paddingRight: value.paddingRight,
          textEdits: value.textEdits?.map((edit) => ({
            range: toMonacoRange(edit.range),
            text: edit.newText,
          })),
        };
        metadata.set(hint, { path, id: value.id });
        return hint;
      };
      const changed = new Set<() => void>();
      if (invoke.onDidChange)
        disposables.push(
          invoke.onDidChange(() => {
            for (const listener of changed) listener();
          }),
        );
      disposables.push(
        monaco.languages.registerInlayHintsProvider(selector, {
          onDidChangeInlayHints: (listener) => {
            changed.add(listener);
            return {
              dispose: () => {
                changed.delete(listener);
              },
            };
          },
          async provideInlayHints(model, range, token) {
            const path = pathOf(model);
            if (path === null || token.isCancellationRequested) return null;
            const values = (await request(
              model,
              { range: wireRange(range) },
              token,
            )) as Hint[] | null;
            if (!values) return null;
            const hints = values.map((value) => convert(value, path));
            return {
              hints,
              dispose() {
                for (const hint of hints) metadata.delete(hint);
                void invoke({
                  path,
                  action: "release",
                  itemIds: values.map((value) => value.id),
                }).catch(() => undefined);
              },
            };
          },
          async resolveInlayHint(hint, token) {
            const item = metadata.get(hint);
            if (!item || token.isCancellationRequested) return hint;
            const value = (await invoke(
              { path: item.path, action: "resolve", itemId: item.id },
              token,
            )) as Hint | null;
            return value ? convert(value, item.path) : hint;
          },
        }),
        {
          dispose: () => {
            changed.clear();
          },
        },
      );
    } else if (registration.kind === "codeAction") {
      const convert = (
        value: WireItem,
        path: string,
      ): monaco.languages.CodeAction => {
        const result = {
          title: value.title,
          kind: value.kind,
          isPreferred: value.isPreferred,
          disabled: value.disabled,
          edit: value.edit ? workspaceEdit(value.edit) : undefined,
          command: command(value, path),
        };
        metadata.set(result, { path, id: value.id });
        return result;
      };
      disposables.push(
        monaco.languages.registerCodeActionProvider(
          selector,
          {
            async provideCodeActions(model, range, context, token) {
              const path = pathOf(model);
              if (path === null || token.isCancellationRequested) return null;
              const values = (await request(
                model,
                {
                  range: wireRange(range),
                  context: {
                    only: context.only,
                    triggerKind: context.trigger,
                    diagnostics: context.markers.map((marker) => ({
                      range: wireRange(marker),
                      message: marker.message,
                      severity:
                        marker.severity === monaco.MarkerSeverity.Error
                          ? 0
                          : marker.severity === monaco.MarkerSeverity.Warning
                            ? 1
                            : marker.severity === monaco.MarkerSeverity.Info
                              ? 2
                              : 3,
                      source: marker.source,
                      code:
                        typeof marker.code === "object"
                          ? marker.code.value
                          : marker.code,
                      tags: marker.tags,
                    })),
                  },
                },
                token,
              )) as WireItem[] | null;
              if (!values) return null;
              const actions = values.map((value) => convert(value, path));
              return {
                actions,
                dispose() {
                  for (const action of actions) metadata.delete(action);
                  release(path, values);
                },
              };
            },
            async resolveCodeAction(action, token) {
              const item = metadata.get(action);
              if (!item || token.isCancellationRequested) return action;
              const value = (await invoke(
                { path: item.path, action: "resolve", itemId: item.id },
                token,
              )) as WireItem | null;
              return value ? convert(value, item.path) : action;
            },
          },
          { providedCodeActionKinds: registration.providedCodeActionKinds },
        ),
      );
    } else {
      const convert = (
        value: WireItem,
        path: string,
      ): monaco.languages.CodeLens => {
        const lens = {
          id: value.id,
          range: toMonacoRange(value.range),
          command: command(value, path),
        };
        metadata.set(lens, { path, id: value.id });
        return lens;
      };
      const changed = new Set<() => void>();
      if (invoke.onDidChange)
        disposables.push(
          invoke.onDidChange(() => {
            for (const listener of changed) listener();
          }),
        );
      const provider: monaco.languages.CodeLensProvider = {
        onDidChange: (listener) => {
          const callback = () => {
            listener(provider);
          };
          changed.add(callback);
          return {
            dispose: () => {
              changed.delete(callback);
            },
          };
        },
        async provideCodeLenses(model, token) {
          const path = pathOf(model);
          if (path === null || token.isCancellationRequested) return null;
          const values = (await request(model, {}, token)) as WireItem[] | null;
          if (!values) return null;
          const lenses = values.map((value) => convert(value, path));
          return {
            lenses,
            dispose() {
              for (const lens of lenses) metadata.delete(lens);
              release(path, values);
            },
          };
        },
        async resolveCodeLens(_model, lens, token) {
          const item = metadata.get(lens);
          if (!item || token.isCancellationRequested) return lens;
          const value = (await invoke(
            { path: item.path, action: "resolve", itemId: item.id },
            token,
          )) as WireItem | null;
          return value ? convert(value, item.path) : lens;
        },
      };
      disposables.push(
        {
          dispose: () => {
            changed.clear();
          },
        },
        monaco.languages.registerCodeLensProvider(selector, provider),
      );
    }
  } else if (registration.kind === "color") {
    type Presentation = {
      label: string;
      textEdit?: { range: HostRange; newText: string };
      additionalTextEdits?: { range: HostRange; newText: string }[];
    };
    disposables.push(
      monaco.languages.registerColorProvider(selector, {
        async provideDocumentColors(model, token) {
          const values = (await request(model, {}, token)) as
            { range: HostRange; color: monaco.languages.IColor }[] | null;
          return (
            values?.map((value) => ({
              range: toMonacoRange(value.range),
              color: value.color,
            })) ?? null
          );
        },
        async provideColorPresentations(model, info, token) {
          const values = (await request(
            model,
            {
              action: "present",
              range: wireRange(info.range),
              color: info.color,
            },
            token,
          )) as Presentation[] | null;
          return (
            values?.map((value) => ({
              label: value.label,
              textEdit: value.textEdit
                ? {
                    range: toMonacoRange(value.textEdit.range),
                    text: value.textEdit.newText,
                  }
                : undefined,
              additionalTextEdits: value.additionalTextEdits?.map((edit) => ({
                range: toMonacoRange(edit.range),
                text: edit.newText,
              })),
            })) ?? null
          );
        },
      }),
    );
  } else if (
    registration.kind === "semanticTokens" ||
    registration.kind === "rangeSemanticTokens"
  ) {
    const changed = new Set<() => void>();
    if (invoke.onDidChange)
      disposables.push(
        invoke.onDidChange(() => {
          for (const listener of changed) listener();
        }),
      );
    const common = {
      getLegend: () =>
        registration.legend ?? { tokenTypes: [], tokenModifiers: [] },
      onDidChange: (listener: () => void) => {
        changed.add(listener);
        return {
          dispose: () => {
            changed.delete(listener);
          },
        };
      },
    };
    const convert = (value: { data: number[]; resultId?: string } | null) =>
      value
        ? { data: new Uint32Array(value.data), resultId: value.resultId }
        : null;
    if (registration.kind === "semanticTokens")
      disposables.push(
        monaco.languages.registerDocumentSemanticTokensProvider(selector, {
          ...common,
          async provideDocumentSemanticTokens(model, _lastResultId, token) {
            return convert(
              (await request(model, {}, token)) as {
                data: number[];
                resultId?: string;
              } | null,
            );
          },
          releaseDocumentSemanticTokens() {
            /* Host always requests a full snapshot; no retained result buffers. */
          },
        }),
      );
    else
      disposables.push(
        monaco.languages.registerDocumentRangeSemanticTokensProvider(selector, {
          ...common,
          async provideDocumentRangeSemanticTokens(model, range, token) {
            return convert(
              (await request(model, { range: wireRange(range) }, token)) as {
                data: number[];
                resultId?: string;
              } | null,
            );
          },
        }),
      );
    disposables.push({
      dispose: () => {
        changed.clear();
      },
    });
  } else return null;
  return () => {
    for (const disposable of disposables) disposable.dispose();
  };
}
