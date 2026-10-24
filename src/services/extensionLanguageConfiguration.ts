import * as monaco from "monaco-editor";

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid language configuration object.");
  return value as ObjectValue;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid language configuration text.");
  return value;
}
function array<T>(value: unknown, convert: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Error("Invalid language configuration array.");
  return value.map(convert);
}
function pair(value: unknown): [string, string] {
  if (!Array.isArray(value) || value.length !== 2) throw new Error("Invalid language character pair.");
  return [text(value[0]), text(value[1])];
}
function regex(value: unknown): RegExp {
  const v = object(value);
  return new RegExp(text(v.source), text(v.flags));
}

/** Decode the intentionally small public VS Code configuration wire format. */
export function parseLanguageConfiguration(value: unknown): monaco.languages.LanguageConfiguration {
  const v = object(value);
  const result: monaco.languages.LanguageConfiguration = {};
  for (const key of Object.keys(v)) if (!["comments", "brackets", "wordPattern", "indentationRules", "onEnterRules", "autoClosingPairs", "__electricCharacterSupport"].includes(key)) throw new Error(`Unknown language configuration field: ${key}`);
  if (v.comments !== undefined) {
    const c = object(v.comments); result.comments = {};
    if (c.lineComment !== undefined) result.comments.lineComment = text(c.lineComment);
    if (c.blockComment !== undefined) result.comments.blockComment = pair(c.blockComment);
  }
  if (v.brackets !== undefined) result.brackets = array(v.brackets, pair);
  if (v.wordPattern !== undefined) result.wordPattern = regex(v.wordPattern);
  if (v.indentationRules !== undefined) {
    const r = object(v.indentationRules);
    result.indentationRules = { increaseIndentPattern: regex(r.increaseIndentPattern), decreaseIndentPattern: regex(r.decreaseIndentPattern) };
    if (r.indentNextLinePattern !== undefined) result.indentationRules.indentNextLinePattern = regex(r.indentNextLinePattern);
    if (r.unIndentedLinePattern !== undefined) result.indentationRules.unIndentedLinePattern = regex(r.unIndentedLinePattern);
  }
  if (v.onEnterRules !== undefined) result.onEnterRules = array(v.onEnterRules, value => {
    const r = object(value); const a = object(r.action);
    if (typeof a.indentAction !== "number" || !Number.isInteger(a.indentAction) || a.indentAction < 0 || a.indentAction > 3) throw new Error("Invalid indent action.");
    const action = [monaco.languages.IndentAction.None, monaco.languages.IndentAction.Indent, monaco.languages.IndentAction.IndentOutdent, monaco.languages.IndentAction.Outdent][a.indentAction];
    if (action === undefined) throw new Error("Invalid indent action.");
    const rule: monaco.languages.OnEnterRule = { beforeText: regex(r.beforeText), action: { indentAction: action } };
    if (r.afterText !== undefined) rule.afterText = regex(r.afterText);
    if (r.previousLineText !== undefined) rule.previousLineText = regex(r.previousLineText);
    if (a.appendText !== undefined) rule.action.appendText = text(a.appendText);
    if (a.removeText !== undefined) {
      if (typeof a.removeText !== "number" || !Number.isSafeInteger(a.removeText) || a.removeText < 0) throw new Error("Invalid indentation removal.");
      rule.action.removeText = a.removeText;
    }
    return rule;
  });
  if (v.autoClosingPairs !== undefined) result.autoClosingPairs = array(v.autoClosingPairs, value => {
    const p = object(value);
    return { open: text(p.open), close: text(p.close), ...(p.notIn === undefined ? {} : { notIn: array(p.notIn, text) }) };
  });
  if (v.__electricCharacterSupport !== undefined) {
    const c = object(object(v.__electricCharacterSupport).docComment);
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- Preserve the baseline deprecated doc-comment API.
    result.__electricCharacterSupport = { docComment: { open: text(c.open), ...(c.close === undefined ? {} : { close: text(c.close) }) } };
  }
  return result;
}

export function registerLanguageConfiguration(language: string, configuration: unknown): () => void {
  const parsed = parseLanguageConfiguration(configuration);
  const disposable = monaco.languages.setLanguageConfiguration(language, parsed);
  return () => { disposable.dispose(); };
}
