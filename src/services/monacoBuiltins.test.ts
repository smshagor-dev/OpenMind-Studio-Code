import * as monaco from "monaco-editor";
import { describe, expect, it } from "vitest";

import { disableBuiltinLanguageServices } from "./monacoBuiltins";

describe("Monaco's own language services step aside for the language servers", () => {
  it("every built-in feature of TypeScript/JavaScript, JSON, CSS and HTML is off", () => {
    disableBuiltinLanguageServices();
    const all = [
      monaco.typescript.typescriptDefaults,
      monaco.typescript.javascriptDefaults,
      monaco.json.jsonDefaults,
      monaco.css.cssDefaults,
      monaco.css.scssDefaults,
      monaco.css.lessDefaults,
      monaco.html.htmlDefaults,
    ];
    for (const defaults of all) {
      const config = defaults.modeConfiguration as Record<string, boolean>;
      expect(Object.keys(config).length).toBeGreaterThan(0);
      expect(Object.values(config).every((enabled) => !enabled)).toBe(true);
    }
  });

  it("is safe to call twice", () => {
    disableBuiltinLanguageServices();
    disableBuiltinLanguageServices();
    expect(monaco.json.jsonDefaults.modeConfiguration.hovers).toBe(false);
  });
});
