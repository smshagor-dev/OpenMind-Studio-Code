import * as monaco from "monaco-editor";
import { describe, expect, it, vi } from "vitest";

import { PY } from "../testUtils/lspFixtures";
import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { BufferManager } from "./bufferManager";
import { DiagnosticsService } from "./diagnosticsService";
import { DocumentService } from "./documentService";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { LspDiagnosticsEvent } from "./ipc";

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
