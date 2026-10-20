import * as monaco from "monaco-editor";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DocumentService } from "./documentService";
import type { IpcClient } from "./ipc";
import {
  APPLY_CODE_ACTION,
  applyWorkspaceEdit,
  markerDiagnostics,
  runCodeAction,
  toMonacoActions,
  type CodeActionDeps,
} from "./lspCodeActions";
import { convertWorkspaceEdit } from "./lspConvert";
import type { LspService } from "./lspService";
import type { WorkspaceService } from "./workspaceService";

const FILE = "file:///C:/p/a.ts";

function edit(text: string) {
  return {
    changes: {
      [FILE]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: text }],
    },
  };
}

const models: monaco.editor.ITextModel[] = [];
afterEach(() => {
  for (const model of models.splice(0)) model.dispose();
});

function setup(options: { resolve?: unknown; commandEdits?: unknown[]; confirm?: boolean } = {}) {
  const model = monaco.editor.createModel("foo();\n", "plaintext", monaco.Uri.parse("inmemory://test/a.ts"));
  models.push(model);
  const ipc = {
    lspRequest: vi.fn(() => Promise.resolve(options.resolve ?? null)),
    lspExecuteCommand: vi.fn(() => Promise.resolve({ result: null, edits: options.commandEdits ?? [] })),
  } as unknown as IpcClient;
  const deps: CodeActionDeps = {
    ipc,
    documents: {
      idForPath: () => "d1",
      modelUri: () => model.uri.toString(),
    } as unknown as DocumentService,
    workspace: {
      getState: () => ({ activeId: "d1" }),
      setActive: vi.fn(),
      openPath: vi.fn(() => Promise.resolve()),
    } as unknown as WorkspaceService,
    lsp: { serverForPath: () => ({ capabilities: { codeActionResolve: true } }) } as unknown as LspService,
    confirmFiles: vi.fn(() => Promise.resolve(options.confirm ?? true)),
    report: vi.fn(),
  };
  return { model, ipc, deps };
}

describe("code actions", () => {
  it("turns a server answer into Monaco actions that run through OpenMind's command", () => {
    const actions = toMonacoActions("C:/p/a.ts", [
      { title: "Extract function", kind: "refactor.extract.function", isPreferred: true },
      { title: "Organize imports", command: "x.organize" },
      { title: "Can't", kind: "refactor", disabled: { reason: "Select an expression." } },
      "junk",
    ]);
    expect(actions.map((a) => a.title)).toEqual(["Extract function", "Organize imports", "Can't"]);
    expect(actions[0]).toMatchObject({ kind: "refactor.extract.function", isPreferred: true });
    expect(actions[0]?.command?.id).toBe(APPLY_CODE_ACTION);
    expect(actions[2]?.disabled).toBe("Select an expression.");
    expect(toMonacoActions("x", null)).toEqual([]);
  });

  it("sends markers back as LSP diagnostics", () => {
    const [diagnostic] = markerDiagnostics([
      {
        startLineNumber: 2,
        startColumn: 3,
        endLineNumber: 2,
        endColumn: 6,
        message: "Cannot find name",
        severity: monaco.MarkerSeverity.Warning,
        source: "ts",
        code: { value: "2304", target: monaco.Uri.parse("https://x") },
      },
    ]);
    expect(diagnostic).toEqual({
      range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } },
      severity: 2,
      message: "Cannot find name",
      source: "ts",
      code: "2304",
    });
  });

  it("resolves a lazy action, applies its edit as one undo step, then runs its command's edits", async () => {
    const { model, ipc, deps } = setup({
      resolve: { title: "Extract", edit: edit("bar"), command: { title: "c", command: "x.apply" } },
      commandEdits: [edit("baz")],
    });
    await runCodeAction(deps, { path: "C:/p/a.ts", item: { title: "Extract", data: { id: 1 } } });
    expect(ipc.lspRequest).toHaveBeenCalledWith("C:/p/a.ts", "codeAction/resolve", {
      title: "Extract",
      data: { id: 1 },
    });
    expect(ipc.lspExecuteCommand).toHaveBeenCalledWith("C:/p/a.ts", "x.apply", []);
    expect(model.getValue()).toBe("baz();\n");
    await model.undo();
    expect(model.getValue()).toBe("bar();\n");
  });

  it("asks before changing several files and changes nothing when declined", async () => {
    const { model, deps } = setup({ confirm: false });
    const twoFiles = convertWorkspaceEdit({ changes: { ...edit("x").changes, "file:///C:/p/b.ts": [] } });
    expect(await applyWorkspaceEdit(deps, twoFiles)).toBe(false);
    expect(deps.confirmFiles).toHaveBeenCalledTimes(1);
    expect(model.getValue()).toBe("foo();\n");
  });

  it("refuses file creation or renaming, which isn't supported", async () => {
    const { deps } = setup();
    const create = convertWorkspaceEdit({ documentChanges: [{ kind: "create", uri: FILE }] });
    await expect(applyWorkspaceEdit(deps, create)).rejects.toThrow("create");
  });
});
