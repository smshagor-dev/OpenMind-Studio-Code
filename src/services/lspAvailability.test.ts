import { describe, expect, it, vi } from "vitest";

import { PY, TXT, rig, server } from "../testUtils/lspFixtures";
import { CommandRegistry } from "./commandRegistry";
import type { LspServerInfo, LspSyncOutcome } from "./ipc";
import { actionAvailability, fileProblem, restartAvailability } from "./lspAvailability";
import { registerLspCommands } from "./lspCommands";
import { OutputService } from "./outputService";

describe("availability: every disabled action says why", () => {
  const file = (patch: Partial<Parameters<typeof fileProblem>[0]> = {}) => ({
    path: PY,
    server: server(),
    outcome: { state: "ready", server: "python" } as LspSyncOutcome,
    ...patch,
  });

  it("a running server with the capability enables the action", () => {
    expect(actionAvailability("definition", file())).toEqual({ enabled: true });
    expect(actionAvailability("hover", file())).toEqual({ enabled: true });
  });

  it("a server without the capability says so by name", () => {
    expect(actionAvailability("formatting", file())).toEqual({
      enabled: false,
      reason: "Pyright doesn't support Format Document.",
    });
    expect(actionAvailability("declaration", file()).reason).toContain("Go to Declaration");
  });

  it("missing server, missing Node, outside the folder, no folder, unsaved and unsupported files", () => {
    expect(
      fileProblem(file({ server: server({ installed: false, state: "stopped" }), outcome: null })),
    ).toBe("Language server is not installed yet.");
    expect(fileProblem(file({ outcome: { state: "notInstalled", server: "python" } }))).toBe(
      "Language server is not installed yet.",
    );
    expect(fileProblem(file({ outcome: { state: "nodeMissing" } }))).toBe(
      "Node.js runtime is not installed yet.",
    );
    expect(fileProblem(file({ outcome: { state: "outsideWorkspace" } }))).toBe(
      "This file is outside the open folder.",
    );
    expect(fileProblem(file({ outcome: { state: "noWorkspace" } }))).toBe(
      "Open a folder to use language servers.",
    );
    expect(fileProblem(file({ outcome: { state: "otherWindowFolder" } }))).toContain(
      "main window's folder",
    );
    expect(fileProblem(file({ path: null }))).toBe("Save the file to use language features.");
    expect(fileProblem(file({ path: TXT, server: null }))).toBe(
      "No language server supports this file type.",
    );
    expect(
      fileProblem(file({ outcome: { state: "failed", server: "python", message: "It crashed." } })),
    ).toBe("It crashed.");
  });

  it("a stopped, installing or crashed server has its own reason", () => {
    expect(fileProblem(file({ server: server({ state: "stopped" }), outcome: null }))).toBe(
      "The language server isn't running.",
    );
    expect(fileProblem(file({ server: server({ state: "installing" }), outcome: null }))).toBe(
      "The language server is being installed.",
    );
    expect(
      fileProblem(file({ server: server({ state: "error", message: "It died." }), outcome: null })),
    ).toBe("It died.");
  });

  it("a bundled server that isn't unpacked yet is not 'missing': it starts on the next sync", () => {
    const bundled = server({ installed: false, bundled: true, state: "stopped" });
    expect(fileProblem(file({ server: bundled, outcome: null }))).toBe(
      "The language server isn't running.",
    );
    expect(
      fileProblem(file({ server: server({ bundled: true, state: "installing" }), outcome: null })),
    ).toBe("The language server is being unpacked from the offline bundle.");
    expect(restartAvailability(file({ server: bundled }))).toEqual({ enabled: true });
  });

  it("restart needs an installed server for the file", () => {
    expect(restartAvailability(file())).toEqual({ enabled: true });
    expect(restartAvailability(file({ server: server({ installed: false }) })).reason).toBe(
      "Language server is not installed yet.",
    );
    expect(restartAvailability(file({ path: TXT, server: null })).enabled).toBe(false);
  });
});

describe("editor commands are gated by the server", () => {
  async function commandRig(servers: LspServerInfo[]) {
    const r = await rig(servers);
    const id = await r.documents.openFromPath(PY);
    r.active.current = id;
    const commands = new CommandRegistry();
    const run = vi.fn();
    const editor = { hasEditor: () => true, run } as unknown as Parameters<
      typeof registerLspCommands
    >[0]["editor"];
    const output = new OutputService();
    const show = vi.fn().mockResolvedValue(undefined);
    const panel = { show } as unknown as Parameters<typeof registerLspCommands>[0]["panel"];
    registerLspCommands({ commands, editor, lsp: r.lsp, events: r.events, output, panel });
    await vi.waitFor(() => {
      expect(r.ipc.lspSyncDocument).toHaveBeenCalled();
    });
    return { r, commands, run, output, show };
  }

  it("Go to Definition and Rename run Monaco's action when the server supports them (Find References is covered in searchWiring.test)", async () => {
    const { commands, run } = await commandRig([server()]);
    for (const [command, action] of [
      ["go.toDefinition", "editor.action.revealDefinition"],
      ["edit.renameSymbol", "editor.action.rename"],
    ] as const) {
      expect(commands.isEnabled(command)).toBe(true);
      await commands.execute(command);
      expect(run).toHaveBeenLastCalledWith(action);
    }
  });

  it("Format Document is not a language-server command: the formatting service owns it (formatting tests)", async () => {
    const { commands } = await commandRig([server()]);
    expect(commands.isEnabled("edit.formatDocument")).toBe(false);
    expect(commands.reasonFor("go.toDefinition")).toBeUndefined();
  });

  it("with the server missing every action is disabled with the same plain reason", async () => {
    const { commands } = await commandRig([
      server({ installed: false, state: "stopped", capabilities: null }),
    ]);
    r_expectMissing(commands);
  });

  it("Restart Language Server restarts the active file's server; Language Tools and Show Output open their views", async () => {
    const { r, commands, output, show } = await commandRig([server()]);
    expect(commands.isEnabled("lsp.restart")).toBe(true);
    await commands.execute("lsp.restart");
    expect(r.ipc.lspStop).toHaveBeenCalledWith("python");

    const shown: number[] = [];
    r.events.on("showLanguageTools", () => shown.push(1));
    await commands.execute("lsp.manage");
    expect(shown).toHaveLength(1);

    await commands.execute("lsp.openOutput");
    expect(output.getState().selected).toBe("LSP");
    expect(show).toHaveBeenCalledWith("output");
  });

  function r_expectMissing(commands: CommandRegistry) {
    for (const command of ["go.toDefinition", "edit.renameSymbol"]) {
      expect(commands.isEnabled(command)).toBe(false);
      expect(commands.reasonFor(command)).toBe("Language server is not installed yet.");
    }
    expect(commands.isEnabled("lsp.restart")).toBe(false);
    expect(commands.reasonFor("lsp.restart")).toBe("Language server is not installed yet.");
  }
});
