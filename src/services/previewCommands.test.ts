import { describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { BufferManager } from "./bufferManager";
import { CommandRegistry } from "./commandRegistry";
import { DocumentService } from "./documentService";
import { EditorGroupService } from "./editorGroupService";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { MarkdownPreviewService } from "./markdownPreviewService";
import { registerPreviewCommands } from "./previewCommands";
import type { PreviewInspection } from "./previewIpc";
import { WorkspaceService } from "./workspaceService";
import { kindOfPath } from "./filePreviewService";

function inspection(path: string): PreviewInspection {
  const svg = path.endsWith(".svg");
  return {
    path,
    name: path.split("/").pop() ?? path,
    size: 10,
    kind: kindOfPath(path),
    binary: path.endsWith(".png") || path.endsWith(".bin"),
    tooLarge: false,
    limit: 1000,
    textSafe: svg || path.endsWith(".csv") || path.endsWith(".md"),
  };
}

function rig() {
  const events = new EventBus<AppEvents>();
  const ipc = createFakeIpc({
    documentOpen: vi.fn((path: string) =>
      Promise.resolve({
        path,
        content: "x",
        encoding: "utf8" as const,
        lineEnding: "lf" as const,
      }),
    ),
    previewInspect: vi.fn((path: string) => Promise.resolve(inspection(path))),
    previewReadBytes: vi.fn().mockResolvedValue("AAAA"),
    previewReadText: vi.fn().mockResolvedValue({ text: "a,b", truncated: false }),
  });
  const groups = new EditorGroupService();
  const documents = new DocumentService(ipc, new BufferManager(), events);
  const workspace = new WorkspaceService(documents, ipc, events, { groups });
  const commands = new CommandRegistry();
  const openPreview = vi.fn().mockReturnValue(true);
  registerPreviewCommands({
    commands,
    workspace,
    groups,
    markdown: { openPreview } as unknown as MarkdownPreviewService,
    filePreviews: workspace.filePreviews,
  });
  return { commands, workspace, ipc, openPreview };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe("preview commands", () => {
  it("with nothing open, every preview command is disabled with a reason", () => {
    const { commands } = rig();
    for (const id of [
      "preview.open",
      "preview.openAsText",
      "preview.reload",
      "preview.zoomIn",
      "preview.zoomOut",
      "preview.fit",
      "preview.actualSize",
    ]) {
      expect(commands.isEnabled(id), id).toBe(false);
      expect(commands.reasonFor(id), id).toBeTruthy();
    }
  });

  it("Open Preview: a CSV gets a file preview, Markdown keeps its live preview, code says why not", async () => {
    const { commands, workspace, openPreview } = rig();
    await workspace.openPath("C:/a.rs");
    expect(commands.isEnabled("preview.open")).toBe(false);
    expect(commands.reasonFor("preview.open")).toContain("Markdown, HTML, LaTeX and CSV");
    await workspace.openPath("C:/data.csv");
    expect(commands.isEnabled("preview.open")).toBe(true);
    await commands.execute("preview.open");
    expect(workspace.getState().tabs.at(-1)?.kind).toBe("filePreview");
    expect(openPreview).not.toHaveBeenCalled();
    await workspace.openPath("C:/notes.md");
    await commands.execute("preview.open");
    expect(openPreview).toHaveBeenCalledTimes(1);
  });

  it("zoom commands work on an image, are disabled with a reason on a CSV preview, and drive the same state as the toolbar", async () => {
    const { commands, workspace } = rig();
    const image = await workspace.openPath("C:/a.png");
    await settle();
    expect(commands.isEnabled("preview.zoomIn")).toBe(true);
    await commands.execute("preview.zoomIn");
    expect(workspace.filePreviewState(image ?? "")).toMatchObject({ zoomMode: "zoom", zoom: 1.25 });
    await commands.execute("preview.actualSize");
    expect(workspace.filePreviewState(image ?? "")?.zoomMode).toBe("actual");
    await commands.execute("preview.fit");
    expect(workspace.filePreviewState(image ?? "")?.zoomMode).toBe("fit");
    await commands.execute("preview.zoomOut");
    expect(workspace.filePreviewState(image ?? "")?.zoom).toBe(0.75);

    const csv = await workspace.openFilePreview("C:/data.csv");
    await settle();
    expect(workspace.getState().activeId).toBe(csv);
    expect(commands.isEnabled("preview.zoomIn")).toBe(false);
    expect(commands.reasonFor("preview.zoomIn")).toContain("images and PDFs");
  });

  it("Reload reloads the active preview; Open as Text only when safe, with a reason otherwise", async () => {
    const { commands, workspace, ipc } = rig();
    await workspace.openPath("C:/a.png");
    await settle();
    const before = vi.mocked(ipc.previewInspect).mock.calls.length;
    await commands.execute("preview.reload");
    expect(vi.mocked(ipc.previewInspect).mock.calls.length).toBeGreaterThan(before);
    expect(commands.isEnabled("preview.openAsText")).toBe(false);
    expect(commands.reasonFor("preview.openAsText")).toContain("can't be opened as text safely");

    await workspace.openPath("C:/logo.svg");
    await settle();
    expect(commands.isEnabled("preview.openAsText")).toBe(true);
    await commands.execute("preview.openAsText");
    expect(workspace.getState().tabs.find((tab) => tab.path === "C:/logo.svg")?.kind).toBe("text");
  });
});
