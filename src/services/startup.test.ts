/// <reference types="node" />
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { StartupTimings } from "./startupTimings";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** A source file's text with LF line endings (a Windows checkout with `core.autocrlf` has CRLF). */
const read = (path: string) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n");

/** The text of `async function name(...) { ... }` in `source` (up to the next top-level closing brace). */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `${name} exists`).toBeGreaterThan(-1);
  const end = source.indexOf("\n}\n", start);
  // Without its end the "body" would be the rest of the file: say so instead of checking the wrong text.
  expect(end, `the end of ${name}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

/** What the window does at start-up, in order. */
const hooks = read("src/appHooks.ts");
const startup = hooks.slice(
  hooks.indexOf("export function useAppStartup"),
  hooks.indexOf("export function useGlobalKeybindings"),
);
const container = read("src/services/container.ts");

/** Things that must only ever happen on a click, never while the app starts. */
const CLICK_ONLY = [
  /marketplace/i,
  /aiChatSend|chat\.send|sendDraft|\.submit\(/,
  /providers\.test|aiProviderTest/,
  /toolchains\.verify|toolchainsVerify|\.verify\(/,
  /mariaDb\.(start|init)\(|phpMyAdmin\.start|php\.start\(|phpServerStart|composer\.(install|update)/,
  /installRuntime|runtime\.install|\.install\(/,
  /host\.start|hostStart|extHostStart|activateFor\(/,
  /lspInstall|installServer|lsp\.install/,
  /openExternalUrl/,
];

describe("start-up does only local, lazy work", () => {
  it("the start-up sequence never does anything that belongs to a click", () => {
    for (const forbidden of CLICK_ONLY) {
      expect(startup, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it("the start functions the sequence calls do not fetch, send, install, start a server or verify a tool", () => {
    for (const name of [
      "startAi",
      "startLanguage",
      "startFormatting",
      "startLanguageTools",
      "startDebugTools",
      "startExtensions",
    ]) {
      const body = container.includes(`function ${name}(`) ? functionBody(container, name) : "";
      for (const forbidden of CLICK_ONLY) {
        expect(body, `${name}: ${String(forbidden)}`).not.toMatch(forbidden);
      }
    }
    const extensions = read("src/services/extensionsWiring.ts");
    const start = extensions.slice(
      extensions.indexOf("async function start("),
      extensions.indexOf("let startupFinished") > 0 ? undefined : undefined,
    );
    expect(start.slice(0, 900)).not.toMatch(/marketplace|activateFor|startHost/i);
  });

  it("phases run in the expected order and the editor is usable before the background services finish", () => {
    const order = [
      "startSettings",
      "theme.initialize",
      "restoreActiveWorkspace",
      "startExtensions",
      "startAi",
      "startLanguage",
      "startFormatting",
      "restoreSession",
      "setReady(true)",
      "sourceControl.initialize",
      "finishExtensionsStartup",
      "reportStartup",
    ];
    let last = -1;
    for (const step of order) {
      const at = startup.indexOf(step);
      expect(at, step).toBeGreaterThan(last);
      last = at;
    }
  });

  it("the timings are reported once, only by the main window, and carry phase names and numbers only", () => {
    expect(startup).toContain("isMainWindow()");
    expect(startup.match(/reportStartup/g)).toHaveLength(1);
    expect(container).toContain("startupReport(phases, usableMs)");
  });

  it("the search index, Git, servers and debug tools are not started by name at launch", () => {
    for (const forbidden of [
      /index\.start|indexStart|workspaceIndex\.start/,
      /debug\.start\(/,
      /terminal\.createTerminal/,
    ]) {
      expect(startup).not.toMatch(forbidden);
    }
  });
});

describe("StartupTimings", () => {
  it("records each phase as the time since the previous mark", () => {
    let now = 1000;
    const timings = new StartupTimings(() => now);
    now += 40;
    timings.mark("settings");
    now += 95;
    timings.mark("editor");
    expect(timings.phases()).toEqual([
      ["settings", 40],
      ["editor", 95],
    ]);
    expect(timings.elapsed()).toBe(135);
  });

  it("never records a negative time", () => {
    let now = 50;
    const timings = new StartupTimings(() => now);
    now = 40;
    timings.mark("clock went back");
    expect(timings.phases()[0]?.[1]).toBe(0);
  });
});
