import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { HOST_DIR, loadHostModule } from "../testUtils/hostModules";

/* The extension host's `vscode` shim, run in-process against a fake application: documents, the active editor,
   TextEditor.edit, WorkspaceEdit and status bar items (Milestone 10.3). */

interface Position {
  line: number;
  character: number;
}
interface RangeLike {
  start: Position;
  end: Position;
  isEmpty: boolean;
}
interface Doc {
  version: number;
  isDirty: boolean;
  isClosed: boolean;
  lineCount: number;
  languageId: string;
  uri: { fsPath: string };
  getText(range?: RangeLike): string;
  lineAt(line: number | Position): {
    text: string;
    lineNumber: number;
    isEmptyOrWhitespace: boolean;
    range: RangeLike;
    firstNonWhitespaceCharacterIndex: number;
  };
  offsetAt(position: Position): number;
  positionAt(offset: number): Position;
  validateRange(range: RangeLike): RangeLike;
  validatePosition(position: Position): Position;
}
interface Editor {
  document: Doc;
  selection: RangeLike & {
    anchor: Position;
    active: Position;
    isReversed: boolean;
  };
  selections: RangeLike[];
  options: { tabSize: number; insertSpaces: boolean };
  edit(callback: (builder: Builder) => void): Promise<boolean>;
  revealRange(range: RangeLike): void;
  setDecorations: () => void;
}
interface Builder {
  insert(position: Position, text: string): void;
  replace(range: RangeLike, text: string): void;
  delete(range: RangeLike): void;
  setEndOfLine(value: number): void;
}
interface StatusItem {
  text: string;
  tooltip: string;
  command: string;
  color: unknown;
  backgroundColor: unknown;
  show(): void;
  hide(): void;
  dispose(): void;
}
interface Api {
  Position: new (line: number, character: number) => Position;
  Range: new (
    a: number | Position,
    b: number | Position,
    c?: number,
    d?: number,
  ) => RangeLike;
  Selection: new (a: number, b: number, c: number, d: number) => RangeLike;
  WorkspaceEdit: new () => {
    insert(uri: unknown, position: Position, text: string): void;
    replace(uri: unknown, range: RangeLike, text: string): void;
    delete(uri: unknown, range: RangeLike): void;
    has(uri: unknown): boolean;
    entries(): [unknown, unknown[]][];
    size: number;
    createFile(): void;
  };
  Uri: { file(path: string): unknown };
  StatusBarAlignment: { Left: number; Right: number };
  ThemeColor: new (id: string) => { id: string };
  window: {
    activeTextEditor: Editor | undefined;
    visibleTextEditors: Editor[];
    createStatusBarItem(alignment?: number, priority?: number): StatusItem;
    onDidChangeActiveTextEditor(
      listener: (editor: Editor | undefined) => void,
    ): unknown;
    onDidChangeTextEditorSelection(
      listener: (event: {
        textEditor: Editor;
        selections: RangeLike[];
      }) => void,
    ): unknown;
    createTextEditorDecorationType(): void;
  };
  workspace: {
    applyEdit(edit: unknown): Promise<boolean>;
    onDidChangeTextDocument(
      listener: (event: { document: Doc }) => void,
    ): unknown;
    textDocuments: Doc[];
  };
}

const ROOT = mkdtempSync(join(tmpdir(), "openmind-editor-"));
const FILE = join(ROOT, "a.txt");
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function rig(
  permissions: string[] = ["workspaceRead", "workspaceWrite", "commands"],
) {
  const vscode = loadHostModule(`${HOST_DIR}/vscode.js`) as {
    createApi: (host: unknown, ext: unknown) => Api;
    createEventHub: () => {
      on: (n: string) => unknown;
      fire: (n: string, p: unknown) => void;
    };
    disposeApi: (api: Api) => void;
  };
  const state = {
    commands: new Map(),
    providers: new Map(),
    configuration: {},
    workspaceFolders: [{ path: ROOT, name: "My Site" }],
    documents: new Map<string, Record<string, unknown>>(),
    activeEditor: null as Record<string, unknown> | null,
  };
  const requests: [string, Record<string, unknown>][] = [];
  const notifications: [string, Record<string, unknown>][] = [];
  const answer = vi.fn<
    (method: string, params: Record<string, unknown>) => unknown
  >(() => ({
    applied: true,
  }));
  const events = vscode.createEventHub();
  const host = {
    state,
    events,
    als: null,
    request: (method: string, params: Record<string, unknown>) => {
      requests.push([method, params]);
      return Promise.resolve(answer(method, params));
    },
    notify: (method: string, params: Record<string, unknown>) => {
      notifications.push([method, params]);
    },
  };
  const api = vscode.createApi(host, { id: "t.sample", permissions });
  const open = (text: string, version = 1) => {
    state.documents.set(FILE, {
      path: FILE,
      languageId: "plaintext",
      version,
      text,
      isDirty: false,
    });
    state.activeEditor = {
      path: FILE,
      selections: [
        { anchorLine: 0, anchorColumn: 0, activeLine: 0, activeColumn: 0 },
      ],
      tabSize: 2,
      insertSpaces: false,
    };
  };
  return { api, state, events, requests, notifications, answer, open, vscode };
}

describe("activeTextEditor and TextDocument", () => {
  it("is undefined without an active editor and exists when a file is shown", () => {
    const r = rig();
    expect(r.api.window.activeTextEditor).toBeUndefined();
    expect(r.api.window.visibleTextEditors).toEqual([]);
    r.open("hello");
    expect(r.api.window.activeTextEditor?.document.uri.fsPath).toBe(FILE);
    expect(r.api.window.visibleTextEditors).toHaveLength(1);
    expect(r.api.window.activeTextEditor?.options).toEqual({
      tabSize: 2,
      insertSpaces: false,
    });
  });

  it("reads text, lines, offsets and positions (line breaks counted as they are)", () => {
    const r = rig();
    r.open("one\r\ntwo\nthree four");
    const doc = r.api.window.activeTextEditor?.document as Doc;
    expect(doc.getText()).toBe("one\r\ntwo\nthree four");
    expect(doc.lineCount).toBe(3);
    expect(doc.getText(new r.api.Range(0, 1, 1, 2))).toBe("ne\r\ntw");
    expect(doc.lineAt(2).text).toBe("three four");
    expect(doc.lineAt(new r.api.Position(1, 0)).lineNumber).toBe(1);
    expect(doc.lineAt(0).range.end.character).toBe(3);
    expect(doc.lineAt(1).firstNonWhitespaceCharacterIndex).toBe(0);
    expect(doc.offsetAt(new r.api.Position(1, 1))).toBe(6);
    expect(doc.offsetAt(new r.api.Position(2, 5))).toBe(14);
    expect(doc.positionAt(6)).toMatchObject({ line: 1, character: 1 });
    expect(doc.positionAt(4)).toMatchObject({ line: 0, character: 3 });
    expect(doc.positionAt(5)).toMatchObject({ line: 1, character: 0 });
    expect(doc.positionAt(1000)).toMatchObject({ line: 2, character: 10 });
    expect(() => doc.lineAt(9)).toThrow("Illegal value for `line`");
    expect(doc.validatePosition(new r.api.Position(0, 99))).toMatchObject({
      line: 0,
      character: 3,
    });
    expect(doc.validatePosition(new r.api.Position(99, 0))).toMatchObject({
      line: 2,
      character: 10,
    });
    const range = doc.validateRange(new r.api.Range(0, 0, 50, 50));
    expect(range.end).toMatchObject({ line: 2, character: 10 });
  });

  it("a document object stays live: the version and text follow the application's changes", () => {
    const r = rig();
    r.open("a");
    const doc = r.api.window.activeTextEditor?.document as Doc;
    expect([doc.version, doc.isDirty, doc.getText()]).toEqual([1, false, "a"]);
    r.state.documents.set(FILE, {
      path: FILE,
      languageId: "plaintext",
      version: 2,
      text: "ab",
      isDirty: true,
    });
    expect([doc.version, doc.isDirty, doc.getText()]).toEqual([2, true, "ab"]);
    r.state.documents.delete(FILE);
    expect(doc.isClosed).toBe(true);
  });

  it("selection and selections come from the application; a reversed selection keeps its anchor", () => {
    const r = rig();
    r.open("hello world");
    r.state.activeEditor = {
      ...r.state.activeEditor,
      selections: [
        { anchorLine: 0, anchorColumn: 5, activeLine: 0, activeColumn: 0 },
        { anchorLine: 0, anchorColumn: 6, activeLine: 0, activeColumn: 11 },
      ],
    };
    const editor = r.api.window.activeTextEditor as Editor;
    expect(editor.selection.isReversed).toBe(true);
    expect(editor.selection.anchor).toMatchObject({ line: 0, character: 5 });
    expect(editor.selection.active).toMatchObject({ line: 0, character: 0 });
    expect(editor.selection.start).toMatchObject({ character: 0 });
    expect(editor.selections).toHaveLength(2);
    expect(editor.document.getText(editor.selections[1])).toBe("world");
  });

  it("fires the selection and change events, and setting a selection tells the application", () => {
    const r = rig();
    r.open("hello");
    const selected = vi.fn();
    const changed = vi.fn();
    r.api.window.onDidChangeTextEditorSelection(selected);
    r.api.workspace.onDidChangeTextDocument(changed);
    r.state.activeEditor = {
      ...r.state.activeEditor,
      selections: [
        { anchorLine: 0, anchorColumn: 1, activeLine: 0, activeColumn: 3 },
      ],
    };
    r.events.fire("selectionChanged", { path: FILE });
    expect(selected).toHaveBeenCalledOnce();
    const first = selected.mock.calls[0]?.[0] as { selections: RangeLike[] };
    expect(first.selections[0]?.end.character).toBe(3);
    r.events.fire("documentChanged", {
      path: FILE,
      languageId: "plaintext",
      version: 2,
      text: "hello!",
      isDirty: true,
    });
    expect(changed).toHaveBeenCalledOnce();

    const editor = r.api.window.activeTextEditor as Editor;
    editor.selection = new r.api.Selection(0, 0, 0, 2) as Editor["selection"];
    expect(r.notifications.at(-1)).toEqual([
      "editor/setSelections",
      {
        extension: "t.sample",
        path: FILE,
        selections: [
          { anchorLine: 0, anchorColumn: 0, activeLine: 0, activeColumn: 2 },
        ],
      },
    ]);
    editor.revealRange(new r.api.Range(0, 0, 0, 1));
    expect(r.notifications.at(-1)?.[0]).toBe("editor/revealRange");
  });
});

describe("TextEditor.edit", () => {
  it("batches insert, replace and delete into one request in text order", async () => {
    const r = rig();
    r.open("hello world\nsecond");
    const editor = r.api.window.activeTextEditor as Editor;
    const ok = await editor.edit((b) => {
      b.delete(new r.api.Range(1, 0, 1, 3));
      b.replace(new r.api.Range(0, 6, 0, 11), "there");
      b.insert(new r.api.Position(0, 0), ">> ");
    });
    expect(ok).toBe(true);
    expect(r.requests).toHaveLength(1);
    expect(r.requests[0]?.[0]).toBe("editor/applyEdits");
    expect(r.requests[0]?.[1]).toMatchObject({ path: FILE, version: 1 });
    expect(r.requests[0]?.[1].edits).toEqual([
      { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0, text: ">> " },
      {
        startLine: 0,
        startColumn: 6,
        endLine: 0,
        endColumn: 11,
        text: "there",
      },
      { startLine: 1, startColumn: 0, endLine: 1, endColumn: 3, text: "" },
    ]);
  });

  it("rejects overlapping edits with a clear error and sends nothing", async () => {
    const r = rig();
    r.open("abcdef");
    const editor = r.api.window.activeTextEditor as Editor;
    await expect(
      editor.edit((b) => {
        b.replace(new r.api.Range(0, 0, 0, 3), "X");
        b.replace(new r.api.Range(0, 2, 0, 4), "Y");
      }),
    ).rejects.toThrow("Overlapping ranges are not allowed!");
    expect(r.requests).toEqual([]);
    // Touching ranges and two inserts at one point are fine.
    await expect(
      editor.edit((b) => {
        b.replace(new r.api.Range(0, 0, 0, 2), "X");
        b.replace(new r.api.Range(0, 2, 0, 4), "Y");
        b.insert(new r.api.Position(0, 6), "1");
        b.insert(new r.api.Position(0, 6), "2");
      }),
    ).resolves.toBe(true);
  });

  it("returns false when the application refuses (a preview, a stale version) and keeps the reason in the host log", async () => {
    const r = rig();
    r.open("abc");
    r.answer.mockReturnValue({
      applied: false,
      reason: "shown read-only (a preview)",
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const editor = r.api.window.activeTextEditor as Editor;
    await expect(
      editor.edit((b) => {
        b.insert(new r.api.Position(0, 0), "x");
      }),
    ).resolves.toBe(false);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("shown read-only (a preview)"),
    );
    log.mockRestore();
  });

  it("returns false on a closed document, and an empty edit is true without a request", async () => {
    const r = rig();
    r.open("abc");
    const editor = r.api.window.activeTextEditor as Editor;
    await expect(editor.edit(() => undefined)).resolves.toBe(true);
    expect(r.requests).toEqual([]);
    r.state.documents.delete(FILE);
    await expect(
      editor.edit((b) => {
        b.insert(new r.api.Position(0, 0), "x");
      }),
    ).resolves.toBe(false);
  });

  it("clamps ranges to the document, forbids setEndOfLine and use of the builder after the callback", async () => {
    const r = rig();
    r.open("abc");
    const editor = r.api.window.activeTextEditor as Editor;
    let kept: Builder | undefined;
    await editor.edit((b) => {
      kept = b;
      b.replace(new r.api.Range(0, 1, 9, 9), "Z");
      expect(() => {
        b.setEndOfLine(1);
      }).toThrow(
        "VS Code API 'TextEditorEdit.setEndOfLine' is not supported by OpenMind Studio yet.",
      );
    });
    expect(r.requests[0]?.[1].edits).toEqual([
      { startLine: 0, startColumn: 1, endLine: 0, endColumn: 3, text: "Z" },
    ]);
    expect(() => kept?.insert(new r.api.Position(0, 0), "late")).toThrow(
      "only valid inside the edit callback",
    );
  });

  it("an open file outside the workspace needs filesystemOutsideWorkspace; without a folder open it doesn't", async () => {
    const outside = rig();
    outside.state.documents.set("D:\\elsewhere\\b.txt", {
      path: "D:\\elsewhere\\b.txt",
      languageId: "plaintext",
      version: 1,
      text: "x",
      isDirty: false,
    });
    outside.state.activeEditor = {
      path: "D:\\elsewhere\\b.txt",
      selections: [],
    };
    const editor = outside.api.window.activeTextEditor as Editor;
    await expect(
      editor.edit((b) => {
        b.insert(new outside.api.Position(0, 0), "y");
      }),
    ).rejects.toThrow(
      "Permission 'filesystemOutsideWorkspace' is required for this extension API.",
    );

    const granted = rig(["filesystemOutsideWorkspace"]);
    granted.state.documents.set("D:\\elsewhere\\b.txt", {
      path: "D:\\elsewhere\\b.txt",
      languageId: "plaintext",
      version: 1,
      text: "x",
      isDirty: false,
    });
    granted.state.activeEditor = {
      path: "D:\\elsewhere\\b.txt",
      selections: [],
    };
    const allowed = granted.api.window.activeTextEditor as Editor;
    await expect(
      allowed.edit((b) => {
        b.insert(new granted.api.Position(0, 0), "y");
      }),
    ).resolves.toBe(true);

    const noFolder = rig([]);
    noFolder.state.workspaceFolders = [];
    noFolder.state.documents.set("D:\\loose.txt", {
      path: "D:\\loose.txt",
      languageId: "plaintext",
      version: 1,
      text: "x",
      isDirty: false,
    });
    noFolder.state.activeEditor = { path: "D:\\loose.txt", selections: [] };
    const loose = noFolder.api.window.activeTextEditor as Editor;
    await expect(
      loose.edit((b) => {
        b.insert(new noFolder.api.Position(0, 0), "y");
      }),
    ).resolves.toBe(true);
  });

  it("unsupported members of an editor still say so", () => {
    const r = rig();
    r.open("abc");
    const editor = r.api.window.activeTextEditor as Editor;
    expect(() => {
      editor.setDecorations();
    }).toThrow(
      "VS Code API 'TextEditor.setDecorations' is not supported by OpenMind Studio yet.",
    );
    expect(() => {
      r.api.window.createTextEditorDecorationType();
    }).toThrow(
      "VS Code API 'window.createTextEditorDecorationType' is not supported by OpenMind Studio yet.",
    );
  });
});

describe("WorkspaceEdit and workspace.applyEdit", () => {
  it("collects edits per file and applies them to open documents in one request", async () => {
    const r = rig();
    r.open("line one");
    const uri = r.api.Uri.file(FILE);
    const edit = new r.api.WorkspaceEdit();
    edit.insert(uri, new r.api.Position(0, 8), "!");
    edit.replace(uri, new r.api.Range(0, 0, 0, 4), "LINE");
    expect(edit.has(uri)).toBe(true);
    expect(edit.size).toBe(1);
    expect(edit.entries()[0]?.[1]).toHaveLength(2);
    await expect(r.api.workspace.applyEdit(edit)).resolves.toBe(true);
    expect(r.requests[0]?.[0]).toBe("editor/applyWorkspaceEdit");
    const files = r.requests[0]?.[1].files as {
      path: string;
      edits: unknown[];
    }[];
    expect(files[0]?.path).toBe(FILE);
    expect(files[0]?.edits).toHaveLength(2);
  });

  it("returns false for a file that isn't open, needs workspaceWrite, and file operations stay unsupported", async () => {
    const r = rig();
    r.open("x");
    const edit = new r.api.WorkspaceEdit();
    edit.insert(
      r.api.Uri.file(join(ROOT, "other.txt")),
      new r.api.Position(0, 0),
      "y",
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(r.api.workspace.applyEdit(edit)).resolves.toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("isn't open"));
    log.mockRestore();
    expect(r.requests).toEqual([]);
    expect(() => {
      edit.createFile();
    }).toThrow(
      "VS Code API 'WorkspaceEdit.createFile' is not supported by OpenMind Studio yet.",
    );

    const readonly = rig(["workspaceRead"]);
    readonly.open("x");
    const other = new readonly.api.WorkspaceEdit();
    other.insert(
      readonly.api.Uri.file(FILE),
      new readonly.api.Position(0, 0),
      "y",
    );
    await expect(readonly.api.workspace.applyEdit(other)).rejects.toThrow(
      "Permission 'workspaceWrite' is required",
    );
  });
});

describe("status bar items", () => {
  it("sends one message per burst of changes, with its alignment, priority, command and mapped theme colour", async () => {
    const r = rig();
    const item = r.api.window.createStatusBarItem(
      r.api.StatusBarAlignment.Right,
      7,
    );
    item.text = "$(rocket) Hi";
    item.tooltip = "tip";
    item.command = "t.run";
    item.backgroundColor = new r.api.ThemeColor(
      "statusBarItem.warningBackground",
    );
    item.show();
    expect(r.notifications).toEqual([]);
    await Promise.resolve();
    expect(r.notifications).toHaveLength(1);
    const [method, params] = r.notifications[0] ?? ["", {}];
    expect(method).toBe("statusBar/set");
    expect(params).toMatchObject({
      extension: "t.sample",
      alignment: "right",
      priority: 7,
      visible: true,
      text: "$(rocket) Hi",
      tooltip: "tip",
      command: { command: "t.run", args: [] },
      background: "statusBarItem.warningBackground",
    });
    expect(String(params.id).startsWith("t.sample#")).toBe(true);
  });

  it("hide, show and dispose; a disposed item can't be updated or shown again", async () => {
    const r = rig();
    const item = r.api.window.createStatusBarItem();
    item.text = "a";
    item.show();
    await Promise.resolve();
    item.hide();
    await Promise.resolve();
    item.show();
    await Promise.resolve();
    item.dispose();
    item.text = "after dispose";
    item.show();
    await Promise.resolve();
    expect(r.notifications.map(([m, p]) => [m, p.visible])).toEqual([
      ["statusBar/set", true],
      ["statusBar/set", false],
      ["statusBar/set", true],
      ["statusBar/dispose", undefined],
    ]);
    expect(r.notifications.some(([, p]) => p.text === "after dispose")).toBe(
      false,
    );
  });

  it("ids are never reused, so an item created after a disposed one is not mistaken for it", async () => {
    const r = rig();
    const first = r.api.window.createStatusBarItem();
    first.show();
    await Promise.resolve();
    first.dispose();
    const second = r.api.window.createStatusBarItem();
    second.show();
    await Promise.resolve();
    const ids = r.notifications
      .filter(([m]) => m === "statusBar/set")
      .map(([, p]) => p.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("an unknown colour is ignored with a warning and never sent as CSS; deactivating disposes every item", async () => {
    const r = rig();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const item = r.api.window.createStatusBarItem();
    item.color = "#ff0000";
    item.show();
    await Promise.resolve();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("colour ignored"),
    );
    expect(r.notifications[0]?.[1].color).toBeNull();
    warn.mockRestore();
    r.vscode.disposeApi(r.api);
    expect(r.notifications.at(-1)?.[0]).toBe("statusBar/dispose");
  });
});
