import type { IRange } from "monaco-editor";

import { createRangeFormattingProvider } from "../lspProviders";
import type { FormattingWiringDeps } from "./formattingWiring";

/** Why Format Selection can't run right now, or `undefined`. Only a language server formats part of a document. */
export function formatSelectionReason(deps: FormattingWiringDeps): string | undefined {
  const { editor, documents, workspace, lsp } = deps;
  if (!editor.hasEditor()) return "Open a text file first.";
  const id = workspace.getState().activeId;
  if (id === null || !documents.has(id)) return "Open a text file first.";
  const availability = lsp.available("formatting", id);
  if (!availability.enabled) {
    return `Format Selection needs a running language server that supports formatting (${availability.reason ?? "none is running"}). Built-in and tool formatters format the whole document.`;
  }
  const path = documents.snapshot(id).path;
  if (path === null || lsp.serverForPath(path)?.capabilities?.rangeFormatting !== true) {
    return "The language server for this file can't format a selection. Use Format Document.";
  }
  return undefined;
}

/** Asks the language server to format the selected lines and applies its answer as one undoable edit. */
export async function formatSelection(deps: FormattingWiringDeps): Promise<void> {
  const { editor, documents, workspace, events, lsp, ipc } = deps;
  const problem = formatSelectionReason(deps);
  const id = workspace.getState().activeId;
  if (problem !== undefined || id === null) {
    events.emit("appNotice", { message: problem ?? "Open a text file first." });
    return;
  }
  const model = documents.modelFor(id);
  const uri = documents.modelUri(id);
  const selection = uri === null ? null : editor.selectionsFor(uri)?.[0];
  if (model === null || selection === null || selection === undefined) {
    events.emit("appNotice", { message: "Select the text to format first." });
    return;
  }
  const startFirst =
    selection.anchorLine < selection.activeLine ||
    (selection.anchorLine === selection.activeLine &&
      selection.anchorColumn <= selection.activeColumn);
  const [from, to] = startFirst
    ? [
        [selection.anchorLine, selection.anchorColumn],
        [selection.activeLine, selection.activeColumn],
      ]
    : [
        [selection.activeLine, selection.activeColumn],
        [selection.anchorLine, selection.anchorColumn],
      ];
  if (from[0] === to[0] && from[1] === to[1]) {
    events.emit("appNotice", { message: "Select the text to format first." });
    return;
  }
  const range: IRange = {
    startLineNumber: (from[0] ?? 0) + 1,
    startColumn: (from[1] ?? 0) + 1,
    endLineNumber: (to[0] ?? 0) + 1,
    endColumn: (to[1] ?? 0) + 1,
  };
  const indent = documents.indentUnitOf(id);
  const provider = createRangeFormattingProvider({ ipc, documents, workspace, lsp });
  try {
    const edits = await provider.provideDocumentRangeFormattingEdits(
      model,
      range as never,
      { tabSize: indent === "\t" ? 4 : indent.length, insertSpaces: indent !== "\t" },
      {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose: () => undefined }),
      },
    );
    if (edits === null || edits === undefined) {
      events.emit("appNotice", {
        message: "The language server returned no formatting for the selection.",
      });
      return;
    }
    const before = documents.contentOf(id);
    const after = documents.textWithEdits(id, edits);
    if (after !== before) documents.replaceText(id, after);
  } catch (error) {
    events.emit("appError", { message: `Format Selection failed: ${String(error)}` });
  }
}
