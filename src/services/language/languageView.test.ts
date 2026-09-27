import { describe, expect, it } from "vitest";

import type { LspServerInfo } from "../ipc";
import { commandStatus, formatOption, language, tool } from "../../testUtils/languageFixtures";
import type { LspCandidate } from "./languageIpc";
import { syntaxNote } from "./languageRegistry";
import { formatOptionLine, groupCommands, lspLine, toolLine } from "./languageView";

function server(overrides: Partial<LspServerInfo> = {}): LspServerInfo {
  return {
    id: "typescript",
    name: "TypeScript Language Server",
    languages: ["typescript"],
    note: null,
    contents: "typescript-language-server",
    installed: false,
    runtime: "node",
    bundled: false,
    installSource: null,
    state: "stopped",
    workspace: null,
    node: null,
    capabilities: null,
    openDocuments: 0,
    pid: null,
    canInstall: true,
    installBlocked: null,
    logPath: "",
    logExists: false,
    ...overrides,
  };
}

const builtin: LspCandidate = {
  tool: "typescript-language-server",
  name: "TypeScript Language Server",
  builtin: "typescript",
  found: null,
  note: "",
};
const external: LspCandidate = {
  tool: "gopls",
  name: "gopls",
  builtin: null,
  found: null,
  note: "Not found. Install it with `go install`. OpenMind can't start this language server yet.",
};

describe("toolLine and formatOptionLine", () => {
  it("say where a found tool came from, and what to do about a missing one", () => {
    expect(toolLine(tool("node", true))).toMatchObject({
      tone: "ok",
      detail: "Found in the system PATH: C:/tools/node.exe",
    });
    const missing = toolLine(tool("cargo", false, "Install Rust (rustup)."));
    expect(missing).toMatchObject({ tone: "off", detail: "Not found. Install Rust (rustup)." });
    expect(formatOptionLine(formatOption()).detail).toContain("the project's own copy");
    expect(formatOptionLine(formatOption()).detail).toContain("this file");
    expect(formatOptionLine(formatOption({ wholeProject: true })).detail).toContain(
      "whole project",
    );
    expect(formatOptionLine(formatOption({ found: null, hint: "Add it." })).tone).toBe("off");
  });
});

describe("lspLine", () => {
  it("shows the live state of OpenMind's own server, with the setup hint when it is not installed", () => {
    expect(lspLine(builtin, [server({ state: "running" })])).toMatchObject({
      tone: "ok",
      detail: "Running.",
    });
    expect(lspLine(builtin, [server({ installed: true })]).detail).toContain(
      "starts when a file it handles is opened",
    );
    const missing = lspLine(builtin, [server()]);
    expect(missing.tone).toBe("off");
    expect(missing.detail).toContain("LSP not configured");
    expect(missing.detail).toContain("Nothing is downloaded until you press Install");
    expect(lspLine(builtin, [server({ state: "installing" })]).detail).toBe("Installing…");
    expect(lspLine(builtin, [server({ state: "error", message: "crashed" })]).detail).toBe(
      "crashed",
    );
    expect(lspLine(builtin, []).detail).toContain("LSP not configured");
  });

  it("says a bundled server needs no download and is unpacked on first use", () => {
    const line = lspLine(builtin, [server({ bundled: true })]);
    expect(line.tone).toBe("ok");
    expect(line.detail).toContain("Bundled with OpenMind");
    expect(line.detail).toContain("offline");
    expect(lspLine(builtin, [server({ bundled: true, state: "installing" })]).detail).toBe(
      "Unpacking from the offline bundle…",
    );
  });

  it("never claims a server OpenMind can't start, found or not", () => {
    expect(lspLine(external, [])).toMatchObject({ tone: "off" });
    expect(lspLine(external, []).detail).toContain("can't start this language server yet");
    const found = lspLine(
      {
        ...external,
        found: { path: "C:/go/bin/gopls.exe", source: "system" },
        note: "Found on this computer, but OpenMind can't start this language server yet.",
      },
      [],
    );
    expect(found.tone).toBe("warn");
    expect(found.detail).toContain("can't start");
  });
});

describe("groupCommands and syntaxNote", () => {
  it("groups commands by what they do in a fixed order and drops empty groups", () => {
    const groups = groupCommands([
      commandStatus({ id: "t", category: "test" }),
      commandStatus({ id: "d", category: "dev" }),
      commandStatus({ id: "b", category: "build" }),
      commandStatus({ id: "d2", category: "dev" }),
    ]);
    expect(groups.map(([category, list]) => [category, list.map((c) => c.id)])).toEqual([
      ["dev", ["d", "d2"]],
      ["build", ["b"]],
      ["test", ["t"]],
    ]);
  });

  it("is honest about how well a language is coloured", () => {
    expect(syntaxNote(language("go"))).toBe("Syntax highlighting: full.");
    expect(syntaxNote(language("vue"))).toBe("Syntax highlighting: approximate (colored as html).");
    expect(syntaxNote(language("dart"))).toContain("none");
  });
});
