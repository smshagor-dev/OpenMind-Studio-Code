import { isMarkdownPath } from "./editorAssociationService";
import type { EditorGroupService } from "./editorGroupService";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { IpcClient } from "./ipc";
import { safeHref } from "./markdown";
import { safely } from "./safely";
import type { WorkspaceService } from "./workspaceService";

/**
 * Resolves a relative link found in a Markdown file against that file's own
 * folder, handling `.` and `..` and keeping the file's separator style.
 * Returns `null` if the link would climb above the top of the path.
 */
export function resolveSiblingPath(docPath: string, relative: string): string | null {
  const backslashes = docPath.includes("\\") && !docPath.includes("/");
  const separator = backslashes ? "\\" : "/";
  const parts = docPath.replace(/\\/g, "/").split("/");
  parts.pop(); // the file name; what's left is its folder
  for (const segment of relative.replace(/\\/g, "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      // Never climb past the root (index 0 is the drive or the empty root).
      if (parts.length <= 1) return null;
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  return parts.join(separator);
}

/**
 * Opening, and following links from, the Markdown preview. The preview itself
 * is a tab kind (`markdownPreview`) that the editor area renders live from the
 * document's buffer; this is the orchestration around it.
 */
export class MarkdownPreviewService {
  constructor(
    private readonly workspace: WorkspaceService,
    private readonly groups: EditorGroupService,
    private readonly ipc: IpcClient,
    private readonly events: EventBus<AppEvents>,
  ) {}

  /** Why a preview isn't available for this document, or `null` if it is. */
  unavailableReason(docId: string | null): string | null {
    if (docId === null) return "There is no editor open.";
    if (this.workspace.isFilePreview(docId)) return "This is already a preview.";
    const path = this.workspace.docPath(docId);
    if (path === null) return "Save the file as a Markdown (.md) file to preview it.";
    return isMarkdownPath(path) ? null : "Preview is available for Markdown (.md) files.";
  }

  /** Opens the preview in the active group. */
  openPreview(docId: string): boolean {
    if (this.unavailableReason(docId) !== null) return false;
    this.workspace.openDocument(docId, "markdownPreview");
    return true;
  }

  /**
   * Opens the preview in the group to the right (creating it if there is none)
   * and leaves the editor you were in focused, so you can keep typing.
   */
  openPreviewToSide(docId: string): boolean {
    if (this.unavailableReason(docId) !== null) return false;
    const source = this.groups.getState().activeGroupId;
    const side =
      this.groups.groupToTheRight(source)?.id ?? this.groups.splitRight({ copyActiveTab: false });
    this.workspace.openDocument(docId, "markdownPreview", { groupId: side });
    this.groups.setActiveGroup(source);
    return true;
  }

  /**
   * Follows a link clicked in the preview: web addresses open in the browser,
   * relative paths open that file, in-page anchors are the view's to scroll.
   * Anything else was already refused by `safeHref`.
   */
  async followLink(docId: string, href: string): Promise<void> {
    const target = safeHref(href);
    if (target?.kind === "web") {
      await safely(
        this.events,
        () => this.ipc.openExternalUrl(target.url),
        `open ${target.url}`,
        undefined,
      );
    } else if (target?.kind === "file") {
      const docPath = this.workspace.docPath(docId);
      const resolved = docPath === null ? null : resolveSiblingPath(docPath, target.path);
      if (resolved === null) {
        this.events.emit("appError", { message: `Can't follow the link "${href}".` });
        return;
      }
      await this.workspace.openPath(resolved, { kind: "text" });
    }
  }
}
