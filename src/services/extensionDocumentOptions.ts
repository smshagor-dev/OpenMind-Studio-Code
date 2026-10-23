import { type HostRange, parseEdits } from "./hostEdits";

export interface TextDocumentShowOptions {
  viewColumn?: number;
  preserveFocus?: boolean;
  preview?: boolean;
  selection?: HostRange;
}

export function parseTextDocumentShowOptions(raw: Record<string, unknown>): TextDocumentShowOptions {
  const result: TextDocumentShowOptions = {};
  const column = raw.viewColumn;
  if (column !== undefined) {
    if (typeof column !== "number" || !Number.isInteger(column) || (column !== -1 && column !== -2 && (column < 1 || column > 9))) throw new Error("Invalid editor view column.");
    result.viewColumn = column;
  }
  for (const key of ["preserveFocus", "preview"] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== "boolean") throw new Error("Editor show flags must be boolean.");
    result[key] = raw[key];
  }
  if (raw.selection !== undefined) {
    const range = typeof raw.selection === "object" && raw.selection !== null ? raw.selection : {};
    const selection = parseEdits([{ ...range, text: "" }])[0];
    if (!selection || selection.startLine > selection.endLine || (selection.startLine === selection.endLine && selection.startColumn > selection.endColumn)) throw new Error("Invalid editor selection.");
    const { startLine, startColumn, endLine, endColumn } = selection;
    result.selection = { startLine, startColumn, endLine, endColumn };
  }
  return result;
}
