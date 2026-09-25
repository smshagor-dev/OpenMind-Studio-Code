/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const STYLES = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(STYLES).filter((name) => name.endsWith(".css"));
const read = (name: string) => readFileSync(join(STYLES, name), "utf8");
const theme = read("theme.css");

/** Text with every `var(--x, fallback)` reduced to `var(--x)`: fallbacks are allowed to hold a raw color. */
function withoutFallbacks(css: string): string {
  return css.replace(/var\((--[a-z0-9-]+),[^)]*\)/g, "var($1)");
}

function block(selector: string): string {
  const start = theme.indexOf(selector);
  expect(start, `${selector} block`).toBeGreaterThanOrEqual(0);
  const open = theme.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < theme.length; i++) {
    if (theme[i] === "{") depth++;
    if (theme[i] === "}" && --depth === 0) return theme.slice(open, i);
  }
  return theme.slice(open);
}

describe("theme tokens", () => {
  it("there is a dark, a light and a high-contrast palette on <html>", () => {
    expect(theme).toContain(':root[data-theme="dark"]');
    expect(theme).toContain(':root[data-theme="light"]');
    expect(theme).toContain(':root[data-theme="high-contrast"]');
  });

  it("every color token the app uses is defined", () => {
    const defined = new Set<string>();
    for (const name of files) {
      for (const match of read(name).matchAll(/(--[a-z0-9-]+)\s*:/g)) defined.add(match[1] ?? "");
    }
    const undefinedTokens = new Set<string>();
    for (const name of files) {
      for (const match of read(name).matchAll(/var\((--[a-z0-9-]+)/g)) {
        const token = match[1] ?? "";
        if (!defined.has(token)) undefinedTokens.add(`${token} (${name})`);
      }
    }
    expect([...undefinedTokens]).toEqual([]);
  });

  it("no component stylesheet hard-codes a color: everything comes from a token", () => {
    const offenders: string[] = [];
    for (const name of files.filter((file) => file !== "theme.css")) {
      const css = withoutFallbacks(read(name)).replace(/\/\*[\s\S]*?\*\//g, "");
      css.split("\n").forEach((line, index) => {
        if (/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(line)) {
          offenders.push(`${name}:${String(index + 1)}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("the high-contrast palette overrides the surfaces that make up the workbench", () => {
    const hc = block(':root[data-theme="high-contrast"]');
    for (const token of [
      "--editor-bg",
      "--sidebar-bg",
      "--activitybar-bg",
      "--statusbar-bg",
      "--tabs-bg",
      "--panel-bg",
      "--titlebar-bg",
      "--menu-bg",
      "--border",
      "--card-border",
      "--focus-border",
      "--fg",
      "--terminal-bg",
      "--terminal-fg",
    ]) {
      expect(hc, token).toContain(`${token}:`);
    }
  });

  it("the terminal has its own tokens in every theme", () => {
    for (const selector of [
      ':root[data-theme="dark"]',
      ':root[data-theme="light"]',
      ':root[data-theme="high-contrast"]',
    ]) {
      const palette = block(selector);
      expect(palette, selector).toContain("--terminal-bg:");
      expect(palette, selector).toContain("--terminal-fg:");
    }
  });
});
