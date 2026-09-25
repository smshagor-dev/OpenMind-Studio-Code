import type { CommandRegistry } from "./commandRegistry";
import type { EditorGroupService } from "./editorGroupService";
import type { FilePreviewService } from "./filePreviewService";
import { isMarkdownPath } from "./editorAssociationService";
import type { MarkdownPreviewService } from "./markdownPreviewService";
import type { WorkspaceService } from "./workspaceService";

interface PreviewCommandDeps {
  commands: CommandRegistry;
  workspace: WorkspaceService;
  groups: EditorGroupService;
  markdown: MarkdownPreviewService;
  filePreviews: FilePreviewService;
}

/**
 * The read-only preview commands. Every one is disabled with a reason when it can't work: zoom only for images and
 * PDFs, Open as Text only when the file is safe text, and so on. None of them changes a file.
 */
export function registerPreviewCommands({
  commands,
  workspace,
  groups,
  markdown,
  filePreviews,
}: PreviewCommandDeps): void {
  const activeTab = () => groups.activeTab();
  const activePreview = () => {
    const tab = activeTab();
    return tab?.kind === "filePreview" ? filePreviews.get(tab.docId) : undefined;
  };
  const activeTextDocId = () => {
    const tab = activeTab();
    return tab?.kind === "text" ? tab.docId : null;
  };

  const openReason = (): string | undefined => {
    const docId = activeTextDocId();
    if (docId === null) return "Open a Markdown, HTML, LaTeX or CSV file first.";
    return workspace.filePreviewUnavailableReason(docId) ?? undefined;
  };
  commands.register(
    "preview.open",
    async () => {
      const docId = activeTextDocId();
      if (docId === null) return;
      const path = workspace.docPath(docId);
      // Markdown keeps its live preview (it follows the buffer while typing); the other formats show the saved file.
      if (path !== null && isMarkdownPath(path)) markdown.openPreview(docId);
      else await workspace.openFilePreviewOf(docId);
    },
    { enabled: () => openReason() === undefined, disabledReason: openReason },
  );

  const asTextReason = (): string | undefined => {
    const preview = activePreview();
    if (!preview) return "Open a file preview first.";
    if (preview.status !== "ready") return "The preview is still loading.";
    return preview.info?.textSafe === true
      ? undefined
      : "This file can't be opened as text safely.";
  };
  commands.register(
    "preview.openAsText",
    async () => {
      const tab = activeTab();
      if (tab) await workspace.openAsText(tab.id);
    },
    { enabled: () => asTextReason() === undefined, disabledReason: asTextReason },
  );

  commands.register(
    "preview.reload",
    async () => {
      const preview = activePreview();
      if (preview) await filePreviews.reload(preview.id);
    },
    {
      enabled: () => activePreview() !== undefined,
      disabledReason: () => (activePreview() ? undefined : "Open a file preview first."),
    },
  );

  const zoomReason = (): string | undefined => {
    const preview = activePreview();
    if (!preview) return "Open an image or PDF preview first.";
    return filePreviews.zoomable(preview.id) ? undefined : "Zoom is available for images and PDFs.";
  };
  const zoomCommand = (id: string, run: (previewId: string) => void) => {
    commands.register(
      id,
      () => {
        const preview = activePreview();
        if (preview) run(preview.id);
      },
      { enabled: () => zoomReason() === undefined, disabledReason: zoomReason },
    );
  };
  zoomCommand("preview.zoomIn", (id) => {
    filePreviews.zoomIn(id);
  });
  zoomCommand("preview.zoomOut", (id) => {
    filePreviews.zoomOut(id);
  });
  zoomCommand("preview.fit", (id) => {
    filePreviews.fit(id);
  });
  zoomCommand("preview.actualSize", (id) => {
    filePreviews.actualSize(id);
  });
}
