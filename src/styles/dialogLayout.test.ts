/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Dialogs, menus and the title bar at any window size. Measured in the built app at 640x480 ... 2560x1440: every dialog
// centred and inside the window, menus scrolling when taller than it, the menus folding into ☰ when they don't fit.

const dir = join(process.cwd(), "src", "styles");
const read = (name: string) => readFileSync(join(dir, name), "utf8").replace(/\r\n/g, "\n");
const rule = (css: string, selector: string) => {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
};

describe("dialog layout", () => {
  it("centres every dialog in the window and keeps it inside, scrolling what doesn't fit", () => {
    const overlays = read("overlays.css");
    const overlay = rule(overlays, ".modal-overlay");
    expect(overlay).toContain("align-items: safe center;");
    expect(overlay).toContain("justify-content: safe center;");
    expect(overlay).toContain("padding: var(--modal-margin);");
    expect(overlay).toContain("overflow: auto;");
    expect(overlay).toContain("--modal-max-height: calc(100vh - 2 * var(--modal-margin));");
    const modal = rule(overlays, ".modal");
    expect(modal).toContain("width: min(460px, 100%);");
    expect(modal).toContain("max-height: var(--modal-max-height);");
    expect(modal).toContain("overflow-y: auto;");
  });

  it("has no dialog pinned near the top, pulled up, or sized past the window again", () => {
    for (const name of readdirSync(dir).filter((file) => file.endsWith(".css"))) {
      const css = read(name);
      expect(css, name).not.toMatch(/padding-top: 18vh/);
      expect(css, name).not.toMatch(/margin-top: -\d+vh/);
      // A dialog's height comes from --modal-max-height; a vh cap of its own was what ran past the window.
      for (const match of css.matchAll(/\.modal[^{]*\{[^}]*\}/g)) {
        expect(match[0], `${name}: ${match[0].split("{")[0]}`).not.toMatch(/max-height: \d+vh/);
        expect(match[0], `${name}: ${match[0].split("{")[0]}`).not.toMatch(/width: min\(\d+px, \d+vw\)/);
      }
    }
  });

  it("lets a menu taller than the window scroll", () => {
    const popup = rule(read("menu.css"), ".menu-popup");
    expect(popup).toContain("max-height: calc(100vh - 8px);");
    expect(popup).toContain("overflow-y: auto;");
  });

  it("hides Back/Forward in a narrow window from the stylesheet that loads last", () => {
    const app = read("app.css");
    expect(app.indexOf('@import "./frame.css";')).toBeGreaterThan(app.indexOf('@import "./titlebar.css";'));
    const frame = read("frame.css");
    const base = frame.indexOf(".titlebar__nav {");
    const narrow = frame.indexOf("@media (max-width: 760px) {\n  .titlebar__nav {\n    display: none;");
    expect(narrow).toBeGreaterThan(base);
  });

  it("reflows the Settings page, the Welcome page and extension rows to the room they have", () => {
    expect(read("preferences.css")).toMatch(/\.prefs \{\n {2}container-type: inline-size;/);
    expect(read("frame.css")).toMatch(/@container \(max-width: 640px\) \{\n {2}\.welcome__columns \{\n {4}flex-direction: column;/);
    expect(read("extensionsMarket.css")).toMatch(/@container \(max-width: 300px\) \{[\s\S]*\.ext-icon \{\n {4}display: none;/);
  });
});
