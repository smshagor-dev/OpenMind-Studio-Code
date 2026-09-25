/** One text edit as the extension host sends it: 0-based line and column (UTF-16), like VS Code's `Range`. */
export interface HostTextEdit {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  text: string;
}

/** A selection in host coordinates (0-based); the anchor is where it started, the active end is the cursor. */
export interface HostSelection {
  anchorLine: number;
  anchorColumn: number;
  activeLine: number;
  activeColumn: number;
}

export interface HostRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

/** How the app answers an edit request: applied, or why not (shown in the Extension Host log). */
export interface EditResult {
  applied: boolean;
  reason?: string;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Reads a list of edits sent over the bridge; anything malformed is refused with a clear message. */
export function parseEdits(value: unknown): HostTextEdit[] {
  if (!Array.isArray(value)) throw new Error("The edits must be a list.");
  return value.map((raw: unknown) => {
    const edit = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const { startLine, startColumn, endLine, endColumn, text } = edit;
    if (
      !isNumber(startLine) ||
      !isNumber(startColumn) ||
      !isNumber(endLine) ||
      !isNumber(endColumn) ||
      typeof text !== "string"
    ) {
      throw new Error("An edit needs a range (line and column numbers) and a text.");
    }
    return { startLine, startColumn, endLine, endColumn, text };
  });
}

export function parseSelections(value: unknown): HostSelection[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("A selection list is needed.");
  return value.map((raw: unknown) => {
    const s = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const { anchorLine, anchorColumn, activeLine, activeColumn } = s;
    if (
      !isNumber(anchorLine) ||
      !isNumber(anchorColumn) ||
      !isNumber(activeLine) ||
      !isNumber(activeColumn)
    ) {
      throw new Error("A selection needs line and column numbers.");
    }
    return { anchorLine, anchorColumn, activeLine, activeColumn };
  });
}
