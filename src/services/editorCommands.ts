import type { CommandRegistry } from "./commandRegistry";
import { extensionOf, isMarkdownPath } from "./editorAssociationService";
import type { EditorAssociationService } from "./editorAssociationService";
import type { EditorGroupService } from "./editorGroupService";
import type { MarkdownPreviewService } from "./markdownPreviewService";
import type { OpenEditorsService } from "./openEditorsService";
import type { PreviewEditorService } from "./previewEditorService";
import type { ReopenView, WorkspaceService } from "./workspaceService";

export interface EditorCommandDeps {
  commands: CommandRegistry;
  workspace: WorkspaceService;
  groups: EditorGroupService;
  openEditors: OpenEditorsService;
  previews: PreviewEditorService;
  associations: EditorAssociationService;
  markdown: MarkdownPreviewService;
}

const REOPEN_VIEWS: readonly ReopenView[] = ["text", "markdownEditor", "markdownPreview"];

function asGroupId(value: unknown, fallback: string): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}

/**
 * The editor area's commands: split, close-all/close-saved, preview
 * behavior, group locking, Markdown preview, "reopen with" and default-editor
 * associations. Each takes an optional group id (from a group's own header
 * menu) and otherwise acts on the active group, so the menu bar, keyboard and
 * the per-group ⋯ menu all run the same code.
 */
export function registerEditorCommands(deps: EditorCommandDeps): void {
  const { commands, workspace, groups, openEditors, previews, associations, markdown } = deps;
  const activeGroupId = () => groups.getState().activeGroupId;
  const activeDocId = () => groups.activeTab()?.docId ?? null;
  const activePath = () => {
    const docId = activeDocId();
    return docId === null ? null : workspace.docPath(docId);
  };
  const hasActiveTab = () => groups.activeTab() !== null;

  commands.register(
    "editor.splitRight",
    () => {
      workspace.splitRight();
    },
    { enabled: hasActiveTab },
  );
  // The View > Editor Layout entry and the title-bar button share the command.
  commands.register(
    "editorLayout.splitRight",
    () => {
      workspace.splitRight();
    },
    { enabled: hasActiveTab },
  );

  commands.register(
    "editor.closeAll",
    (groupId) => openEditors.closeAll(asGroupId(groupId, activeGroupId())),
    { enabled: () => openEditors.count(activeGroupId()) > 0 },
  );
  commands.register(
    "editor.closeSaved",
    (groupId) => openEditors.closeSaved(asGroupId(groupId, activeGroupId())),
    { enabled: () => openEditors.hasSaved(activeGroupId()) },
  );

  commands.register("editor.togglePreviewEditors", () => previews.toggle(), {
    checked: () => previews.isEnabled(),
  });
  commands.register(
    "editor.lockGroup",
    (groupId) => {
      const id = asGroupId(groupId, activeGroupId());
      workspace.setGroupLocked(id, !(groups.getGroup(id)?.locked ?? false));
    },
    { checked: () => groups.activeGroup().locked },
  );
  commands.register(
    "editor.keepOpen",
    (groupId, tabId) => {
      if (typeof tabId === "string") workspace.pinTab(asGroupId(groupId, activeGroupId()), tabId);
    },
    { enabled: () => groups.activeTab()?.preview === true },
  );

  commands.register(
    "editor.openPreview",
    () => {
      const docId = activeDocId();
      if (docId !== null) markdown.openPreview(docId);
    },
    { enabled: () => markdown.unavailableReason(activeDocId()) === null },
  );
  commands.register(
    "editor.openPreviewToSide",
    () => {
      const docId = activeDocId();
      if (docId !== null) markdown.openPreviewToSide(docId);
    },
    { enabled: () => markdown.unavailableReason(activeDocId()) === null },
  );

  commands.register(
    "editor.reopenWith",
    (view, groupId) => {
      const group = groups.getGroup(asGroupId(groupId, activeGroupId()));
      const tab = group?.tabs.find((candidate) => candidate.id === group.activeTabId);
      if (group && tab && REOPEN_VIEWS.includes(view as ReopenView)) {
        workspace.reopenTabAs(group.id, tab.id, view as ReopenView);
      }
    },
    { enabled: hasActiveTab },
  );

  commands.register(
    "editor.setDefaultForExtension",
    async (kind) => {
      const extension = extensionOf(activePath());
      if (extension !== null && (kind === "text" || kind === "markdownPreview")) {
        await associations.setDefault(extension, kind);
      }
    },
    { enabled: () => isMarkdownPath(activePath()) },
  );
}
