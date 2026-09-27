import { describe, expect, it } from "vitest";

import { testExtension } from "../testUtils/fakeExtensionsIpc";
import {
  MARKETPLACE_UNAVAILABLE,
  NODE_REQUIRED,
  TRUST_WARNING,
  commandBlockedReason,
  describeActivation,
  filterExtensions,
  pointLines,
  runtimeStatus,
} from "./extensionModel";
import { parseSnippets } from "./extensionSnippets";
import { normalizeColor, parseExtensionTheme } from "./extensionTheme";
import { markerSeverity, monacoCompletionKind, toMarkers } from "./extensionProviderConvert";
import { parseJsonc } from "./jsonc";

const STOPPED = { state: "stopped", pid: null, node: null, error: null } as const;
const RUNNING = { state: "running", pid: 5, node: "OpenMind portable Node.js", error: null } as const;

describe("parseJsonc", () => {
  it("accepts comments, trailing commas and a BOM but keeps them inside strings", () => {
    const text = '\uFEFF{\n // line\n "a": "x // not a comment", /* block */ "b": [1, 2,],\n}';
    expect(parseJsonc(text)).toEqual({ a: "x // not a comment", b: [1, 2] });
  });

  it("still rejects text that is not JSON", () => {
    expect(() => parseJsonc("{ nope }")).toThrow();
  });
});

describe("snippets", () => {
  it("reads prefixes, joins body lines and skips broken entries", () => {
    const snippets = parseSnippets(`{
      // a comment
      "Block": { "prefix": ["blk", "block"], "body": ["a", "\\t$0"], "description": "A block" },
      "Broken": { "prefix": "x" },
      "Text": 5
    }`);
    expect(snippets).toEqual([
      { name: "Block", prefixes: ["blk", "block"], body: "a\n\t$0", description: "A block" },
    ]);
  });

  it("refuses a file that is not an object", () => {
    expect(() => parseSnippets("[1]")).toThrow("JSON object");
  });
});

describe("colour themes", () => {
  it("normalizes short, long and alpha hex colours and refuses everything else", () => {
    expect(normalizeColor("#ABC")).toBe("#aabbcc");
    expect(normalizeColor("#112233")).toBe("#112233");
    expect(normalizeColor("#11223344")).toBe("#11223344");
    expect(normalizeColor("red")).toBeNull();
    expect(normalizeColor(5)).toBeNull();
  });

  it("maps editor colours to Monaco, workbench colours to tokens and TextMate scopes to Monaco tokens", () => {
    const theme = parseExtensionTheme(
      `{ // sample
        "colors": { "editor.background": "#1b2430", "sideBar.background": "#222", "bad": "nope" },
        "tokenColors": [
          { "scope": ["comment"], "settings": { "foreground": "#6c8aa6", "fontStyle": "italic" } },
          { "scope": "keyword.control, storage.type", "settings": { "foreground": "#ff9d5c" } },
          { "scope": "unknown.scope", "settings": { "foreground": "#ffffff" } }
        ] }`,
      "Night",
      "vs-dark",
    );
    expect(theme.kind).toBe("dark");
    expect(theme.monaco.base).toBe("vs-dark");
    expect(theme.monaco.colors).toEqual({ "editor.background": "#1b2430", "sideBar.background": "#222222" });
    expect(theme.tokens["--editor-bg"]).toBe("#1b2430");
    expect(theme.tokens["--sidebar-bg"]).toBe("#222222");
    expect(theme.monaco.rules).toContainEqual({ token: "comment", foreground: "6c8aa6", fontStyle: "italic" });
    expect(theme.monaco.rules.filter((rule) => rule.token === "keyword")).toHaveLength(2);
    expect(theme.monaco.rules.some((rule) => rule.foreground === "ffffff")).toBe(false);
  });

  it("chooses the palette from uiTheme", () => {
    expect(parseExtensionTheme("{}", "L", "vs").kind).toBe("light");
    expect(parseExtensionTheme("{}", "H", "hc-black").kind).toBe("high-contrast");
    expect(() => parseExtensionTheme("[]", "X", "vs")).toThrow("JSON object");
  });
});

describe("language feature conversions", () => {
  it("maps VS Code completion kinds and severities to Monaco's", () => {
    expect(monacoCompletionKind(2)).toBe(1); // Function
    expect(monacoCompletionKind(14)).toBe(28); // Snippet (Monaco inserted Tool at 27)
    expect(monacoCompletionKind(undefined)).toBe(18);
    expect(markerSeverity(0)).toBe(8);
    expect(markerSeverity(1)).toBe(4);
    expect(markerSeverity(3)).toBe(1);
  });

  it("turns 0-based host diagnostics into 1-based markers", () => {
    const [marker] = toMarkers([
      { range: { startLine: 0, startColumn: 2, endLine: 0, endColumn: 5 }, message: "bad", severity: 1 },
    ]);
    expect(marker).toMatchObject({ startLineNumber: 1, startColumn: 3, endLineNumber: 1, endColumn: 6, severity: 4 });
  });
});

describe("extension model", () => {
  const command = testExtension();
  const data = testExtension({ manifest: { ...testExtension().manifest, name: "data", main: null }, runtimeRequirement: null });

  it("searches installed extensions by every word", () => {
    const extensions = [command, data];
    expect(filterExtensions(extensions, "")).toHaveLength(2);
    expect(filterExtensions(extensions, "sample command")).toHaveLength(2);
    expect(filterExtensions(extensions, "openmind-samples.data")).toEqual([data]);
    expect(filterExtensions(extensions, "nothing here")).toEqual([]);
  });

  it("says what runtime an extension needs and whether it is there", () => {
    const node = { portable: false, system: null, allowSystem: false };
    expect(runtimeStatus(command, STOPPED, node)).toEqual({ text: NODE_REQUIRED, ready: false });
    expect(runtimeStatus(command, STOPPED, { ...node, portable: true }).ready).toBe(true);
    expect(runtimeStatus(command, STOPPED, { ...node, system: "C:/node/node.exe" }).ready).toBe(false);
    const allowed = runtimeStatus(command, STOPPED, { ...node, system: "C:/node/node.exe", allowSystem: true });
    expect(allowed).toEqual({ text: "Runs in the System Node.js at C:/node/node.exe.", ready: true });
    expect(runtimeStatus(command, RUNNING, node).ready).toBe(true);
    expect(runtimeStatus(data, STOPPED, node).ready).toBe(true);
  });

  it("explains why a command is blocked", () => {
    const node = { portable: false, system: null, allowSystem: false };
    expect(commandBlockedReason(command, STOPPED, node)).toBe(NODE_REQUIRED);
    expect(commandBlockedReason(command, STOPPED, { ...node, portable: true })).toBeUndefined();
    expect(commandBlockedReason({ ...command, enabled: false }, RUNNING, node)).toContain("disabled");
    expect(
      commandBlockedReason(command, { ...STOPPED, state: "crashed", error: "it died" }, { ...node, portable: true }),
    ).toBe("it died");
    expect(commandBlockedReason(data, STOPPED, node)).toBeUndefined();
  });

  it("describes activation events and the exact trust and marketplace texts", () => {
    expect(describeActivation("*")).toContain("slow");
    expect(describeActivation("onCommand:x.y")).toBe('When the command "x.y" runs');
    expect(describeActivation("onView:v")).toBe(`When the view "v" is shown`);
    expect(describeActivation("onDebug")).toContain("not supported yet");
    expect(TRUST_WARNING).toBe("Extensions can run code on your computer. Install only from trusted sources.");
    expect(MARKETPLACE_UNAVAILABLE).toBe("Online extension marketplace is not available yet.");
  });

  it("shows unsupported contribution points with the fixed note", () => {
    const extension = testExtension({
      points: [
        { point: "commands", count: 1, support: "supported", note: null },
        { point: "viewsContainers", count: 2, support: "unsupported", note: null },
        { point: "debuggers", count: 1, support: "metadata", note: "Registered as metadata only." },
      ],
    });
    const lines = pointLines(extension);
    expect(lines[1]).toMatchObject({ status: "Not supported", note: "This contribution point is not supported yet." });
    expect(lines[2]).toMatchObject({ status: "Metadata only", note: "Registered as metadata only." });
    expect(lines[0]?.status).toBe("Supported");
  });
});
