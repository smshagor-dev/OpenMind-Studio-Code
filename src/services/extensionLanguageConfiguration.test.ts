import { createRequire } from "node:module";
import * as monaco from "monaco-editor";
import { expect, it } from "vitest";
import { parseLanguageConfiguration, registerLanguageConfiguration } from "./extensionLanguageConfiguration";
import { rig } from "../testUtils/extensionRig";
const require = createRequire(import.meta.url);
interface Host { request(method: string, params?: unknown): Promise<unknown>; onNotification(listener: (m: { method: string; params: Record<string, unknown> }) => void): () => void }
const { fixture } = require("../../crates/extensions/tests/node/rpc-fixture.cjs") as { fixture: (t: { after(callback: () => Promise<void>): void }, definitions: Record<string, { code: string; permissions: string[] }>) => Promise<Host> };
const pattern = (source: string, flags = "") => ({ source, flags });
it("decodes all public configuration fields and regex flags", () => {
  const config = parseLanguageConfiguration({ comments: { lineComment: "//", blockComment: ["/*", "*/"] }, brackets: [["{", "}"]], wordPattern: pattern("[a-z-]+", "giu"),
    indentationRules: { increaseIndentPattern: pattern("{"), decreaseIndentPattern: pattern("}"), indentNextLinePattern: pattern("next", "i"), unIndentedLinePattern: pattern("skip") },
    onEnterRules: [{ beforeText: pattern("before"), afterText: pattern("after"), previousLineText: pattern("previous"), action: { indentAction: 1, appendText: "* ", removeText: 1 } }], autoClosingPairs: [{ open: "{", close: "}", notIn: ["string"] }], __electricCharacterSupport: { docComment: { open: "/**", close: "*/" } } });
  expect(config.wordPattern?.flags).toBe("giu"); expect(config.wordPattern?.test("abc-def")).toBe(true);
  expect(config.indentationRules?.indentNextLinePattern?.test("NEXT")).toBe(true);
  expect(config.onEnterRules?.[0]?.previousLineText?.test("previous")).toBe(true);
  expect(config.comments?.blockComment).toEqual(["/*", "*/"]); expect(config.autoClosingPairs?.[0]?.notIn).toEqual(["string"]);
});
it("rejects malformed payloads before registering Monaco configuration", () => {
  for (const value of [null, { wordPattern: pattern("[") }, { wordPattern: { source: "x", flags: "ii" } }, { brackets: [["("]] }, { comments: { lineComment: 1 } }, { indentationRules: {} }, { onEnterRules: [{ beforeText: pattern("x"), action: { indentAction: 9 } }] }, { onEnterRules: [{ beforeText: pattern("x"), action: { indentAction: 0, removeText: -1 } }] }, { autoClosingPairs: [{ open: 1, close: "x" }] }, { unknown: true }]) expect(() => parseLanguageConfiguration(value)).toThrow();
});
it("applies real host registrations to Monaco and restores stacked configurations on disposal and reset", async () => {
  const cleanups: (() => Promise<void>)[] = [];
  const language = "openmind-config-test"; monaco.languages.register({ id: language });
  const model = monaco.editor.createModel("abc-def", language);
  const r = rig(); r.bridge.connect({ registerLanguageConfiguration });
  try {
    const host = await fixture({ after: callback => { cleanups.push(callback); } }, { "test.config": { permissions: ["commands", "languages"], code: `const v=require('vscode');let first,second;exports.activate=()=>{v.commands.registerCommand('first',()=>{first=v.languages.setLanguageConfiguration('${language}',{wordPattern:/[a-z-]+/});});v.commands.registerCommand('second',()=>{second=v.languages.setLanguageConfiguration('${language}',{wordPattern:/[a-z]+/});});v.commands.registerCommand('dispose',()=>second.dispose());};` } });
    const off = host.onNotification(m => { if (m.method === "languages/configuration" || m.method === "languages/unregistered") r.bridge.handleNotification(m.method, m.params); });
    cleanups.push(() => { off(); return Promise.resolve(); });
    await host.request("host/activate", { id: "test.config" });
    await host.request("host/executeCommand", { command: "first" }); expect(model.getWordAtPosition({ lineNumber: 1, column: 2 })?.word).toBe("abc-def");
    await host.request("host/executeCommand", { command: "second" }); expect(model.getWordAtPosition({ lineNumber: 1, column: 2 })?.word).toBe("abc");
    await host.request("host/executeCommand", { command: "dispose" }); expect(model.getWordAtPosition({ lineNumber: 1, column: 2 })?.word).toBe("abc-def");
    // A rejected replacement cannot remove an already functioning binding.
    r.bridge.handleNotification("languages/configuration", { extension: "test.config", handle: "test.config:configuration:1", language, configuration: { wordPattern: pattern("[") } });
    expect(model.getWordAtPosition({ lineNumber: 1, column: 2 })?.word).toBe("abc-def");
    r.bridge.reset(); expect(model.getWordAtPosition({ lineNumber: 1, column: 2 })?.word).toBe("abc");
  } finally { r.bridge.reset(); model.dispose(); for (const close of cleanups.reverse()) await close(); }
});
it("uses configured comments, auto-closing brackets and Enter rules in a real Monaco editor", async () => {
  const language = "openmind-config-editing"; monaco.languages.register({ id: language });
  const model = monaco.editor.createModel("value", language);
  const element = document.createElement("div"); element.style.width = "800px"; element.style.height = "600px"; document.body.append(element);
  const editor = monaco.editor.create(element, { model, automaticLayout: false, autoClosingBrackets: "always", autoIndent: "full", tabSize: 2, insertSpaces: true });
  const dispose = registerLanguageConfiguration(language, { comments: { lineComment: "//" }, brackets: [["{", "}"]], autoClosingPairs: [{ open: "{", close: "}" }],
    indentationRules: { increaseIndentPattern: pattern("[{]$"), decreaseIndentPattern: pattern("^[}]") },
    onEnterRules: [{ beforeText: pattern("start$"), action: { indentAction: 1, appendText: "// " } }] });
  try {
    const comment = editor.getAction("editor.action.commentLine"); expect(comment).not.toBeNull(); await comment?.run();
    expect(model.getValue()).toBe("// value");
    model.setValue(""); editor.setPosition({ lineNumber: 1, column: 1 }); editor.trigger("keyboard", "type", { text: "{" });
    expect(model.getValue()).toBe("{}");
    model.setValue("start"); editor.setPosition({ lineNumber: 1, column: 6 }); editor.trigger("keyboard", "type", { text: "\n" });
    expect(model.getValue()).toBe("start\n  // ");
  } finally { dispose(); editor.dispose(); model.dispose(); element.remove(); }
});
