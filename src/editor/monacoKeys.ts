import * as monaco from "monaco-editor";

import { LSP_EDITOR_COMMANDS } from "../services/lspCommands";

const NAMED: Record<string, monaco.KeyCode> = {
  Up: monaco.KeyCode.UpArrow,
  Down: monaco.KeyCode.DownArrow,
  Left: monaco.KeyCode.LeftArrow,
  Right: monaco.KeyCode.RightArrow,
  PageUp: monaco.KeyCode.PageUp,
  PageDown: monaco.KeyCode.PageDown,
  Home: monaco.KeyCode.Home,
  End: monaco.KeyCode.End,
  Enter: monaco.KeyCode.Enter,
  Space: monaco.KeyCode.Space,
  Tab: monaco.KeyCode.Tab,
  Backspace: monaco.KeyCode.Backspace,
  Delete: monaco.KeyCode.Delete,
  Insert: monaco.KeyCode.Insert,
  "`": monaco.KeyCode.Backquote,
  "-": monaco.KeyCode.Minus,
  "=": monaco.KeyCode.Equal,
  "[": monaco.KeyCode.BracketLeft,
  "]": monaco.KeyCode.BracketRight,
  "\\": monaco.KeyCode.Backslash,
  ";": monaco.KeyCode.Semicolon,
  "'": monaco.KeyCode.Quote,
  ",": monaco.KeyCode.Comma,
  ".": monaco.KeyCode.Period,
  "/": monaco.KeyCode.Slash,
};

function keyCodeOf(token: string): monaco.KeyCode | null {
  const named = NAMED[token];
  if (named !== undefined) return named;
  if (/^F([1-9]|1\d|2[0-4])$/.test(token)) {
    return (monaco.KeyCode.F1 + Number(token.slice(1)) - 1);
  }
  if (/^[A-Z]$/.test(token)) {
    return (monaco.KeyCode.KeyA + token.charCodeAt(0) - 65);
  }
  if (/^[0-9]$/.test(token)) {
    return (monaco.KeyCode.Digit0 + Number(token));
  }
  if (/^Numpad[0-9]$/.test(token)) {
    return (monaco.KeyCode.Numpad0 + Number(token.slice(6)));
  }
  return null;
}

/** An app chord (`Ctrl+Shift+F5`) as Monaco's numeric keybinding, or `null` if it has no Monaco equivalent. */
export function monacoKeybinding(chord: string): number | null {
  const parts = chord.split("+");
  const key = parts.pop() ?? "";
  const code = keyCodeOf(key);
  if (code === null) return null;
  let value: number = code;
  for (const modifier of parts) {
    if (modifier === "Ctrl") value |= monaco.KeyMod.CtrlCmd;
    else if (modifier === "Shift") value |= monaco.KeyMod.Shift;
    else if (modifier === "Alt") value |= monaco.KeyMod.Alt;
    else return null;
  }
  return value;
}

/**
 * The editor commands whose built-in Monaco shortcut can be turned off and re-bound: the language
 * features, whose Monaco action id is known and whose default key we list ourselves.
 */
export const REMAPPABLE_EDITOR_COMMANDS: ReadonlySet<string> = new Set(
  Object.keys(LSP_EDITOR_COMMANDS),
);

/** Monaco's own action id for a remappable command. */
export function monacoActionFor(command: string): string | null {
  return LSP_EDITOR_COMMANDS[command]?.[1] ?? null;
}

/**
 * Keeps Monaco's built-in shortcuts in step with the user's keybindings: when a language feature
 * (Go to Definition, Rename, Format, References) no longer has its default key, Monaco's own
 * binding for that key is switched off, so the old key doesn't keep working next to the new one.
 * Returns a function that undoes every rule it added.
 */
export function syncMonacoDefaults(
  removedDefaults: { command: string; key: string }[],
  previous: monaco.IDisposable | null,
): monaco.IDisposable | null {
  previous?.dispose();
  const rules: monaco.editor.IKeybindingRule[] = [];
  for (const removed of removedDefaults) {
    const action = monacoActionFor(removed.command);
    const keybinding = monacoKeybinding(removed.key);
    if (action !== null && keybinding !== null) rules.push({ keybinding, command: `-${action}` });
  }
  return rules.length === 0 ? null : monaco.editor.addKeybindingRules(rules);
}
