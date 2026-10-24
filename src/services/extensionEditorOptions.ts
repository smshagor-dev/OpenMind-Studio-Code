/** VS Code's public TextEditorOptions values, independent of Monaco's render options. */
export interface ExtensionEditorOptions {
  tabSize?: number | "auto";
  indentSize?: number | "tabSize";
  insertSpaces?: boolean | "auto";
  cursorStyle?: number;
  lineNumbers?: number;
}
export interface ResolvedEditorOptions {
  tabSize: number;
  indentSize: number;
  insertSpaces: boolean;
  cursorStyle: number;
  lineNumbers: number;
}
export function parseEditorOptions(value: unknown): ExtensionEditorOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Editor options must be an object.");
  const options = value as Record<string, unknown>;
  for (const key of Object.keys(options)) if (!["tabSize", "indentSize", "insertSpaces", "cursorStyle", "lineNumbers"].includes(key)) throw new Error(`Unsupported TextEditorOptions.${key}`);
  const size = (n: unknown): boolean => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 1000;
  const { tabSize, indentSize, insertSpaces, cursorStyle, lineNumbers } = options;
  if (tabSize !== undefined && tabSize !== "auto" && !size(tabSize)) throw new Error("Invalid editor tab size.");
  if (indentSize !== undefined && indentSize !== "tabSize" && !size(indentSize)) throw new Error("Invalid editor indent size.");
  if (insertSpaces !== undefined && insertSpaces !== "auto" && typeof insertSpaces !== "boolean") throw new Error("Invalid editor indentation option.");
  if (cursorStyle !== undefined && (typeof cursorStyle !== "number" || !Number.isInteger(cursorStyle) || cursorStyle < 1 || cursorStyle > 6)) throw new Error("Invalid editor cursor style.");
  if (lineNumbers !== undefined && (typeof lineNumbers !== "number" || !Number.isInteger(lineNumbers) || lineNumbers < 0 || lineNumbers > 2)) throw new Error("Invalid editor line numbers.");
  return options;
}
export const CURSOR_STYLES = ["line", "block", "underline", "line-thin", "block-outline", "underline-thin"] as const;
export const LINE_NUMBERS = ["off", "on", "relative"] as const;
