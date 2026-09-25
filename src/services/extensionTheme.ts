import type { ThemeKind } from "./ipc";
import { parseJsonc } from "./jsonc";

export interface MonacoTokenRule {
  token: string;
  foreground?: string;
  fontStyle?: string;
}

/** A colour theme from an extension, translated for this app. */
export interface LoadedExtensionTheme {
  label: string;
  /** Which built-in palette the parts the theme doesn't colour keep (dark, light or high contrast). */
  kind: ThemeKind;
  monaco: {
    base: "vs" | "vs-dark" | "hc-black" | "hc-light";
    inherit: true;
    rules: MonacoTokenRule[];
    colors: Record<string, string>;
  };
  /** CSS custom properties (`--editor-bg`...) the theme sets on top of the palette. */
  tokens: Record<string, string>;
}

/** VS Code workbench colour keys the app has a colour token for. */
export const WORKBENCH_TOKENS: Record<string, string[]> = {
  foreground: ["--fg"],
  focusBorder: ["--focus-border"],
  "editor.background": ["--editor-bg", "--tab-active-bg"],
  "editorGroupHeader.tabsBackground": ["--tabs-bg"],
  "tab.activeBackground": ["--tab-active-bg"],
  "tab.inactiveBackground": ["--tab-inactive-bg"],
  "tab.activeForeground": ["--tab-active-fg"],
  "tab.inactiveForeground": ["--tab-inactive-fg"],
  "activityBar.background": ["--activitybar-bg"],
  "activityBar.foreground": ["--activitybar-fg"],
  "activityBar.inactiveForeground": ["--activitybar-inactive-fg"],
  "sideBar.background": ["--sidebar-bg"],
  "sideBar.foreground": ["--sidebar-fg"],
  "statusBar.background": ["--statusbar-bg"],
  "statusBar.foreground": ["--statusbar-fg"],
  "titleBar.activeBackground": ["--titlebar-bg"],
  "titleBar.activeForeground": ["--titlebar-fg"],
  "panel.background": ["--panel-bg"],
  "button.background": ["--button-bg"],
  "button.foreground": ["--button-fg"],
  "input.background": ["--input-bg"],
  "textLink.foreground": ["--link-fg"],
  "list.activeSelectionBackground": ["--list-active-selection-bg"],
  "list.hoverBackground": ["--list-hover-bg"],
  "menu.background": ["--menu-bg"],
  "terminal.background": ["--terminal-bg"],
  "terminal.foreground": ["--terminal-fg"],
};

/**
 * TextMate scope prefixes -> Monaco token names, first match wins. Monaco colours its own token names
 * (not TextMate scopes), so this is an approximation — the doc for the theme point says so.
 */
const SCOPE_TO_TOKENS: [string, string[]][] = [
  ["comment", ["comment"]],
  ["string.regexp", ["regexp"]],
  ["string", ["string"]],
  ["constant.numeric", ["number"]],
  ["constant.language", ["keyword"]],
  ["constant", ["constant"]],
  ["keyword.operator", ["operator", "delimiter"]],
  ["keyword", ["keyword"]],
  ["storage", ["keyword"]],
  ["entity.name.type", ["type"]],
  ["entity.name.class", ["type"]],
  ["support.type", ["type"]],
  ["support.class", ["type"]],
  ["entity.name.function", ["function", "identifier"]],
  ["support.function", ["function"]],
  ["entity.name.tag", ["tag"]],
  ["entity.other.attribute-name", ["attribute.name"]],
  ["variable", ["variable"]],
  ["punctuation", ["delimiter"]],
  ["invalid", ["invalid"]],
];

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** A colour Monaco and CSS both accept (`#rrggbb` or `#rrggbbaa`), or `null` when the value isn't one. */
export function normalizeColor(value: unknown): string | null {
  if (typeof value !== "string" || !HEX.test(value.trim())) return null;
  const hex = value.trim().slice(1).toLowerCase();
  if (hex.length === 3 || hex.length === 4) {
    return `#${hex.replace(/./g, (digit) => digit + digit)}`;
  }
  return `#${hex}`;
}

function baseFor(uiTheme: string): { base: LoadedExtensionTheme["monaco"]["base"]; kind: ThemeKind } {
  switch (uiTheme) {
    case "vs":
      return { base: "vs", kind: "light" };
    case "hc-black":
      return { base: "hc-black", kind: "high-contrast" };
    case "hc-light":
      return { base: "hc-light", kind: "light" };
    default:
      return { base: "vs-dark", kind: "dark" };
  }
}

function scopes(scope: unknown): string[] {
  if (typeof scope === "string") return scope.split(",").map((part) => part.trim());
  return Array.isArray(scope) ? scope.filter((part): part is string => typeof part === "string") : [];
}

function tokenRules(root: Record<string, unknown>): MonacoTokenRule[] {
  const list = Array.isArray(root.tokenColors)
    ? root.tokenColors
    : Array.isArray(root.settings)
      ? root.settings
      : [];
  const rules: MonacoTokenRule[] = [];
  for (const entry of list as Record<string, unknown>[]) {
    const settings = (entry.settings ?? {}) as Record<string, unknown>;
    const foreground = normalizeColor(settings.foreground);
    const fontStyle = typeof settings.fontStyle === "string" ? settings.fontStyle : undefined;
    if (foreground === null && fontStyle === undefined) continue;
    for (const scope of scopes(entry.scope)) {
      const match = SCOPE_TO_TOKENS.find(([prefix]) => scope === prefix || scope.startsWith(`${prefix}.`));
      for (const token of match?.[1] ?? []) {
        rules.push({
          token,
          ...(foreground === null ? {} : { foreground: foreground.slice(1) }),
          ...(fontStyle === undefined ? {} : { fontStyle }),
        });
      }
    }
  }
  return rules;
}

/**
 * Translates a VS Code colour theme file (JSON with comments) for `uiTheme` (`vs`, `vs-dark`, ...).
 * Editor colours and the token colours Monaco can express go to Monaco; workbench colours the app has a
 * token for go to the CSS tokens. `include` (a theme built on another file) is not followed.
 */
export function parseExtensionTheme(text: string, label: string, uiTheme: string): LoadedExtensionTheme {
  const root = parseJsonc(text);
  if (typeof root !== "object" || root === null || Array.isArray(root)) {
    throw new Error("A colour theme file must be a JSON object.");
  }
  const record = root as Record<string, unknown>;
  const { base, kind } = baseFor(uiTheme);
  const colors: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  const declared = (record.colors ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(declared)) {
    const color = normalizeColor(value);
    if (color === null) continue;
    colors[key] = color;
    for (const token of WORKBENCH_TOKENS[key] ?? []) tokens[token] = color;
  }
  return { label, kind, monaco: { base, inherit: true, rules: tokenRules(record), colors }, tokens };
}
