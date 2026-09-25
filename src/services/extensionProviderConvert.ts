/** What the extension host returns for language features, and how it maps to Monaco (1-based positions). */

export interface HostRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface HostCompletionItem {
  label: string;
  /** VS Code's `CompletionItemKind`. */
  kind?: number;
  detail?: string;
  documentation?: string | { value: string };
  insertText?: string | { snippet: string };
  sortText?: string;
  filterText?: string;
}

export interface HostHover {
  contents: (string | { value: string })[];
  range?: HostRange;
}

export interface HostLocation {
  path: string;
  range: HostRange;
}

/** Monaco's `CompletionItemKind` for each VS Code kind, indexed by the VS Code number. */
const KIND_TO_MONACO = [
  18, // Text
  0, // Method
  1, // Function
  2, // Constructor
  3, // Field
  4, // Variable
  5, // Class
  7, // Interface
  8, // Module
  9, // Property
  12, // Unit
  13, // Value
  15, // Enum
  17, // Keyword
  27, // Snippet
  19, // Color
  20, // File
  21, // Reference
  22, // Folder
  16, // EnumMember
  14, // Constant
  6, // Struct
  10, // Event
  11, // Operator
  23, // TypeParameter
];

export function monacoCompletionKind(kind: number | undefined): number {
  return kind === undefined ? 18 : (KIND_TO_MONACO[kind] ?? 18);
}

/** Monaco's `InsertAsSnippet` rule. */
export const INSERT_AS_SNIPPET = 4;

/** VS Code's `DiagnosticSeverity` (0 Error ... 3 Hint) -> Monaco's `MarkerSeverity`. */
export function markerSeverity(severity: number): number {
  switch (severity) {
    case 0:
      return 8;
    case 1:
      return 4;
    case 2:
      return 2;
    default:
      return 1;
  }
}

/** A host (0-based) range as Monaco's 1-based one. */
export function toMonacoRange(range: HostRange): {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
} {
  return {
    startLineNumber: range.startLine + 1,
    startColumn: range.startColumn + 1,
    endLineNumber: range.endLine + 1,
    endColumn: range.endColumn + 1,
  };
}

export function documentationText(value: HostCompletionItem["documentation"]): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : value.value;
}

export interface MarkerInput {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  message: string;
  severity: number;
  source?: string;
  code?: string;
}

export function toMarkers(
  diagnostics: {
    range: HostRange;
    message: string;
    severity: number;
    source?: string;
    code?: string;
  }[],
): MarkerInput[] {
  return diagnostics.map((diagnostic) => ({
    ...toMonacoRange(diagnostic.range),
    message: diagnostic.message,
    severity: markerSeverity(diagnostic.severity),
    ...(diagnostic.source === undefined ? {} : { source: diagnostic.source }),
    ...(diagnostic.code === undefined ? {} : { code: diagnostic.code }),
  }));
}
