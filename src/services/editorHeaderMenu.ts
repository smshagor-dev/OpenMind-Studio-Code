import { extensionOf, isMarkdownPath } from "./editorAssociationService";
import type { EditorAssociationService } from "./editorAssociationService";
import type { EditorGroupService } from "./editorGroupService";
import type { EditorService } from "./editorService";
import type { LayoutService } from "./layoutService";
import type { MarkdownPreviewService } from "./markdownPreviewService";
import type { OpenEditorsService } from "./openEditorsService";
import type { PreviewEditorService } from "./previewEditorService";
import type { ReopenView, WorkspaceService } from "./workspaceService";

/** A row of the editor group's ⋯ menu — the same shape the popup renders, built here so its rules are testable. */
export type HeaderMenuRow =
  | {
      kind: "item";
      label: string;
      enabled: boolean;
      checked?: boolean;
      /** Why it's disabled. Every disabled row has one. */
      reason?: string;
      /** Print the reason under the label as well as in the tooltip. */
      showReason?: boolean;
      onSelect: () => void;
    }
  | { kind: "submenu"; label: string; items: HeaderMenuRow[] }
  | { kind: "separator" };

export interface HeaderMenuContext {
  workspace: WorkspaceService;
  groups: EditorGroupService;
  openEditors: OpenEditorsService;
  previews: PreviewEditorService;
  associations: EditorAssociationService;
  markdown: MarkdownPreviewService;
  editor: EditorService;
  layout: LayoutService;
  /** Runs a command by id (the same path menus and shortcuts take). */
  run: (id: string, ...args: unknown[]) => void;
}

const SEPARATOR: HeaderMenuRow = { kind: "separator" };

function item(
  label: string,
  enabled: boolean,
  onSelect: () => void,
  extra: { checked?: boolean; reason?: string } = {},
): HeaderMenuRow {
  return {
    kind: "item",
    label,
    enabled,
    onSelect,
    ...extra,
    reason: enabled ? undefined : extra.reason,
  };
}

/** Rows that only make sense while a file preview is the active editor: Open as Text and Reload Preview. */
function previewToolRows(
  ctx: HeaderMenuContext,
  activeTab: { kind: string; docId: string } | null,
): HeaderMenuRow[] {
  if (activeTab?.kind !== "filePreview") return [];
  const textSafe = ctx.workspace.filePreviewState(activeTab.docId)?.info?.textSafe === true;
  return [
    item(
      "Open as Text",
      textSafe,
      () => {
        ctx.run("preview.openAsText");
      },
      { reason: "This file can't be opened as text safely." },
    ),
    item("Reload Preview", true, () => {
      ctx.run("preview.reload");
    }),
  ];
}

/**
 * The ⋯ (More Actions) menu of one editor group. Every row either works or
 * is disabled with the reason why; nothing that can't work for this group's
 * active editor is offered as if it could.
 */
export function buildEditorActionsMenu(ctx: HeaderMenuContext, groupId: string): HeaderMenuRow[] {
  const group = ctx.groups.getGroup(groupId);
  const activeTab = group?.tabs.find((tab) => tab.id === group.activeTabId) ?? null;
  const docId = activeTab?.docId ?? null;
  const path = docId === null ? null : ctx.workspace.docPath(docId);
  const previewReason = ctx.markdown.unavailableReason(docId);
  const filePreviewReason = ctx.workspace.filePreviewUnavailableReason(docId);
  const noEditor = "There is no editor open in this group.";

  return [
    showOpenEditors(ctx, groupId),
    item(
      "Close All",
      ctx.openEditors.count(groupId) > 0,
      () => {
        ctx.run("editor.closeAll", groupId);
      },
      {
        reason: noEditor,
      },
    ),
    item(
      "Close Saved",
      ctx.openEditors.hasSaved(groupId),
      () => {
        ctx.run("editor.closeSaved", groupId);
      },
      {
        reason:
          ctx.openEditors.count(groupId) === 0
            ? noEditor
            : "Every open editor has unsaved changes.",
      },
    ),
    SEPARATOR,
    item(
      "Split Editor Right",
      activeTab !== null,
      () => {
        ctx.run("editor.splitRight");
      },
      {
        reason: noEditor,
      },
    ),
    item(
      "Open Preview to the Side",
      previewReason === null,
      () => {
        ctx.run("editor.openPreviewToSide");
      },
      { reason: previewReason ?? undefined },
    ),
    item(
      "Open as Preview",
      previewReason === null,
      () => {
        ctx.run("editor.openPreview");
      },
      {
        reason: previewReason ?? undefined,
      },
    ),
    item(
      "Open File Preview",
      filePreviewReason === null,
      () => {
        ctx.run("preview.open");
      },
      { reason: filePreviewReason ?? undefined },
    ),
    ...previewToolRows(ctx, activeTab),
    SEPARATOR,
    item(
      "Enable Preview Editors",
      true,
      () => {
        ctx.run("editor.togglePreviewEditors");
      },
      {
        checked: ctx.previews.isEnabled(),
      },
    ),
    item(
      "Lock Group",
      true,
      () => {
        ctx.run("editor.lockGroup", groupId);
      },
      {
        checked: group?.locked ?? false,
      },
    ),
    configureEditor(ctx),
    SEPARATOR,
    reopenWith(ctx, groupId, activeTab !== null, path),
    setDefault(ctx, path),
  ];
}

function showOpenEditors(ctx: HeaderMenuContext, groupId: string): HeaderMenuRow {
  const entries = ctx.openEditors.list();
  if (entries.length === 0) {
    return item("Show Open Editors", false, () => undefined, { reason: "No editors are open." });
  }
  const multipleGroups = ctx.openEditors.groups().length > 1;
  return {
    kind: "submenu",
    label: "Show Open Editors",
    items: entries.map((entry) => ({
      kind: "item" as const,
      label: multipleGroups
        ? `${entry.tab.title} — Group ${String(entry.groupNumber)}`
        : entry.tab.title,
      enabled: true,
      checked: entry.active && entry.groupId === groupId,
      onSelect: () => {
        ctx.openEditors.show(entry);
      },
    })),
  };
}

function configureEditor(ctx: HeaderMenuContext): HeaderMenuRow {
  const options = ctx.editor.getOptions();
  const toggle = (label: string, id: string, checked: boolean): HeaderMenuRow =>
    item(
      label,
      true,
      () => {
        ctx.run(id);
      },
      { checked },
    );
  return {
    kind: "submenu",
    label: "Configure Editor",
    items: [
      toggle("Word Wrap", "view.toggleWordWrap", options.wordWrap),
      toggle("Minimap", "view.toggleMinimap", options.minimap),
      toggle("Sticky Scroll", "view.toggleStickyScroll", options.stickyScroll),
      toggle("Render Whitespace", "view.toggleRenderWhitespace", options.renderWhitespace),
      toggle("Breadcrumbs", "view.toggleBreadcrumbs", ctx.layout.getState().breadcrumbsVisible),
    ],
  };
}

function reopenWith(
  ctx: HeaderMenuContext,
  groupId: string,
  hasEditor: boolean,
  path: string | null,
): HeaderMenuRow {
  const tab = ctx.groups
    .getGroup(groupId)
    ?.tabs.find((t) => t.id === ctx.groups.getGroup(groupId)?.activeTabId);
  if (!hasEditor || !tab) {
    return item("Reopen Editor With", false, () => undefined, {
      reason: "There is no editor open in this group.",
    });
  }
  if (tab.kind === "filePreview") {
    return item("Reopen Editor With", false, () => undefined, {
      reason: "Use Open as Text in the preview toolbar.",
    });
  }
  const markdown = isMarkdownPath(path);
  const language = ctx.workspace.docLanguage(tab.docId);
  const current: ReopenView =
    tab.kind === "markdownPreview"
      ? "markdownPreview"
      : language === "markdown"
        ? "markdownEditor"
        : "text";
  const notMarkdown = "Available for Markdown (.md) files.";
  const row = (label: string, view: ReopenView, needsMarkdown: boolean): HeaderMenuRow => {
    const isCurrent = current === view;
    const available = !needsMarkdown || markdown;
    return item(
      label,
      available && !isCurrent,
      () => {
        ctx.run("editor.reopenWith", view, groupId);
      },
      {
        checked: isCurrent,
        reason: !available ? notMarkdown : "Already open with this editor.",
      },
    );
  };
  return {
    kind: "submenu",
    label: "Reopen Editor With",
    items: [
      row("Text Editor", "text", false),
      row("Markdown Editor", "markdownEditor", true),
      row("Markdown Preview", "markdownPreview", true),
    ],
  };
}

function setDefault(ctx: HeaderMenuContext, path: string | null): HeaderMenuRow {
  const extension = extensionOf(path);
  if (extension === null || !isMarkdownPath(path)) {
    return item(
      extension === null ? "Set Default Editor for File Type" : `Set Default for "${extension}"`,
      false,
      () => undefined,
      {
        reason:
          extension === null
            ? "Open a saved file to choose its default editor."
            : "Only Markdown files can be opened in more than one editor.",
      },
    );
  }
  const current = ctx.associations.getDefault(extension) ?? "text";
  const choose = (label: string, kind: "text" | "markdownPreview"): HeaderMenuRow =>
    item(
      label,
      true,
      () => {
        ctx.run("editor.setDefaultForExtension", kind);
      },
      {
        checked: current === kind,
      },
    );
  return {
    kind: "submenu",
    label: `Set Default for "${extension}"`,
    items: [choose("Text Editor", "text"), choose("Markdown Preview", "markdownPreview")],
  };
}
