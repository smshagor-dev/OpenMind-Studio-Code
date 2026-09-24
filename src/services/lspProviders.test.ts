import * as monaco from "monaco-editor";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { BufferManager } from "./bufferManager";
import { DocumentService } from "./documentService";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { IpcClient, LspCapabilities } from "./ipc";
import {
  PeekModels,
  createCompletionProvider,
  createFormattingProvider,
  createHoverProvider,
  createLocationProvider,
  createOpener,
  createReferenceProvider,
  createRenameProvider,
  createSymbolProvider,
  type ProviderDeps,
} from "./lspProviders";
import type { LspService } from "./lspService";

const PY = "C:/My Site/app.py";
const OTHER = "C:/My Site/lib/helpers.py";
const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };

const CAPS: LspCapabilities = {
  hover: true,
  completion: true,
  completionResolve: false,
  completionTriggers: [],
  signatureHelp: true,
  signatureTriggers: [],
  definition: true,
  declaration: true,
  typeDefinition: true,
  implementation: true,
  references: true,
  rename: true,
  prepareRename: true,
  formatting: true,
  rangeFormatting: false,
  documentSymbol: true,
};

interface Rig {
  deps: ProviderDeps;
  ipc: IpcClient;
  model: monaco.editor.ITextModel;
  documents: DocumentService;
  request: ReturnType<typeof vi.fn>;
  enabled: { current: boolean };
  workspace: {
    openPath: ReturnType<typeof vi.fn>;
    openDocumentAt: ReturnType<typeof vi.fn>;
    openPathAt: ReturnType<typeof vi.fn>;
    setActive: ReturnType<typeof vi.fn>;
    getState: () => { activeId: string };
  };
}

async function rig(): Promise<Rig> {
  const enabled = { current: true };
  const request = vi.fn().mockResolvedValue(null);
  const ipc = createFakeIpc({
    lspRequest: request as unknown as IpcClient["lspRequest"],
    documentOpen: vi.fn().mockImplementation((path: string) =>
      Promise.resolve({
        path,
        content: "def foo():\n    return 1\n\nfoo()\n",
        encoding: "utf8",
        lineEnding: "lf",
      }),
    ),
    documentRead: vi.fn().mockImplementation((path: string) =>
      Promise.resolve({
        state: "file",
        content: `# ${path}\n`,
        encoding: "utf8",
        lineEnding: "lf",
      }),
    ),
  });
  const events = new EventBus<AppEvents>();
  const buffers = new BufferManager();
  const documents = new DocumentService(ipc, buffers, events);
  const id = await documents.openFromPath(PY);
  const model = buffers.get(id);
  if (!model) throw new Error("no model");
  const lsp = {
    available: () => (enabled.current ? { enabled: true } : { enabled: false, reason: "no" }),
    flush: () => Promise.resolve(),
    serverForPath: () => ({ name: "Pyright", capabilities: CAPS }),
  } as unknown as LspService;
  const workspace = {
    openPath: vi.fn().mockImplementation(async (path: string) => {
      await documents.openFromPath(path);
      return "tab";
    }),
    openDocumentAt: vi.fn(),
    openPathAt: vi.fn().mockResolvedValue("tab"),
    setActive: vi.fn(),
    getState: () => ({ activeId: id }),
  };
  const deps = { ipc, documents, workspace, lsp } as unknown as ProviderDeps;
  return { deps, ipc, model, documents, request, enabled, workspace };
}

const at = (line: number, column: number) => new monaco.Position(line, column);

describe("Monaco providers ask the language server", () => {
  let r: Rig;
  beforeEach(async () => {
    r = await rig();
  });

  it("hover sends a 0-based position and shows what the server answers", async () => {
    r.request.mockResolvedValue({ contents: { kind: "markdown", value: "**foo**" } });
    const hover = await createHoverProvider(r.deps).provideHover(r.model, at(1, 5), token);
    expect(r.request).toHaveBeenCalledWith(PY, "textDocument/hover", {
      textDocument: { uri: "file:///C:/My%20Site/app.py" },
      position: { line: 0, character: 4 },
    });
    expect(hover?.contents).toEqual([{ value: "**foo**" }]);
  });

  it("nothing is asked when the server can't take the request", async () => {
    r.enabled.current = false;
    expect(await createHoverProvider(r.deps).provideHover(r.model, at(1, 5), token)).toBeNull();
    const completions = await createCompletionProvider(r.deps).provideCompletionItems(
      r.model,
      at(1, 5),
      { triggerKind: 0 },
      token,
    );
    expect(completions).toEqual({ suggestions: [] });
    expect(r.request).not.toHaveBeenCalled();
  });

  it("a failed request is no answer, not an error in the editor", async () => {
    r.request.mockRejectedValue("The language server didn't answer in time.");
    expect(await createHoverProvider(r.deps).provideHover(r.model, at(1, 5), token)).toBeNull();
  });

  it("completion passes the trigger and converts the items onto the word being typed", async () => {
    r.request.mockResolvedValue({ isIncomplete: false, items: [{ label: "foo", kind: 3 }] });
    const list = await createCompletionProvider(r.deps).provideCompletionItems(
      r.model,
      at(4, 3),
      { triggerKind: 1, triggerCharacter: "." },
      token,
    );
    const params = r.request.mock.calls[0]?.[2] as {
      context: { triggerKind: number; triggerCharacter: string };
    };
    expect(params.context).toEqual({ triggerKind: 2, triggerCharacter: "." });
    expect(list?.suggestions[0]?.label).toBe("foo");
    expect(list?.suggestions[0]?.kind).toBe(monaco.languages.CompletionItemKind.Function);
    // The word "fo" at line 4 col 1-3 is replaced.
    expect(list?.suggestions[0]?.range).toMatchObject({
      startLineNumber: 4,
      startColumn: 1,
      endColumn: 3,
    });
  });

  it("Go to Definition returns the open file's own model for a location in it, and a peek copy for a closed file", async () => {
    r.request.mockResolvedValue([
      {
        uri: "file:///C:/My%20Site/app.py",
        range: { start: { line: 0, character: 4 }, end: { line: 0, character: 7 } },
      },
      {
        uri: "file:///C:/My%20Site/lib/helpers.py",
        range: { start: { line: 2, character: 0 }, end: { line: 2, character: 3 } },
      },
    ]);
    const peek = new PeekModels(r.ipc);
    const provider = createLocationProvider(r.deps, peek, "definition", "textDocument/definition");
    const locations = await provider.provideDefinition(r.model, at(4, 1), token);
    expect(locations).toHaveLength(2);
    const [own, closed] = locations as monaco.languages.Location[];
    expect(own?.uri.toString()).toBe(r.model.uri.toString());
    expect(own?.range.startLineNumber).toBe(1);
    expect(closed?.uri.scheme).toBe("file");
    expect(closed?.uri.fsPath.toLowerCase()).toContain("helpers.py");
    expect(monaco.editor.getModel(closed?.uri as monaco.Uri)?.getValue()).toContain("helpers.py");
    peek.disposeAll();
    expect(monaco.editor.getModel(closed?.uri as monaco.Uri)).toBeNull();
  });

  it("Find References asks with includeDeclaration and lists every location", async () => {
    r.request.mockResolvedValue([
      {
        uri: "file:///C:/My%20Site/app.py",
        range: { start: { line: 3, character: 0 }, end: { line: 3, character: 3 } },
      },
    ]);
    const peek = new PeekModels(r.ipc);
    const references = await createReferenceProvider(r.deps, peek).provideReferences(
      r.model,
      at(1, 5),
      { includeDeclaration: true },
      token,
    );
    expect(r.request.mock.calls[0]?.[1]).toBe("textDocument/references");
    expect(r.request.mock.calls[0]?.[2]).toMatchObject({ context: { includeDeclaration: true } });
    expect(references).toHaveLength(1);
    peek.disposeAll();
  });

  it("Rename: the server's range and placeholder come back, and a refusal is explained", async () => {
    const provider = createRenameProvider(r.deps);
    r.request.mockResolvedValueOnce({
      range: { start: { line: 0, character: 4 }, end: { line: 0, character: 7 } },
      placeholder: "foo",
    });
    const location = await provider.resolveRenameLocation?.(r.model, at(1, 6), token);
    expect(location).toMatchObject({
      text: "foo",
      range: { startLineNumber: 1, startColumn: 5, endColumn: 8 },
    });

    r.request.mockResolvedValueOnce(null);
    const refused = await provider.resolveRenameLocation?.(r.model, at(2, 1), token);
    expect(refused).toMatchObject({ rejectReason: "You cannot rename this element." });
  });

  it("Rename edits in the open file and in a file that wasn't open, without changing the active tab", async () => {
    r.request.mockResolvedValue({
      changes: {
        "file:///C:/My%20Site/app.py": [
          {
            range: { start: { line: 0, character: 4 }, end: { line: 0, character: 7 } },
            newText: "bar",
          },
        ],
        "file:///C:/My%20Site/lib/helpers.py": [
          {
            range: { start: { line: 0, character: 2 }, end: { line: 0, character: 5 } },
            newText: "bar",
          },
        ],
      },
    });
    const edits = await createRenameProvider(r.deps).provideRenameEdits(
      r.model,
      at(1, 6),
      "bar",
      token,
    );
    expect(r.request.mock.calls[0]?.[1]).toBe("textDocument/rename");
    expect(r.request.mock.calls[0]?.[2]).toMatchObject({
      newName: "bar",
      position: { line: 0, character: 5 },
    });
    const list = edits?.edits as monaco.languages.IWorkspaceTextEdit[];
    expect(list).toHaveLength(2);
    expect(list[0]?.resource.toString()).toBe(r.model.uri.toString());
    expect(r.workspace.openPath).toHaveBeenCalledWith(OTHER, { kind: "text" });
    const otherId = r.documents.idForPath(OTHER);
    expect(list[1]?.resource.toString()).toBe(r.documents.modelUri(otherId ?? "") ?? "");
    expect(r.workspace.setActive).toHaveBeenCalled();
  });

  it("Rename: a server error and a file-operation edit are shown, not swallowed", async () => {
    r.request.mockRejectedValue("Intelephense: rename needs a licence.");
    await expect(
      createRenameProvider(r.deps).provideRenameEdits(r.model, at(1, 6), "bar", token),
    ).rejects.toThrow("needs a licence");
    r.request.mockResolvedValue({ documentChanges: [{ kind: "delete", uri: "file:///C:/a.py" }] });
    await expect(
      createRenameProvider(r.deps).provideRenameEdits(r.model, at(1, 6), "bar", token),
    ).rejects.toThrow("delete a file");
  });

  it("Format Document turns the server's edits into Monaco edits, with the editor's tab settings", async () => {
    r.request.mockResolvedValue([
      {
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } },
        newText: "  ",
      },
    ]);
    const edits = await createFormattingProvider(r.deps).provideDocumentFormattingEdits(
      r.model,
      { tabSize: 2, insertSpaces: true },
      token,
    );
    expect(r.request.mock.calls[0]?.[2]).toMatchObject({
      options: { tabSize: 2, insertSpaces: true },
    });
    expect(edits).toEqual([
      { range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 5 }, text: "  " },
    ]);
  });

  it("document symbols come from the server", async () => {
    r.request.mockResolvedValue([
      {
        name: "foo",
        kind: 12,
        range: { start: { line: 0, character: 0 }, end: { line: 1, character: 12 } },
        selectionRange: { start: { line: 0, character: 4 }, end: { line: 0, character: 7 } },
      },
    ]);
    const symbols = await createSymbolProvider(r.deps).provideDocumentSymbols(r.model, token);
    expect(symbols?.[0]).toMatchObject({ name: "foo", kind: monaco.languages.SymbolKind.Function });
  });
});

describe("opening what a location points at", () => {
  it("an open file goes through its tab; a file that isn't open is opened at the position", async () => {
    const r = await rig();
    const opener = createOpener(r.deps);
    const source = {} as monaco.editor.ICodeEditor;
    const id = r.documents.idForPath(PY) ?? "";
    expect(
      opener.openCodeEditor(source, monaco.Uri.parse(r.documents.modelUri(id) ?? ""), {
        startLineNumber: 4,
        startColumn: 1,
        endLineNumber: 4,
        endColumn: 4,
      }),
    ).toBe(true);
    expect(r.workspace.openDocumentAt).toHaveBeenCalledWith(id, { line: 4, column: 1, length: 3 });

    expect(
      opener.openCodeEditor(source, monaco.Uri.file(OTHER), { lineNumber: 2, column: 5 }),
    ).toBe(true);
    expect(r.workspace.openPathAt).toHaveBeenCalledWith(expect.stringContaining("helpers.py"), {
      line: 2,
      column: 5,
      length: 0,
    });
    expect(opener.openCodeEditor(source, monaco.Uri.parse("http://example.com/a"), undefined)).toBe(
      false,
    );
  });
});
