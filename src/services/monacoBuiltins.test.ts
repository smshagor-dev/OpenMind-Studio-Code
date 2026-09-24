import * as monaco from "monaco-editor";
import { afterEach, describe, expect, it } from "vitest";

import { applyBuiltinFeatures, disableTypeScriptBuiltins } from "./monacoBuiltins";

describe("Monaco's own language features step aside for a running language server", () => {
  afterEach(() => {
    applyBuiltinFeatures(new Set());
  });

  it("TypeScript/JavaScript are switched off for good, and applyBuiltinFeatures leaves them alone", () => {
    const ts = monaco.typescript.typescriptDefaults;
    const js = monaco.typescript.javascriptDefaults;
    disableTypeScriptBuiltins();
    for (const defaults of [ts, js]) {
      expect(defaults.modeConfiguration.completionItems).toBe(false);
      expect(defaults.modeConfiguration.hovers).toBe(false);
      expect(defaults.modeConfiguration.diagnostics).toBe(false);
    }
    applyBuiltinFeatures(new Set(["typescript"]));
    applyBuiltinFeatures(new Set());
    expect(ts.modeConfiguration.hovers).toBe(false);
  });

  it("JSON, CSS and HTML follow their own servers only", () => {
    applyBuiltinFeatures(new Set(["json"]));
    expect(monaco.json.jsonDefaults.modeConfiguration.completionItems).toBe(false);
    expect(monaco.css.cssDefaults.modeConfiguration.completionItems).toBe(true);
    expect(monaco.html.htmlDefaults.modeConfiguration.completionItems).toBe(true);
    applyBuiltinFeatures(new Set(["json", "css", "html"]));
    expect(monaco.css.scssDefaults.modeConfiguration.completionItems).toBe(false);
    expect(monaco.html.htmlDefaults.modeConfiguration.completionItems).toBe(false);
    applyBuiltinFeatures(new Set(["html"]));
    expect(monaco.json.jsonDefaults.modeConfiguration.completionItems).toBe(true);
    expect(monaco.css.lessDefaults.modeConfiguration.completionItems).toBe(true);
  });

  it("applying the same state twice doesn't lose the original settings", () => {
    applyBuiltinFeatures(new Set(["json"]));
    applyBuiltinFeatures(new Set(["json"]));
    applyBuiltinFeatures(new Set());
    expect(monaco.json.jsonDefaults.modeConfiguration.hovers).toBe(true);
  });
});
