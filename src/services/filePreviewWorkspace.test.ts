import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { BufferManager } from "./bufferManager";
import { DocumentService } from "./documentService";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import { ExtensionEditorService } from "./extensionEditorService";
import { HostDocumentSync } from "./extensionHostSync";
import type { EditorService } from "./editorService";
import type { PreviewInspection } from "./previewIpc";
import { WorkspaceService } from "./workspaceService";

const NO_EDIT = { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0, text: "x" };

function inspection(path: string): PreviewInspection {
  const ext = path.split(".").pop() ?? "";
  const kinds: Record<string, PreviewInspection["kind"]> = {
    png: "image",
    svg: "image",
    pdf: "pdf",
    md: "markdown",
    csv: "csv",
    bin: "unsupported",
  };
  return {
    path,
    name: path.split("/").pop() ?? path,
    size: 10,
    kind: kinds[ext] ?? "unsupported",
    binary: ext === "png" || ext === "pdf" || ext === "bin",
    tooLarge: false,
    limit: 1000,
    textSafe: ext === "svg" || ext === "md" || ext === "csv",
  };
}

function rig() {
  const events = new EventBus<AppEvents>();
  const buffers = new BufferManager();
  const errors: string[] = [];
  events.on("appError", ({ message }) => errors.push(message));
  const ipc = createFakeIpc({
    documentOpen: vi.fn((path: string) =>
      Promise.resolve({
        path,
        content: "hello world",
        encoding: "utf8" as const,
        lineEnding: "lf" as const,
      }),
    ),
    previewInspect: vi.fn((path: string) => Promise.resolve(inspection(path))),
    previewReadBytes: vi.fn().mockResolvedValue("AAAA"),
    previewReadText: vi.fn().mockResolvedValue({ text: "# x", truncated: false }),
  });
  const documents = new DocumentService(ipc, buffers, events);
  const workspace = new WorkspaceService(documents, ipc, events);
  return { events, buffers, ipc, documents, workspace, errors };
}

async function openTab(r: { workspace: WorkspaceService }, path: string): Promise<string> {
  return (await r.workspace.openPath(path)) ?? "";
}

describe("preview tabs in the workspace", () => {
  let r: ReturnType<typeof rig>;
  beforeEach(() => {
    r = rig();
  });

  it("an image opens as a read-only preview tab: no document, never dirty, its path in the session", async () => {
    const id = await openTab(r, "C:/My Site/logo.png");
    const tab = r.workspace.getState().tabs[0];
    expect(tab).toMatchObject({
      id,
      kind: "filePreview",
      title: "logo.png",
      path: "C:/My Site/logo.png",
      dirty: false,
      external: "none",
    });
    expect(r.workspace.getState().activeId).toBe(id);
    expect(r.ipc.documentOpen).not.toHaveBeenCalled();
    expect(r.documents.has(tab?.docId ?? "")).toBe(false);
    expect(r.ipc.sessionSave).toHaveBeenLastCalledWith({
      openPaths: ["C:/My Site/logo.png"],
      activePath: "C:/My Site/logo.png",
    });
  });

  it("Save, Save As, Save All and Revert do nothing on a preview and write nothing", async () => {
    const id = await openTab(r, "C:/a.png");
    await r.workspace.save(id);
    await r.workspace.saveAs(id);
    await r.workspace.saveAll();
    r.workspace.revert(id);
    expect(r.ipc.documentSave).not.toHaveBeenCalled();
    expect(r.ipc.saveDocumentDialog).not.toHaveBeenCalled();
    expect(r.errors).toEqual([]);
    expect(r.workspace.getState().tabs).toHaveLength(1);
  });

  it("code and text formats keep the text editor; an unknown binary file is a preview, not an error toast", async () => {
    await openTab(r, "C:/a.rs");
    await openTab(r, "C:/notes.md");
    expect(r.workspace.getState().tabs.map((tab) => tab.kind)).toEqual(["text", "text"]);
    const bin = await openTab(r, "C:/data.bin");
    expect(r.workspace.getState().tabs.find((tab) => tab.id === bin)?.kind).toBe("filePreview");
    expect(r.errors).toEqual([]);
    expect(r.ipc.documentOpen).toHaveBeenCalledTimes(2);
  });

  it("closing the tab releases the preview and Reopen Closed Editor brings it back", async () => {
    const id = await openTab(r, "C:/a.pdf");
    const docId = r.workspace.getState().tabs[0]?.docId ?? "";
    expect(r.workspace.filePreviews.has(docId)).toBe(true);
    await r.workspace.close(id);
    expect(r.workspace.filePreviews.has(docId)).toBe(false);
    expect(r.workspace.getState().tabs).toEqual([]);
    await r.workspace.reopenClosed();
    expect(r.workspace.getState().tabs[0]).toMatchObject({ kind: "filePreview", title: "a.pdf" });
  });

  it("Open Preview on a text file (Markdown, CSV) opens a file preview tab; other files say why not", async () => {
    const csv = await openTab(r, "C:/data.csv");
    const csvDoc = r.workspace.docIdOfTab(csv) ?? "";
    expect(r.workspace.filePreviewUnavailableReason(csvDoc)).toBeNull();
    expect(await r.workspace.openFilePreviewOf(csvDoc)).toBe(true);
    const kinds = r.workspace.getState().tabs.map((tab) => tab.kind);
    expect(kinds).toEqual(["text", "filePreview"]);
    // The preview tab is told apart from the text tab of the same file.
    expect(r.workspace.getState().tabs.map((tab) => tab.title)).toEqual([
      "data.csv",
      "Preview data.csv",
    ]);
    const rs = await openTab(r, "C:/a.rs");
    expect(r.workspace.filePreviewUnavailableReason(r.workspace.docIdOfTab(rs))).toContain(
      "Markdown, HTML, LaTeX and CSV",
    );
    expect(r.workspace.filePreviewUnavailableReason(null)).toContain("no editor");
    // A preview is already a preview.
    const previewDoc = r.workspace.getState().tabs.find((t) => t.kind === "filePreview")?.docId;
    expect(r.workspace.filePreviewUnavailableReason(previewDoc ?? null)).toBe(
      "This is already a preview.",
    );
    expect(r.workspace.isFilePreview(previewDoc ?? "")).toBe(true);
  });

  it("Open as Text swaps a safe preview (SVG) for the editor in place and refuses a binary one", async () => {
    const svg = await openTab(r, "C:/a.svg");
    await vi.waitFor(() => {
      expect(r.workspace.filePreviewState(svg)?.info?.textSafe).toBe(true);
    });
    expect(await r.workspace.openAsText(svg)).toBe(true);
    const state = r.workspace.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]).toMatchObject({ kind: "text", path: "C:/a.svg" });
    expect(r.workspace.filePreviews.has(svg)).toBe(false);

    const png = await openTab(r, "C:/b.png");
    await vi.waitFor(() => {
      expect(r.workspace.filePreviewState(png)?.info).not.toBeNull();
    });
    expect(await r.workspace.openAsText(png)).toBe(false);
    expect(r.errors.at(-1)).toContain("can't be opened as text safely");
    expect(r.workspace.getState().tabs.find((tab) => tab.id === png)?.kind).toBe("filePreview");
  });

  it("a saved session reopens previews and text files, skipping a preview whose file is gone", async () => {
    vi.mocked(r.ipc.sessionLoad).mockResolvedValue({
      openPaths: ["C:/a.png", "C:/gone.pdf", "C:/b.rs"],
      activePath: "C:/a.png",
    });
    vi.mocked(r.ipc.previewInspect).mockImplementation((path: string) =>
      path.includes("gone")
        ? Promise.reject(new Error("The file doesn't exist."))
        : Promise.resolve(inspection(path)),
    );
    await r.workspace.restoreSession();
    const state = r.workspace.getState();
    expect(state.tabs.map((tab) => [tab.kind, tab.title])).toEqual([
      ["filePreview", "a.png"],
      ["text", "b.rs"],
    ]);
    expect(state.tabs.find((tab) => tab.id === state.activeId)?.title).toBe("a.png");
  });
});

describe("extensions and preview tabs", () => {
  function extensionRig() {
    const base = rig();
    const sent: [string, unknown][] = [];
    const sync = new HostDocumentSync({
      documents: base.documents,
      events: base.events,
      notify: (method, params) => sent.push([method, params]),
      editorState: () => ({
        selections: [{ anchorLine: 0, anchorColumn: 0, activeLine: 0, activeColumn: 5 }],
        tabSize: 4,
        insertSpaces: true,
      }),
      onSelectionChange: () => () => undefined,
      currentActiveId: () => base.workspace.getState().activeId,
    });
    const service = new ExtensionEditorService({
      documents: base.documents,
      editor: {} as unknown as EditorService,
      sync,
      hasTextTab: (docId) =>
        base.workspace
          .getState()
          .groups.some((group) =>
            group.tabs.some((tab) => tab.docId === docId && tab.kind === "text"),
          ),
    });
    return { ...base, sent, sync, service };
  }

  it("a preview tab is never the active text editor, and switching back restores it", async () => {
    const r = extensionRig();
    const text = await openTab(r, "C:/My Site/a.txt");
    r.sync.start();
    expect(r.sync.initial().activeEditor).toMatchObject({ path: "C:/My Site/a.txt" });

    const image = await openTab(r, "C:/My Site/logo.png");
    expect(r.workspace.getState().activeId).toBe(image);
    expect(r.sync.initial().activeEditor).toBeNull();
    expect(r.sent.at(-1)).toEqual(["host/activeEditorChanged", { editor: null }]);

    r.workspace.setActive(text);
    expect(r.sync.initial().activeEditor).toMatchObject({ path: "C:/My Site/a.txt" });
    expect(r.sent.at(-1)).toMatchObject([
      "host/activeEditorChanged",
      { editor: { path: "C:/My Site/a.txt" } },
    ]);

    // A host that starts while the preview is active is told there is no editor at all.
    r.workspace.setActive(image);
    expect(r.sync.initial().activeEditor).toBeNull();
    r.sync.stop();
  });

  it("an extension edit for a file that is only previewed is refused and changes nothing", async () => {
    const r = extensionRig();
    await openTab(r, "C:/My Site/logo.png");
    r.sync.start();
    const result = r.service.applyEdits({
      path: "C:/My Site/logo.png",
      version: 0,
      edits: [NO_EDIT],
    });
    expect(result).toEqual({ applied: false, reason: "C:/My Site/logo.png isn't open." });
    // The same file open as text is editable (until it is also shown as a preview only).
    const csv = await openTab(r, "C:/My Site/data.csv");
    const csvDoc = r.workspace.docIdOfTab(csv) ?? "";
    await r.workspace.openFilePreviewOf(csvDoc);
    r.workspace.setActive(
      r.workspace.getState().tabs.find((t) => t.kind === "filePreview")?.id ?? "",
    );
    expect(r.sync.initial().activeEditor).toBeNull();
    r.sync.stop();
  });
});
