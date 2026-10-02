import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

function zIndex(css: string, selector: string): number {
  const rule = new RegExp(`${selector.replace(/[.-]/g, (c) => `\\${c}`)} \\{[^}]*z-index: (\\d+);`).exec(css);
  return Number(rule?.[1] ?? Number.NaN);
}

describe("prompt layer", () => {
  it("confirmations, pickers and input boxes sit above other dialogs (e.g. Remove in the Runtime Manager)", () => {
    const css = read("src/styles/overlays.css");
    expect(zIndex(css, ".modal-overlay--prompt")).toBeGreaterThan(zIndex(css, ".modal-overlay"));
    const prompts = read("src/components/ExtensionPrompts.tsx");
    const overlays = prompts.match(/className="modal-overlay[^"]*"/g) ?? [];
    expect(overlays.length).toBeGreaterThan(0);
    for (const overlay of overlays) expect(overlay).toContain("modal-overlay--prompt");
  });
});
