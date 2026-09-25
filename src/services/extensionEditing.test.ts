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
  const listeners = new Set<() => void>();
  const sync = new HostDocumentSync({
    documents,
    events,
    notify: (method, params) => sent.push([method, params]),
    editorState: () => ({ selections, tabSize: 2, insertSpaces: false }),
    onSelectionChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  const tab = { value: hasTextTab };
  const service = new ExtensionEditorService({
    documents,
    editor: {} as unknown as EditorService,
    sync,
    hasTextTab: () => tab.value,
  });
  return { buffers, events, documents, sent, sync, service, tab, selections, listeners };
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
