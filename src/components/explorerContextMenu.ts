import { container } from "../services/container";
import { extensionOf, isPreviewableText } from "../services/filePreviewService";
import type { ExplorerNode } from "../services/explorerService";
import type { PopupItem } from "./MenuPopup";
import { resolveContextEntries } from "./contextMenuItems";
import { gitProbe, installEditorMenu } from "../services/editorMenu";
import { fileGitEntries } from "../services/editorMenu/editorMenuModel";

export interface ExplorerMenuActions {
  newFile: (node: ExplorerNode | null) => void;
  newFolder: (node: ExplorerNode | null) => void;
  rename: (node: ExplorerNode) => void;
  delete: (node: ExplorerNode) => void;
  paste: (node: ExplorerNode | null) => void;
}

function item(
  label: string,
  onSelect: () => void,
  extra: Partial<PopupItem & { kind: "item" }> = {},
): PopupItem {
  return { kind: "item", label, enabled: true, onSelect, ...extra };
}

const SEPARATOR: PopupItem = { kind: "separator" };

function copyText(text: string): void {
  container.ipc.clipboardWriteText(text).catch((error: unknown) => {
    container.events.emit("appError", {
      message: `Couldn't copy to the clipboard: ${String(error)}`,
    });
  });
}

function relativePath(path: string, rootPath: string): string {
  return path.startsWith(rootPath) ? path.slice(rootPath.length).replace(/^[\\/]/, "") : path;
}

/** "Open Preview" (rendered, read-only) and "Open as Text" for the formats that have both. */
function previewItems(node: ExplorerNode): PopupItem[] {
  if (node.isDir) return [];
  const asText = extensionOf(node.path) === "svg" || isPreviewableText(node.path);
  const items: PopupItem[] = [];
  if (isPreviewableText(node.path) || extensionOf(node.path) === "svg") {
    items.push(
      item("Open Preview", () => {
        void container.workspace.openFilePreview(node.path);
      }),
    );
  }
  if (asText) {
    items.push(
      item("Open as Text", () => {
        void container.workspace.openPath(node.path, { kind: "text" });
      }),
    );
  }
  return items.length > 0 ? [...items, SEPARATOR] : [];
}

/** The file's Git and Copy As group (Open Changes, Open on Remote, File History ...), judged for that file. */
function gitItems(node: ExplorerNode): PopupItem[] {
  if (node.isDir) return [];
  gitProbe.get(node.path);
  const items = resolveContextEntries(
    fileGitEntries({ path: node.path, line: 1, endLine: 1 }),
    installEditorMenu().reasonForFile,
  );
  return items.length === 0 ? [] : [SEPARATOR, ...items];
}

/** Commands extensions put in the Explorer's context menu; each gets the clicked path as its argument. */
function extensionItems(node: ExplorerNode): PopupItem[] {
  const contributed = container.extensions.contributions.explorerItems();
  if (contributed.length === 0) return [];
  return [
    SEPARATOR,
    ...contributed.map((entry) => {
      const reason = container.commands.reasonFor(entry.command);
      return item(
        entry.label,
        () => {
          container.run(entry.command, { __uri: node.path });
        },
        { enabled: container.commands.isEnabled(entry.command), reason },
      );
    }),
  ];
}

/**
 * The explorer's right-click menu, in VS Code's order. `node` is null for a
 * click on empty space (acts on the workspace root). Only operations the
 * explorer actually supports are listed.
 */
export function explorerContextMenu(
  node: ExplorerNode | null,
  rootPath: string,
  actions: ExplorerMenuActions,
): PopupItem[] {
  const canPaste = container.explorer.hasClipboard();
  const creation: PopupItem[] = [
    item("New File...", () => {
      actions.newFile(node);
    }),
    item("New Folder...", () => {
      actions.newFolder(node);
    }),
  ];
  if (!node) {
    return [
      ...creation,
      SEPARATOR,
      item(
        "Paste",
        () => {
          actions.paste(null);
        },
        { shortcut: "Ctrl+V", enabled: canPaste },
      ),
    ];
  }
  return [
    ...(node.isDir ? [...creation, SEPARATOR] : []),
    ...previewItems(node),
    item(
      "Cut",
      () => {
        container.explorer.setClipboard(node.path, "cut");
      },
      { shortcut: "Ctrl+X" },
    ),
    item(
      "Copy",
      () => {
        container.explorer.setClipboard(node.path, "copy");
      },
      { shortcut: "Ctrl+C" },
    ),
    item(
      "Paste",
      () => {
        actions.paste(node);
      },
      { shortcut: "Ctrl+V", enabled: canPaste },
    ),
    item("Duplicate", () => void container.explorer.duplicate(node.parentPath, node.path)),
    SEPARATOR,
    item("Copy Path", () => {
      copyText(node.path);
    }),
    item("Copy Relative Path", () => {
      copyText(relativePath(node.path, rootPath));
    }),
    ...gitItems(node),
    ...extensionItems(node),
    SEPARATOR,
    item(
      "Rename...",
      () => {
        actions.rename(node);
      },
      { shortcut: "F2" },
    ),
    item(
      "Delete",
      () => {
        actions.delete(node);
      },
      { shortcut: "Delete", danger: true },
    ),
  ];
}
