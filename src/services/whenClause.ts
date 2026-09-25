/**
 * A small subset of VS Code's `when` clauses, enough for `viewsWelcome`: `key`, `!key`, `key == value`,
 * `key != value`, `true`/`false`, joined by `&&` and `||` (`&&` binds tighter). An unknown key is
 * `undefined`. Anything else (regex matches, `in`, comparisons, parentheses) counts as true, so an entry
 * is shown rather than hidden by a condition the app can't check.
 */
export type WhenContext = Readonly<Record<string, string | number | boolean | undefined>>;

function literal(raw: string): string | number | boolean {
  const text = raw.trim();
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  const quoted = /^'(.*)'$|^"(.*)"$/.exec(text);
  return quoted ? (quoted[1] ?? quoted[2] ?? "") : text;
}

function term(raw: string, context: WhenContext): boolean {
  const text = raw.trim();
  if (text === "") return true;
  const compare = /^([\w.:-]+)\s*(==|!=)\s*(.+)$/.exec(text);
  if (compare) {
    const [, key = "", op, value = ""] = compare;
    // Loose on purpose, like VS Code: `workspaceFolderCount == 0` compares a number with "0".
    const equal = String(context[key]) === String(literal(value));
    return op === "==" ? equal : !equal;
  }
  const negated = /^!\s*([\w.:-]+)$/.exec(text);
  if (negated) return !context[negated[1] ?? ""];
  if (/^[\w.:-]+$/.test(text)) {
    if (text === "true") return true;
    if (text === "false") return false;
    return Boolean(context[text]);
  }
  return true;
}

export function evaluateWhen(clause: string | null | undefined, context: WhenContext): boolean {
  if (clause === null || clause === undefined || clause.trim() === "") return true;
  return clause.split("||").some((any) => any.split("&&").every((all) => term(all, context)));
}
