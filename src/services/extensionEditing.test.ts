import { afterEach, describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { BufferManager } from "./bufferManager";
import { DocumentService } from "./documentService";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import { ExtensionEditorService } from "./extensionEditorService";
import { HostBridge } from "./extensionHostBridge";
import { CHANGE_DELAY_MS, HostDocumentSync, SELECTION_DELAY_MS } from "./extensionHostSync";
import type { EditorService } from "./editorService";
import { StatusBarItemsService, displayText } from "./statusBarItemsService";
import type { HostSelection } from "./hostEdits";
import { ExtensionPromptService } from "./extensionPromptService";
import { OutputService } from "./outputService";
import { HOST_DIR, loadHostModule } from "../testUtils/hostModules";

const FILE = "C:/My Site/a.txt";

describe("BufferManager.applyHostEdits", () => {
  let buffers: BufferManager;
  afterEach(() => {
    buffers.disposeAll();
  });

  it("inserts, replaces and deletes (0-based host coordinates) as one undoable step", () => {
    buffers = new BufferManager();
    buffers.create("a", "hello world\nsecond");
    buffers.applyHostEdits("a", [
      { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0, text: ">> " },
      { startLine: 0, startColumn: 6, endLine: 0, endColumn: 11, text: "there" },
      { startLine: 1, startColumn: 0, endLine: 1, endColumn: 3, text: "" },
    ]);
    expect(buffers.getValue("a")).toBe(">> hello there\nond");
    void buffers.get("a")?.undo();
    expect(buffers.getValue("a")).toBe("hello world\nsecond");
  });

  it("changes nothing when an edit is outside the text or two edits overlap", () => {
    buffers = new BufferManager();
    buffers.create("a", "abcdef");
    expect(() => {
      buffers.applyHostEdits("a", [
        { startLine: 0, startColumn: 0, endLine: 0, endColumn: 99, text: "x" },
      ]);
    }).toThrow("outside the document");
    expect(() => {
      buffers.applyHostEdits("a", [
        { startLine: 0, startColumn: 0, endLine: 0, endColumn: 3, text: "X" },
        { startLine: 0, startColumn: 2, endLine: 0, endColumn: 4, text: "Y" },
      ]);
    }).toThrow("Overlapping ranges are not allowed!");
    expect(buffers.getValue("a")).toBe("abcdef");
  });
});

function documentsRig(hasTextTab = true) {
  const buffers = new BufferManager();
  const events = new EventBus<AppEvents>();
  const ipc = createFakeIpc({
    documentOpen: vi.fn().mockImplementation((path: string) =>
      Promise.resolve({
        path,
        content: "hello world\nsecond",
        encoding: "utf8",
        lineEnding: "lf",
      }),
    ),
  });
  const documents = new DocumentService(ipc, buffers, events);
  const sent: [string, unknown][] = [];
  const selections: HostSelection[] = [
    { anchorLine: 0, anchorColumn: 0, activeLine: 0, activeColumn: 5 },
  ];
  const editorOptions = { tabSize: 2, insertSpaces: false };
  const listeners = new Set<() => void>();
  const current: { id: string | null; covered: boolean } = { id: null, covered: false };
  const sync = new HostDocumentSync({
    documents,
    events,
    notify: (method, params) => sent.push([method, params]),
    editorState: () => ({ selections, ...editorOptions }),
    onSelectionChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    currentActiveId: () => current.id,
    editorsCovered: () => current.covered,
  });
  const tab = { value: hasTextTab };
  const service = new ExtensionEditorService({
    documents,
    editor: {} as unknown as EditorService,
    sync,
    hasTextTab: () => tab.value,
  });
  return { buffers, events, documents, sent, sync, service, tab, selections, listeners, current, editorOptions };
}

describe("ExtensionEditorService", () => {
  it("applies an edit to the open buffer only: dirty, version up, the host told before the answer", async () => {
    const r = documentsRig();
    const id = await r.documents.openFromPath(FILE);
    r.sync.start();
    const result = r.service.applyEdits({
      path: FILE,
      version: 1,
      edits: [{ startLine: 0, startColumn: 0, endLine: 0, endColumn: 5, text: "HELLO" }],
    });
    expect(result).toEqual({ applied: true });
    expect(r.documents.contentOf(id)).toBe("HELLO world\nsecond");
    expect(r.documents.isDirty(id)).toBe(true);
    expect(r.sent.at(-1)).toMatchObject([
      "host/documentChanged",
      { path: FILE, version: 2, isDirty: true, text: "HELLO world\nsecond" },
    ]);
    // Nothing was saved: the disk is untouched.
    expect(r.documents.snapshot(id).dirty).toBe(true);
    r.sync.stop();
  });

  it("validates every file before changing any buffer and rejects duplicate model targets", async () => {
    const r = documentsRig();
    const first = await r.documents.openFromPath(FILE), secondPath = "C:/My Site/b.txt";
    const second = await r.documents.openFromPath(secondPath); r.sync.start();
    const edit = { startLine: 0, startColumn: 0, endLine: 0, endColumn: 5, text: "HELLO" };
    const result = r.service.applyWorkspaceEdit({ files: [
      { path: FILE, version: 1, edits: [edit] },
      { path: secondPath, version: 1, edits: [{ ...edit, endColumn: 999 }] },
    ] });
    expect(result).toEqual({ applied: false, reason: "An edit is outside the document." });
    expect(r.documents.contentOf(first)).toBe("hello world\nsecond");
    expect(r.documents.contentOf(second)).toBe("hello world\nsecond");
    expect(r.documents.isDirty(first)).toBe(false);
    expect(r.sync.hasPending(first)).toBe(false); expect(r.sync.versionOf(first)).toBe(1);
    expect(r.service.applyWorkspaceEdit({ files: [
      { path: FILE, version: 1, edits: [edit] }, { path: "c:\\my site\\a.txt", version: 1, edits: [edit] },
    ] })).toMatchObject({ applied: false, reason: "A workspace edit targets the same document more than once." });
    expect(r.documents.isDirty(first)).toBe(false); r.sync.stop(); r.buffers.disposeAll();
  });

  it("applies text and EOL in one undo group, synchronizes EOL and honors joined undo stops", async () => {
    const r = documentsRig(); const id = await r.documents.openFromPath(FILE); r.sync.start();
    expect(r.service.applyEdits({ path: FILE, version: 1, edits: [{ startLine: 0, startColumn: 0, endLine: 0, endColumn: 5, text: "HELLO" }], eol: 2 })).toEqual({ applied: true });
    expect(r.documents.contentOf(id)).toBe("HELLO world\r\nsecond");
    expect(r.documents.snapshot(id).lineEnding).toBe("crlf");
    expect(r.sent.at(-1)).toMatchObject(["host/documentChanged", { eol: 2, version: 2 }]);
    await r.buffers.get(id)?.undo();
    expect(r.documents.contentOf(id)).toBe("hello world\nsecond");
    expect(r.documents.snapshot(id).lineEnding).toBe("lf");
    r.sync.commitChange(id);
    expect(r.service.applyEdits({ path: FILE, version: r.sync.versionOf(id), edits: [], eol: 2, undoStopAfter: false })).toEqual({ applied: true });
    expect(r.service.applyEdits({ path: FILE, version: r.sync.versionOf(id), edits: [{ startLine: 1, startColumn: 0, endLine: 1, endColumn: 6, text: "joined" }], undoStopBefore: false })).toEqual({ applied: true });
    await r.buffers.get(id)?.undo();
    expect(r.documents.contentOf(id)).toBe("hello world\nsecond");
    expect(() => r.service.applyEdits({ path: FILE, version: r.sync.versionOf(id), edits: [], eol: 3 })).toThrow("Invalid end-of-line");
    r.sync.stop(); r.buffers.disposeAll();
  });

  it("refuses a stale version, typing the host hasn't seen yet, a preview-only document and a file that isn't open", async () => {
    const r = documentsRig();
    const id = await r.documents.openFromPath(FILE);
    r.sync.start();
    const edit = { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0, text: "x" };
    expect(r.service.applyEdits({ path: FILE, version: 7, edits: [edit] })).toMatchObject({
      applied: false,
    });
    expect(
      r.service.applyEdits({ path: "C:/My Site/none.txt", version: 1, edits: [edit] }),
    ).toEqual({
      applied: false,
      reason: "C:/My Site/none.txt isn't open.",
    });
    r.tab.value = false;
    const preview = r.service.applyEdits({ path: FILE, version: 1, edits: [edit] });
    expect(preview.applied).toBe(false);
    expect(preview.reason).toContain("read-only");
    r.tab.value = true;
    // The user typed and the host hasn't heard yet: the extension's ranges would be stale.
    vi.useFakeTimers();
    try {
      r.buffers.setValue(id, "typed");
      vi.advanceTimersByTime(1);
      expect(r.sync.hasPending(id)).toBe(true);
      expect(r.service.applyEdits({ path: FILE, version: 1, edits: [edit] })).toMatchObject({
        applied: false,
      });
      vi.advanceTimersByTime(CHANGE_DELAY_MS + 1);
    } finally {
      vi.useRealTimers();
    }
    r.sync.stop();
  });

  it("an invalid or overlapping batch is refused and the buffer is unchanged; a workspace edit covers open files", async () => {
    const r = documentsRig();
    const id = await r.documents.openFromPath(FILE);
    r.sync.start();
    const overlap = r.service.applyEdits({
      path: FILE,
      version: 1,
      edits: [
        { startLine: 0, startColumn: 0, endLine: 0, endColumn: 3, text: "a" },
        { startLine: 0, startColumn: 1, endLine: 0, endColumn: 4, text: "b" },
      ],
    });
    expect(overlap).toEqual({ applied: false, reason: "Overlapping ranges are not allowed!" });
    expect(r.documents.contentOf(id)).toBe("hello world\nsecond");
    expect(() =>
      r.service.applyEdits({ path: FILE, version: 1, edits: [{ startLine: -1 }] }),
    ).toThrow("An edit needs a range");
    const ok = r.service.applyWorkspaceEdit({
      files: [
        {
          path: FILE,
          version: 1,
          edits: [{ startLine: 1, startColumn: 0, endLine: 1, endColumn: 6, text: "2nd" }],
        },
      ],
    });
    expect(ok).toEqual({ applied: true });
    expect(r.documents.contentOf(id)).toBe("hello world\n2nd");
    r.sync.stop();
  });
});

describe("HostDocumentSync: the active editor and its selection", () => {
  it("publishes resolved option changes even when the cursor has not moved", async () => {
    vi.useFakeTimers(); const r = documentsRig();
    try {
      const id = await r.documents.openFromPath(FILE); r.current.id = id; r.sync.start();
      r.editorOptions.tabSize = 8; r.editorOptions.insertSpaces = true;
      for (const listener of r.listeners) listener();
      vi.advanceTimersByTime(SELECTION_DELAY_MS + 1);
      expect(r.sent.at(-1)).toEqual(["host/editorOptionsChanged", { path: FILE, tabSize: 8, insertSpaces: true }]);
      const count = r.sent.length;
      for (const listener of r.listeners) listener();
      vi.advanceTimersByTime(SELECTION_DELAY_MS + 1); expect(r.sent).toHaveLength(count);
    } finally { r.sync.stop(); r.buffers.disposeAll(); vi.useRealTimers(); }
  });

  it("sends the editor with its selections, is null for a preview tab, and debounces selection changes", async () => {
    vi.useFakeTimers();
    try {
      const r = documentsRig();
      const id = await r.documents.openFromPath(FILE);
      r.sync.start();
      expect(r.sync.initial().activeEditor).toBeNull();
      r.events.emit("tabsChanged", { tabs: [], activeId: id });
      expect(r.sent.at(-1)).toEqual([
        "host/activeEditorChanged",
        { editor: { path: FILE, selections: r.selections, tabSize: 2, insertSpaces: false } },
      ]);
      r.events.emit("tabsChanged", { tabs: [], activeId: `${id}#preview` });
      expect(r.sent.at(-1)).toEqual(["host/activeEditorChanged", { editor: null }]);

      r.events.emit("tabsChanged", { tabs: [], activeId: id });
      const before = r.sent.length;
      r.selections[0] = { anchorLine: 1, anchorColumn: 0, activeLine: 1, activeColumn: 3 };
      for (const listener of r.listeners) {
        listener();
        listener();
      }
      expect(r.sent).toHaveLength(before);
      vi.advanceTimersByTime(SELECTION_DELAY_MS + 1);
      expect(r.sent.at(-1)).toEqual([
        "host/selectionChanged",
        { path: FILE, selections: [r.selections[0]] },
      ]);
      // The same selection isn't sent twice.
      for (const listener of r.listeners) listener();
      vi.advanceTimersByTime(SELECTION_DELAY_MS + 1);
      expect(r.sent.filter(([m]) => m === "host/selectionChanged")).toHaveLength(1);
      r.sync.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("HostDocumentSync: the active editor is known from the start, not only after a tab change", () => {
  const editorOf = (path: string) => ({
    path,
    selections: [{ anchorLine: 0, anchorColumn: 0, activeLine: 0, activeColumn: 5 }],
    tabSize: 2,
    insertSpaces: false,
  });

  it("a host that starts after the tab became active gets that editor in its initial state", async () => {
    const r = documentsRig();
    const id = await r.documents.openFromPath(FILE);
    r.current.id = id;
    expect(r.sync.initial().activeEditor).toEqual(editorOf(FILE));
    r.sync.start();
    // Nothing to announce again: the host was handed it at start.
    expect(r.sent.filter(([m]) => m === "host/activeEditorChanged")).toEqual([]);
    r.sync.stop();
  });

  it("a restart hydrates again, keeps one set of listeners, and forgets nothing about versions", async () => {
    const r = documentsRig();
    const id = await r.documents.openFromPath(FILE);
    r.current.id = id;
    r.sync.start();
    r.sync.stop();
    r.sync.start();
    r.sync.start();
    expect(r.sync.initial().activeEditor).toEqual(editorOf(FILE));
    r.events.emit("documentSaved", { id, path: FILE });
    expect(r.sent.filter(([m]) => m === "host/documentSaved")).toHaveLength(1);
    r.sync.stop();
    // While the host was gone the user changed tabs: the restart sees the new one, not a stale one.
    r.current.id = null;
    expect(r.sync.initial().activeEditor).toBeNull();
  });

  it("a preview, webview or any non-text tab is not an editor; a webview covering the editors hides it and uncovering brings it back", async () => {
    const r = documentsRig();
    const id = await r.documents.openFromPath(FILE);
    r.current.id = `${id}#preview`;
    expect(r.sync.initial().activeEditor).toBeNull();
    r.current.id = id;
    r.sync.start();
    r.current.covered = true;
    r.sync.refreshActive();
    expect(r.sent.at(-1)).toEqual(["host/activeEditorChanged", { editor: null }]);
    const count = r.sent.length;
    r.sync.refreshActive();
    expect(r.sent).toHaveLength(count);
    r.current.covered = false;
    r.sync.refreshActive();
    expect(r.sent.at(-1)).toEqual(["host/activeEditorChanged", { editor: editorOf(FILE) }]);
    r.sync.stop();
  });

  it("switching tabs updates the editor and closing the active tab clears it", async () => {
    const r = documentsRig();
    const id = await r.documents.openFromPath(FILE);
    r.current.id = id;
    r.sync.start();
    r.events.emit("tabsChanged", { tabs: [], activeId: `${id}#preview` });
    expect(r.sent.at(-1)).toEqual(["host/activeEditorChanged", { editor: null }]);
    r.events.emit("tabsChanged", { tabs: [], activeId: id });
    expect(r.sent.at(-1)).toEqual(["host/activeEditorChanged", { editor: editorOf(FILE) }]);
    r.events.emit("tabsChanged", { tabs: [], activeId: null });
    expect(r.sent.at(-1)).toEqual(["host/activeEditorChanged", { editor: null }]);
    r.sync.stop();
  });

  it("TextEditor.edit works in a freshly started host without any tab change", async () => {
    const r = documentsRig();
    const id = await r.documents.openFromPath(FILE);
    r.current.id = id;
    const initial = r.sync.initial();
    const vscode = loadHostModule(`${HOST_DIR}/vscode.js`) as {
      createApi: (
        host: unknown,
        ext: unknown,
      ) => {
        window: {
          activeTextEditor?: {
            edit: (
              cb: (b: { insert: (p: unknown, t: string) => void }) => void,
            ) => Promise<boolean>;
          };
        };
        Position: new (l: number, c: number) => unknown;
      };
      createEventHub: () => unknown;
    };
    const state = {
      commands: new Map(),
      providers: new Map(),
      configuration: {},
      workspaceFolders: [{ path: "C:/My Site", name: "My Site" }],
      documents: new Map(initial.documents.map((d) => [d.path, d])),
      activeEditor: initial.activeEditor,
    };
    const requests: [string, unknown][] = [];
    const host = {
      state,
      events: vscode.createEventHub(),
      als: null,
      request: (method: string, params: unknown) => {
        requests.push([method, params]);
        return Promise.resolve({ applied: true });
      },
      notify: () => undefined,
    };
    const api = vscode.createApi(host, { id: "t.sample", permissions: ["workspaceWrite"] });
    const editor = api.window.activeTextEditor;
    expect(editor).toBeDefined();
    await expect(editor?.edit((b) => { b.insert(new api.Position(0, 0), ">"); })).resolves.toBe(true);
    expect(requests[0]?.[0]).toBe("editor/applyEdits");
  });
});

describe("StatusBarItemsService", () => {
  function rig() {
    const ran: [string, unknown[]][] = [];
    const errors: string[] = [];
    const known = new Set(["t.run"]);
    const service = new StatusBarItemsService({
      hasCommand: (command) => known.has(command),
      runCommand: (command, args) => {
        ran.push([command, args]);
        return Promise.resolve(null);
      },
      onError: (message) => errors.push(message),
    });
    const set = (id: string, extra: Record<string, unknown> = {}, extension = "t.sample") => {
      service.handleEvent("statusBar/set", {
        extension,
        id: `${extension}#${id}`,
        alignment: "left",
        priority: 0,
        visible: true,
        text: id,
        tooltip: "",
        command: null,
        color: null,
        background: null,
        ...extra,
      });
    };
    return { service, set, ran, errors };
  }

  it("shows visible items only, plain text without icons, ordered by priority per side", () => {
    const { service, set } = rig();
    set("low", { priority: 1 });
    set("high", { priority: 9, text: "$(rocket) High" });
    set("hidden", { visible: false });
    set("right", { alignment: "right", text: "<b>bold</b>" });
    expect(service.itemsOf("left").map((i) => i.text)).toEqual(["High", "low"]);
    expect(service.itemsOf("right").map((i) => i.text)).toEqual(["<b>bold</b>"]);
    expect(displayText("$(sync~spin) Working")).toBe("Working");
  });

  it("a click runs the item's command; an unregistered one says so instead of failing silently", () => {
    const { service, set, ran, errors } = rig();
    set("a", { command: { command: "t.run", args: [1] } });
    set("b", { command: { command: "t.missing", args: [] } });
    service.click("t.sample#a");
    expect(ran).toEqual([["t.run", [1]]]);
    service.click("t.sample#b");
    expect(errors[0]).toContain("'t.missing', which isn't a registered command");
    expect(ran).toHaveLength(1);
  });

  it("dispose removes an item for good; another extension can't dispose or forge it", () => {
    const { service, set } = rig();
    set("a");
    service.handleEvent("statusBar/dispose", { id: "t.sample#a", extension: "other.ext" });
    expect(service.getItems()).toHaveLength(1);
    service.handleEvent("statusBar/dispose", { id: "t.sample#a", extension: "t.sample" });
    expect(service.getItems()).toHaveLength(0);
    set("a", { text: "back?" });
    expect(service.getItems()).toHaveLength(0);
    service.handleEvent("statusBar/set", {
      extension: "t.sample",
      id: "other.ext#x",
      visible: true,
      text: "forged",
    });
    expect(service.getItems()).toHaveLength(0);
  });

  it("after the host restarts, ids it used before may appear again", () => {
    const { service, set } = rig();
    set("a");
    service.handleEvent("statusBar/dispose", { id: "t.sample#a", extension: "t.sample" });
    set("a");
    expect(service.getItems()).toHaveLength(0);
    service.handleEvent("statusBar/reset", {});
    set("a");
    expect(service.getItems()).toHaveLength(1);
  });

  it("only theme colours it knows are kept; disabling an extension or restarting the host clears its items", () => {
    const { service, set } = rig();
    set("a", { color: "#ff0000", background: "statusBarItem.warningBackground" });
    expect(service.getItems()[0]).toMatchObject({
      color: null,
      background: "statusBarItem.warningBackground",
    });
    set("b", {}, "other.ext");
    service.keepOnly(new Set(["other.ext"]));
    expect(service.getItems().map((i) => i.extension)).toEqual(["other.ext"]);
    service.handleEvent("statusBar/reset", {});
    expect(service.getItems()).toEqual([]);
  });
});

describe("HostBridge: editor and status bar messages", () => {
  function bridge() {
    const editorApi = {
      applyEdits: vi.fn().mockReturnValue({ applied: true }),
      applyWorkspaceEdit: vi.fn().mockReturnValue({ applied: false, reason: "no" }),
      setSelections: vi.fn(),
      setOptions: vi.fn(),
      revealRange: vi.fn(),
    };
    const status: [string, unknown][] = [];
    const b = new HostBridge({
      prompts: new ExtensionPromptService(),
      output: new OutputService(),
      hostRequest: () => Promise.resolve(null),
      showOutput: () => undefined,
      openExternal: () => Promise.resolve(),
      readDocument: () => Promise.resolve(null),
      languageIds: () => [],
      updateConfiguration: () => Promise.resolve(),
      registerProvider: () => () => undefined,
      setDiagnostics: () => undefined,
      runCommand: () => Promise.resolve(null),
      knownCommands: () => [],
      onHostCommandsChanged: () => undefined,
      editorApi: editorApi as unknown as ExtensionEditorService,
      onStatusBarEvent: (method, params) => status.push([method, params]),
    });
    return { b, editorApi, status };
  }

  it("routes edit requests and selection notifications to the editor service, status bar events to the items", async () => {
    const { b, editorApi, status } = bridge();
    await expect(b.handleRequest("editor/applyEdits", { path: FILE })).resolves.toEqual({
      applied: true,
    });
    await expect(b.handleRequest("editor/applyWorkspaceEdit", { files: [] })).resolves.toEqual({
      applied: false,
      reason: "no",
    });
    b.handleNotification("editor/setSelections", { path: FILE });
    b.handleNotification("editor/revealRange", { path: FILE });
    expect(editorApi.setSelections).toHaveBeenCalledOnce();
    expect(editorApi.revealRange).toHaveBeenCalledOnce();
    b.handleNotification("statusBar/set", { id: "a#1" });
    b.handleNotification("statusBar/dispose", { id: "a#1" });
    expect(status.map(([m]) => m)).toEqual(["statusBar/set", "statusBar/dispose"]);
  });

  it("a host that went away takes its status bar items with it", () => {
    const { b, status } = bridge();
    b.reset();
    expect(status).toContainEqual(["statusBar/reset", {}]);
  });

  it("refuses anything that isn't on the fixed list", async () => {
    const { b } = bridge();
    await expect(b.handleRequest("editor/deleteEverything", {})).rejects.toThrow(
      "Not an allowed extension host request",
    );
  });
});

