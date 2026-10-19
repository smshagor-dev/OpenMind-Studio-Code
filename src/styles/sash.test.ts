/// <reference types="node" />
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const STYLES = dirname(fileURLToPath(import.meta.url));
const read = (name: string) => readFileSync(join(STYLES, name), "utf8");

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): string {
  const match = new RegExp(`(^|\\n)${selector.replace(/[.]/g, "\\.")}\\s*\\{([^}]*)\\}`).exec(css);
  expect(match, `${selector} rule`).not.toBeNull();
  return match?.[2] ?? "";
}

describe("side bar sash", () => {
  it("lies inside the side bar, because the card around it clips anything past its edge", () => {
    expect(rule(read("frame.css"), ".workbench__side")).toMatch(/overflow:\s*hidden/);
    const sidebar = read("sidebar.css");
    for (const [selector, side] of [
      [".sash--right", "right"],
      [".sash--left", "left"],
    ] as const) {
      const offset = new RegExp(`${side}:\\s*(-?\\d+)px|${side}:\\s*0\\b`).exec(rule(sidebar, selector));
      expect(offset, `${selector} sets ${side}`).not.toBeNull();
      expect(Number(offset?.[1] ?? 0), `${selector} must not stick out of the clipped card`).toBeGreaterThanOrEqual(0);
    }
    expect(rule(sidebar, ".sash")).toMatch(/width:\s*4px/);
  });
});
