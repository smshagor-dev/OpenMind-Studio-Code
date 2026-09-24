import * as monaco from "monaco-editor";

import type { LspDiagnostic, LspPosition, LspRange } from "./ipc";
import { uriToPath } from "./lspUri";

/**
 * Pure conversions between what a language server sends (LSP: 0-based lines,
 * UTF-16 columns, its own kinds and markup) and what Monaco takes (1-based).
 * No IPC, no services — everything here is testable with plain objects.
 */

// --- Positions and ranges ---

export function toLspPosition(position: { lineNumber: number; column: number }): LspPosition {
  return { line: position.lineNumber - 1, character: position.column - 1 };
}

export function toMonacoRange(range: LspRange): monaco.IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

// --- Diagnostics ---

const SEVERITY: Record<number, monaco.MarkerSeverity> = {
  1: monaco.MarkerSeverity.Error,
  2: monaco.MarkerSeverity.Warning,
  3: monaco.MarkerSeverity.Info,
  4: monaco.MarkerSeverity.Hint,
};

/** A server that gives no severity is reporting an error (the LSP spec leaves it to the client; VS Code does the same). */
export function toMarker(diagnostic: LspDiagnostic): monaco.editor.IMarkerData {
  const range = toMonacoRange(diagnostic.range);
  const tags: monaco.MarkerTag[] = [];
  if (diagnostic.tags?.includes(1)) tags.push(monaco.MarkerTag.Unnecessary);
  if (diagnostic.tags?.includes(2)) tags.push(monaco.MarkerTag.Deprecated);
  return {
    severity: SEVERITY[diagnostic.severity ?? 1] ?? monaco.MarkerSeverity.Error,
    message: diagnostic.message,
    source: diagnostic.source,
    code: diagnostic.code === undefined ? undefined : String(diagnostic.code),
    startLineNumber: range.startLineNumber,
    startColumn: range.startColumn,
    endLineNumber: range.endLineNumber,
    endColumn: range.endColumn,
    tags: tags.length > 0 ? tags : undefined,
  };
}

// --- Markup (hover, documentation) ---

interface MarkupContent {
  kind: "plaintext" | "markdown";
  value: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMarkup(value: unknown): value is MarkupContent {
  return isRecord(value) && typeof value.value === "string" && typeof value.kind === "string";
}

/** Plain text is shown as it is (escaped by Monaco); markdown goes through Monaco's markdown renderer. */
export function toDocumentation(value: unknown): string | monaco.IMarkdownString | undefined {
  if (typeof value === "string") return value;
  if (isMarkup(value)) return value.kind === "markdown" ? { value: value.value } : value.value;
  return undefined;
}

/** LSP `MarkedString`: a string (markdown) or `{language, value}` (a code block). */
function markedString(value: unknown): monaco.IMarkdownString | null {
  if (typeof value === "string") return value === "" ? null : { value };
  if (isRecord(value) && typeof value.value === "string") {
    if (typeof value.language === "string") {
      return { value: "```" + value.language + "\n" + value.value + "\n```" };
    }
    // A `MarkupContent`.
    return value.kind === "plaintext"
      ? { value: escapeMarkdown(value.value) }
      : { value: value.value };
  }
  return null;
}

function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_{}[\]()#+\-.!<>])/g, "\\$1");
}

export function convertHover(result: unknown): monaco.languages.Hover | null {
  if (!isRecord(result)) return null;
  const contents = Array.isArray(result.contents)
    ? (result.contents as unknown[])
    : [result.contents];
  const parts = contents
    .map(markedString)
    .filter((part): part is monaco.IMarkdownString => part !== null);
  if (parts.length === 0) return null;
  const range = isRange(result.range) ? toMonacoRange(result.range) : undefined;
  return { contents: parts, range };
}

function isPosition(value: unknown): value is LspPosition {
  return isRecord(value) && typeof value.line === "number" && typeof value.character === "number";
}

function isRange(value: unknown): value is LspRange {
  return isRecord(value) && isPosition(value.start) && isPosition(value.end);
}

// --- Locations (definition, references, ...) ---

export interface LspLocation {
  /** The file (forward slashes). */
  path: string;
  range: LspRange;
}

/** `Location | Location[] | LocationLink[] | null` → plain locations. Non-file URIs are dropped. */
export function convertLocations(result: unknown): LspLocation[] {
  const items = Array.isArray(result) ? (result as unknown[]) : result == null ? [] : [result];
  const locations: LspLocation[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const uri = typeof item.uri === "string" ? item.uri : item.targetUri;
    const range = isRange(item.range) ? item.range : item.targetSelectionRange;
    if (typeof uri !== "string" || !isRange(range)) continue;
    const path = uriToPath(uri);
    if (path !== null) locations.push({ path, range });
  }
  return locations;
}

// --- Completion ---

const K = monaco.languages.CompletionItemKind;
const COMPLETION_KINDS: Record<number, monaco.languages.CompletionItemKind> = {
  1: K.Text,
  2: K.Method,
  3: K.Function,
  4: K.Constructor,
  5: K.Field,
  6: K.Variable,
  7: K.Class,
  8: K.Interface,
  9: K.Module,
  10: K.Property,
  11: K.Unit,
  12: K.Value,
  13: K.Enum,
  14: K.Keyword,
  15: K.Snippet,
  16: K.Color,
  17: K.File,
  18: K.Reference,
  19: K.Folder,
  20: K.EnumMember,
  21: K.Constant,
  22: K.Struct,
  23: K.Event,
  24: K.Operator,
  25: K.TypeParameter,
};

export interface LspTextEdit {
  range: LspRange;
  newText: string;
}

function isTextEdit(value: unknown): value is LspTextEdit {
  return isRecord(value) && isRange(value.range) && typeof value.newText === "string";
}

/** A completion item as Monaco takes it, remembering the server's own item so it can be resolved later. */
export interface LspCompletionItem extends monaco.languages.CompletionItem {
  lspItem?: unknown;
}

export function convertCompletionItem(
  raw: unknown,
  defaultRange: monaco.IRange,
): LspCompletionItem | null {
  if (!isRecord(raw) || typeof raw.label !== "string") return null;
  const edit = raw.textEdit;
  let range: monaco.IRange | monaco.languages.CompletionItemRanges = defaultRange;
  let insertText = typeof raw.insertText === "string" ? raw.insertText : raw.label;
  if (isTextEdit(edit)) {
    range = toMonacoRange(edit.range);
    insertText = edit.newText;
  } else if (
    isRecord(edit) &&
    isRange(edit.insert) &&
    isRange(edit.replace) &&
    typeof edit.newText === "string"
  ) {
    range = { insert: toMonacoRange(edit.insert), replace: toMonacoRange(edit.replace) };
    insertText = edit.newText;
  }
  const kind = typeof raw.kind === "number" ? COMPLETION_KINDS[raw.kind] : undefined;
  const additional = Array.isArray(raw.additionalTextEdits)
    ? (raw.additionalTextEdits as unknown[]).filter(isTextEdit).map(convertTextEdit)
    : undefined;
  return {
    label:
      isRecord(raw.labelDetails) && typeof raw.labelDetails.detail === "string"
        ? { label: raw.label, detail: raw.labelDetails.detail }
        : raw.label,
    kind: kind ?? K.Text,
    detail: typeof raw.detail === "string" ? raw.detail : undefined,
    documentation: toDocumentation(raw.documentation),
    insertText,
    insertTextRules:
      raw.insertTextFormat === 2
        ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
        : undefined,
    range,
    filterText: typeof raw.filterText === "string" ? raw.filterText : undefined,
    sortText: typeof raw.sortText === "string" ? raw.sortText : undefined,
    preselect: raw.preselect === true ? true : undefined,
    tags:
      Array.isArray(raw.tags) && (raw.tags as unknown[]).includes(1)
        ? [monaco.languages.CompletionItemTag.Deprecated]
        : undefined,
    commitCharacters: Array.isArray(raw.commitCharacters)
      ? (raw.commitCharacters as unknown[]).filter((c): c is string => typeof c === "string")
      : undefined,
    additionalTextEdits: additional,
    lspItem: raw,
  };
}

export function convertCompletionList(
  result: unknown,
  defaultRange: monaco.IRange,
): monaco.languages.CompletionList {
  const rawItems = Array.isArray(result)
    ? (result as unknown[])
    : isRecord(result) && Array.isArray(result.items)
      ? (result.items as unknown[])
      : [];
  const suggestions = rawItems
    .map((item) => convertCompletionItem(item, defaultRange))
    .filter((item): item is LspCompletionItem => item !== null);
  return {
    suggestions,
    incomplete: isRecord(result) && result.isIncomplete === true,
  };
}

// --- Edits ---

function convertTextEdit(edit: LspTextEdit): monaco.languages.TextEdit {
  return { range: toMonacoRange(edit.range), text: edit.newText };
}

export function convertTextEdits(result: unknown): monaco.languages.TextEdit[] {
  return Array.isArray(result) ? (result as unknown[]).filter(isTextEdit).map(convertTextEdit) : [];
}

export interface FileEdits {
  path: string;
  edits: LspTextEdit[];
}

export interface ConvertedWorkspaceEdit {
  files: FileEdits[];
  /** Set when the server asked for something other than text edits (create/rename/delete a file). */
  unsupported: string | null;
}

/** `WorkspaceEdit` (`changes` or `documentChanges`) → text edits per file. */
export function convertWorkspaceEdit(result: unknown): ConvertedWorkspaceEdit {
  const byPath = new Map<string, LspTextEdit[]>();
  let unsupported: string | null = null;
  const add = (uri: unknown, edits: unknown) => {
    const path = typeof uri === "string" ? uriToPath(uri) : null;
    if (path === null || !Array.isArray(edits)) return;
    const list = byPath.get(path) ?? [];
    list.push(...(edits as unknown[]).filter(isTextEdit));
    byPath.set(path, list);
  };
  if (isRecord(result)) {
    if (isRecord(result.changes)) {
      for (const [uri, edits] of Object.entries(result.changes)) add(uri, edits);
    }
    if (Array.isArray(result.documentChanges)) {
      for (const change of result.documentChanges as unknown[]) {
        if (!isRecord(change)) continue;
        if (isRecord(change.textDocument) && Array.isArray(change.edits)) {
          add(change.textDocument.uri, change.edits);
        } else if (typeof change.kind === "string") {
          unsupported = `The server asked to ${change.kind} a file, which isn't supported yet.`;
        }
      }
    }
  }
  return { files: [...byPath].map(([path, edits]) => ({ path, edits })), unsupported };
}

// --- Symbols ---

function symbolKind(kind: unknown): monaco.languages.SymbolKind {
  // Monaco's symbol kinds are LSP's, counted from 0.
  return typeof kind === "number" ? Math.max(0, kind - 1) : 0;
}

/** `DocumentSymbol[]` (hierarchical) or `SymbolInformation[]` (flat) → Monaco symbols. */
export function convertSymbols(result: unknown): monaco.languages.DocumentSymbol[] {
  if (!Array.isArray(result)) return [];
  const symbols: monaco.languages.DocumentSymbol[] = [];
  for (const item of result as unknown[]) {
    if (!isRecord(item) || typeof item.name !== "string") continue;
    const location = isRecord(item.location) ? item.location : null;
    const range = isRange(item.range)
      ? item.range
      : location && isRange(location.range)
        ? location.range
        : null;
    if (range === null) continue;
    const selection = isRange(item.selectionRange) ? item.selectionRange : range;
    symbols.push({
      name: item.name,
      detail: typeof item.detail === "string" ? item.detail : "",
      kind: symbolKind(item.kind),
      tags: [],
      containerName: typeof item.containerName === "string" ? item.containerName : undefined,
      range: toMonacoRange(range),
      selectionRange: toMonacoRange(selection),
      children: Array.isArray(item.children) ? convertSymbols(item.children) : undefined,
    });
  }
  return symbols;
}

// --- Signature help ---

export function convertSignatureHelp(result: unknown): monaco.languages.SignatureHelp | null {
  if (!isRecord(result) || !Array.isArray(result.signatures)) return null;
  const signatures: monaco.languages.SignatureInformation[] = [];
  for (const raw of result.signatures as unknown[]) {
    if (!isRecord(raw) || typeof raw.label !== "string") continue;
    const parameters = Array.isArray(raw.parameters)
      ? (raw.parameters as unknown[]).flatMap((parameter) =>
          isRecord(parameter) &&
          (typeof parameter.label === "string" || Array.isArray(parameter.label))
            ? [
                {
                  label: parameter.label as string | [number, number],
                  documentation: toDocumentation(parameter.documentation),
                },
              ]
            : [],
        )
      : [];
    signatures.push({
      label: raw.label,
      documentation: toDocumentation(raw.documentation),
      parameters,
    });
  }
  if (signatures.length === 0) return null;
  return {
    signatures,
    activeSignature: typeof result.activeSignature === "number" ? result.activeSignature : 0,
    activeParameter: typeof result.activeParameter === "number" ? result.activeParameter : 0,
  };
}
