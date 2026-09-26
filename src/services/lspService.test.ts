import * as monaco from "monaco-editor";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { BufferManager } from "./bufferManager";
import { CommandRegistry } from "./commandRegistry";
import { DiagnosticsService } from "./diagnosticsService";
import { DocumentService } from "./documentService";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type {
  IpcClient,
  LspCapabilities,
  LspDiagnosticsEvent,
  LspLogEvent,
  LspServerInfo,
  LspSnapshot,
  LspSyncOutcome,
} from "./ipc";
import { actionAvailability, fileProblem, restartAvailability } from "./lspAvailability";
import { registerLspCommands } from "./lspCommands";
import { LSP_DISABLED_REASON, LspService, SYNC_DELAY_MS } from "./lspService";
import { OutputService } from "./outputService";

const PY = "C:/My Site/app.py";
const TXT = "C:/My Site/notes.txt";

const ALL: LspCapabilities = {
  hover: true,
  completion: true,
  completionResolve: false,
  completionTriggers: [],
  signatureHelp: true,
  signatureTriggers: [],
  definition: true,
  declaration: false,
  typeDefinition: false,
  implementation: false,
  references: true,
  rename: true,
  prepareRename: false,
  formatting: false,
  rangeFormatting: false,
  documentSymbol: true,
};

function server(patch: Partial<LspServerInfo> = {}): LspServerInfo {
  return {
    id: "python",
    name: "Pyright",
    languages: ["python"],
    note: null,
    contents: "pyright 1.1.414",
    installed: true,
    state: "running",
    workspace: "C:/My Site",
    node: "OpenMind portable Node.js",
    capabilities: ALL,
    openDocuments: 1,
    pid: 4242,
    canInstall: true,
    installBlocked: null,
    logPath: "C:/app/logs/lsp/python.log",
    logExists: true,
    ...patch,
  };
}

function snapshot(servers: LspServerInfo[]): LspSnapshot {
  return {
    workspace: "C:/My Site",
    node: "OpenMind portable Node.js",
    nodeProblem: null,
    verbose: false,
    servers,
  };
}

interface Rig {
  ipc: IpcClient;
  events: EventBus<AppEvents>;
  documents: DocumentService;
  buffers: BufferManager;
  lsp: LspService;
  log: string[];
  status: { current: LspSnapshot };
  handlers: {
    log?: (event: LspLogEvent) => void;
    diagnostics?: (event: LspDiagnosticsEvent) => void;
    changed?: () => void;
  };
  outcome: { current: LspSyncOutcome };
  active: { current: string | null };
  enabled: { current: boolean };
}

async function rig(servers: LspServerInfo[] = [server()]): Promise<Rig> {
  const enabled = { current: true };
  const status = { current: snapshot(servers) };
  const handlers: Rig["handlers"] = {};
  const outcome = { current: { state: "ready", server: "python" } as LspSyncOutcome };
  const ipc = createFakeIpc({
    lspStatus: vi.fn().mockImplementation(() => Promise.resolve(status.current)),
    lspSyncDocument: vi.fn().mockImplementation(() => Promise.resolve(outcome.current)),
    documentOpen: vi
      .fn()
      .mockImplementation((path: string) =>
        Promise.resolve({ path, content: "x = 1\n", encoding: "utf8", lineEnding: "lf" }),
      ),
    documentRead: vi.fn().mockResolvedValue({ state: "missing" }),
    onLspLog: vi.fn().mockImplementation((handler: (event: LspLogEvent) => void) => {
      handlers.log = handler;
      return Promise.resolve(() => undefined);
    }),
    onLspDiagnostics: vi
      .fn()
      .mockImplementation((handler: (event: LspDiagnosticsEvent) => void) => {
        handlers.diagnostics = handler;
        return Promise.resolve(() => undefined);
      }),
    onLspChanged: vi.fn().mockImplementation((handler: () => void) => {
      handlers.changed = handler;
      return Promise.resolve(() => undefined);
    }),
  });
  const events = new EventBus<AppEvents>();
  const buffers = new BufferManager();
  const documents = new DocumentService(ipc, buffers, events);
  const log: string[] = [];
  const active = { current: null as string | null };
  const lsp = new LspService(ipc, events, documents, {
    log: (line) => log.push(line),
    activeDocId: () => active.current,
    enabled: () => enabled.current,
  });
  await lsp.initialize();
  return { ipc, events, documents, buffers, lsp, log, status, handlers, outcome, active, enabled };
}

describe("LspService: the lsp.enabled setting", () => {
  it("with language servers off no file is told to a server and every action says why not", async () => {
    const r = await rig();
    r.enabled.current = false;

    const id = await r.documents.openFromPath(PY);

    expect(r.ipc.lspSyncDocument).not.toHaveBeenCalled();
    expect(r.lsp.available("definition", id)).toEqual({
      enabled: false,
      reason: LSP_DISABLED_REASON,
    });
    r.lsp.dispose();
  });

  it("turning them off stops the running servers and forgets the open files", async () => {
    const r = await rig();
    const id = await r.documents.openFromPath(PY);
    await vi.waitFor(() => {
      expect(r.ipc.lspSyncDocument).toHaveBeenCalledTimes(1);
    });
    r.enabled.current = false;

    await r.lsp.applyEnabled();

    expect(r.ipc.lspStopAll).toHaveBeenCalledTimes(1);
    expect(r.ipc.lspCloseDocument).toHaveBeenCalledWith(PY);
    expect(r.lsp.available("definition", id).enabled).toBe(false);
    r.lsp.dispose();
  });

  it("turning them back on tells the servers about the files that are open", async () => {
    const r = await rig();
    r.enabled.current = false;
    await r.documents.openFromPath(PY);
    expect(r.ipc.lspSyncDocument).not.toHaveBeenCalled();

    r.enabled.current = true;
    await r.lsp.applyEnabled();

    await vi.waitFor(() => {
      expect(r.ipc.lspSyncDocument).toHaveBeenCalledWith(PY, "x = 1\n");
    });
    r.lsp.dispose();
  });
});

describe("LspService: keeping servers told about documents", () => {
  let r: Rig;
  beforeEach(async () => {
    r = await rig();
  });
  afterEach(() => {
    r.lsp.dispose();
    vi.useRealTimers();
  });

  it("opening a supported file gives the server its text; other files are left alone", async () => {
    await r.documents.openFromPath(PY);
    await r.documents.openFromPath(TXT);
    expect(r.ipc.lspSyncDocument).toHaveBeenCalledTimes(1);
    expect(r.ipc.lspSyncDocument).toHaveBeenCalledWith(PY, "x = 1\n");
  });

  it("edits are sent after a short delay, one message for a burst; flush sends at once", async () => {
    const id = await r.documents.openFromPath(PY);
    await vi.waitFor(() => {
      expect(r.ipc.lspSyncDocument).toHaveBeenCalledTimes(1);
    });
    vi.useFakeTimers();
    r.buffers.setValue(id, "x = 2\n");
    r.buffers.setValue(id, "x = 3\n");
    expect(r.ipc.lspSyncDocument).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SYNC_DELAY_MS + 10);
    expect(r.ipc.lspSyncDocument).toHaveBeenCalledTimes(2);
    expect(r.ipc.lspSyncDocument).toHaveBeenLastCalledWith(PY, "x = 3\n");

    r.buffers.setValue(id, "x = 4\n");
    await r.lsp.flush(id);
    expect(r.ipc.lspSyncDocument).toHaveBeenLastCalledWith(PY, "x = 4\n");
  });

  it("saving tells the server; closing the document closes it there", async () => {
    const id = await r.documents.openFromPath(PY);
    r.buffers.setValue(id, "x = 2\n");
    await r.documents.save(id);
    expect(r.ipc.lspSaveDocument).toHaveBeenCalledWith(PY);
    r.documents.close(id);
    expect(r.ipc.lspCloseDocument).toHaveBeenCalledWith(PY);
  });

  it("a file deleted on disk is closed in the server, and reopened when it is back", async () => {
    const id = await r.documents.openFromPath(PY);
    await vi.waitFor(() => {
      expect(r.ipc.lspSyncDocument).toHaveBeenCalledTimes(1);
    });
    await r.documents.checkDisk(id); // documentRead says "missing"
    expect(r.documents.externalState(id)).toBe("deleted");
    expect(r.ipc.lspCloseDocument).toHaveBeenCalledWith(PY);

    vi.mocked(r.ipc.documentRead).mockResolvedValue({
      state: "file",
      content: "x = 1\n",
      encoding: "utf8",
      lineEnding: "lf",
    });
    await r.documents.checkDisk(id);
    await vi.waitFor(() => {
      expect(r.ipc.lspSyncDocument).toHaveBeenCalledTimes(2);
    });
  });

  it("a file replaced on disk while clean reaches the server with the new text", async () => {
    const id = await r.documents.openFromPath(PY);
    await vi.waitFor(() => {
      expect(r.ipc.lspSyncDocument).toHaveBeenCalledTimes(1);
    });
    vi.mocked(r.ipc.documentRead).mockResolvedValue({
      state: "file",
      content: "y = 9\n",
      encoding: "utf8",
      lineEnding: "lf",
    });
    expect(await r.documents.checkDisk(id)).toBe("reloaded");
    await r.lsp.flush(id);
    await vi.waitFor(() => {
      expect(r.ipc.lspSyncDocument).toHaveBeenLastCalledWith(PY, "y = 9\n");
    });
  });

  it("a dirty file that changed on disk keeps sending the editor's text, never the disk's", async () => {
    const id = await r.documents.openFromPath(PY);
    r.buffers.setValue(id, "mine = 1\n");
    vi.mocked(r.ipc.documentRead).mockResolvedValue({
      state: "file",
      content: "theirs = 1\n",
      encoding: "utf8",
      lineEnding: "lf",
    });
    expect(await r.documents.checkDisk(id)).toBe("conflict");
    await r.lsp.flush(id);
    await vi.waitFor(() => {
      expect(r.ipc.lspSyncDocument).toHaveBeenLastCalledWith(PY, "mine = 1\n");
    });
  });

  it("a workspace change stops the servers and tells them about the open files again", async () => {
    await r.documents.openFromPath(PY);
    await vi.waitFor(() => {
      expect(r.ipc.lspSyncDocument).toHaveBeenCalledTimes(1);
    });
    r.events.emit("workspaceFolderChanged", { workspace: null });
    await vi.waitFor(() => {
      expect(r.ipc.lspStopAll).toHaveBeenCalled();
      expect(r.ipc.lspSyncDocument).toHaveBeenCalledTimes(2);
    });
  });
});

describe("LspService: actions and status", () => {
  it("Restart stops the server and reopens the open files of its languages only", async () => {
    const r = await rig();
    await r.documents.openFromPath(PY);
    await r.documents.openFromPath(TXT);
    await vi.waitFor(() => {
      expect(r.ipc.lspSyncDocument).toHaveBeenCalledTimes(1);
    });
    await r.lsp.restart("python");
    expect(r.ipc.lspStop).toHaveBeenCalledWith("python");
    expect(r.ipc.lspSyncDocument).toHaveBeenCalledTimes(2);
    expect(r.log).toContain("Restarting Pyright…");
    r.lsp.dispose();
  });

  it("Install runs only when the backend says it can, then reopens the files", async () => {
    const r = await rig([server({ installed: false, state: "stopped", capabilities: null })]);
    await r.documents.openFromPath(PY);
    expect(await r.lsp.install("python")).toBe(true);
    expect(r.ipc.lspInstall).toHaveBeenCalledWith("python");

    const blocked = await rig([
      server({
        installed: false,
        state: "stopped",
        canInstall: false,
        installBlocked: "Node.js runtime is not installed yet.",
      }),
    ]);
    expect(await blocked.lsp.install("python")).toBe(false);
    expect(blocked.ipc.lspInstall).not.toHaveBeenCalled();
    r.lsp.dispose();
    blocked.lsp.dispose();
  });

  it("a failed install is reported and leaves the state readable", async () => {
    const r = await rig([server({ installed: false, state: "stopped" })]);
    vi.mocked(r.ipc.lspInstall).mockRejectedValue("npm exited with code 1.");
    const errors: string[] = [];
    r.events.on("appError", ({ message }) => errors.push(message));
    expect(await r.lsp.install("python")).toBe(false);
    expect(errors[0]).toContain("Installing Pyright failed");
    r.lsp.dispose();
  });

  it("server log lines go to the LSP output, with the level when it isn't plain info", async () => {
    const r = await rig();
    r.handlers.log?.({ server: "python", level: "info", text: "Pyright started" });
    r.handlers.log?.({ server: "python", level: "error", text: "boom" });
    expect(r.log).toEqual(["[python] Pyright started", "[python] error: boom"]);
    r.lsp.dispose();
  });

  it("a server that stops is announced so its diagnostics can be removed", async () => {
    const r = await rig();
    const stopped: string[] = [];
    r.events.on("lspServerStopped", ({ server: id }) => stopped.push(id));
    r.status.current = snapshot([
      server({ state: "error", message: "The language server stopped unexpectedly." }),
    ]);
    await r.lsp.refresh();
    expect(stopped).toEqual(["python"]);
    r.lsp.dispose();
  });

  it("the failed-start toast is shown once per server", async () => {
    const r = await rig();
    r.outcome.current = { state: "failed", server: "python", message: "initialize failed" };
    const errors: string[] = [];
    r.events.on("appError", ({ message }) => errors.push(message));
    const id = await r.documents.openFromPath(PY);
    await vi.waitFor(() => {
      expect(errors).toHaveLength(1);
    });
    await r.lsp.syncNow(id);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Pyright couldn't start: initialize failed");
    r.lsp.dispose();
  });
});

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

describe("DiagnosticsService: markers from the server", () => {
  async function diagnosticsRig() {
    const events = new EventBus<AppEvents>();
    const buffers = new BufferManager();
    const ipc = createFakeIpc({
      documentOpen: vi
        .fn()
        .mockImplementation((path: string) =>
          Promise.resolve({ path, content: "a\nb\n", encoding: "utf8", lineEnding: "lf" }),
        ),
    });
    const documents = new DocumentService(ipc, buffers, events);
    const diagnostics = new DiagnosticsService(events, documents);
    diagnostics.initialize();
    const id = await documents.openFromPath(PY);
    const model = buffers.get(id);
    if (!model) throw new Error("no model");
    const markers = () => monaco.editor.getModelMarkers({ resource: model.uri });
    return { events, documents, diagnostics, id, markers };
  }

  const event = (diagnostics: LspDiagnosticsEvent["diagnostics"]): LspDiagnosticsEvent => ({
    server: "python",
    path: "c:/my site/APP.py", // another slash/drive style: the same file
    version: 1,
    diagnostics,
  });

  it("diagnostics become markers with the right place, severity and source", async () => {
    const { events, markers } = await diagnosticsRig();
    events.emit(
      "lspDiagnostics",
      event([
        {
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
          severity: 1,
          message: "bad",
          source: "Pyright",
        },
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          severity: 4,
          message: "hint",
        },
      ]),
    );
    const found = markers();
    expect(found).toHaveLength(2);
    expect(found.find((m) => m.message === "bad")).toMatchObject({
      severity: monaco.MarkerSeverity.Error,
      startLineNumber: 2,
      source: "Pyright",
      owner: "lsp:python",
    });
  });

  it("an empty list clears the file, and a stopped server removes everything it reported", async () => {
    const { events, markers } = await diagnosticsRig();
    const one = {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      message: "x",
    };
    events.emit("lspDiagnostics", event([one]));
    expect(markers()).toHaveLength(1);
    events.emit("lspDiagnostics", event([]));
    expect(markers()).toHaveLength(0);

    events.emit("lspDiagnostics", event([one]));
    events.emit("lspServerStopped", { server: "python" });
    expect(markers()).toHaveLength(0);
  });

  it("diagnostics for a file that isn't open are ignored, and closing the file drops its markers", async () => {
    const { events, documents, id, markers } = await diagnosticsRig();
    events.emit("lspDiagnostics", {
      server: "python",
      path: "C:/elsewhere/other.py",
      version: null,
      diagnostics: [],
    });
    events.emit(
      "lspDiagnostics",
      event([
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          message: "x",
        },
      ]),
    );
    expect(markers()).toHaveLength(1);
    documents.close(id);
    expect(markers()).toHaveLength(0);
  });
});
