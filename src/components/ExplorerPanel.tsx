import { useState, useSyncExternalStore } from "react";

import { container } from "../services/container";
import type { ExplorerNode } from "../services/explorerService";
import { ConfirmDialog } from "./ConfirmDialog";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { FileTree } from "./FileTree";

interface ExplorerPanelProps {
  activeDocPath: string | null;
  dirtyPaths: Set<string>;
}

interface MenuState {
  x: number;
  y: number;
  node: ExplorerNode;
}

interface PendingEdit {
  path: string;
  parentDir: string;
  initialValue: string;
}

export function ExplorerPanel({ activeDocPath, dirtyPaths }: ExplorerPanelProps) {
  const snapshot = useSyncExternalStore(
    (listener) => container.explorer.subscribe(listener),
    () => container.explorer.getSnapshot(),
  );
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ExplorerNode | null>(null);
  const [pendingEdit, setPendingEdit] = useState<PendingEdit | null>(null);

  if (!snapshot.rootPath) {
    return null;
  }
  const rootPath = snapshot.rootPath;

  async function startCreateFile(parentDir: string) {
    const created = await container.explorer.createFile(parentDir);
    if (created) {
      setPendingEdit({ path: created, parentDir, initialValue: "Untitled" });
    }
  }

  async function startCreateFolder(parentDir: string) {
    const created = await container.explorer.createFolder(parentDir);
    if (created) {
      setPendingEdit({ path: created, parentDir, initialValue: "New Folder" });
    }
  }

  function contextMenuItems(node: ExplorerNode): ContextMenuItem[] {
    const parentDir = node.isDir ? node.path : node.parentPath;
    return [
      { label: "New File", onSelect: () => void startCreateFile(parentDir) },
      { label: "New Folder", onSelect: () => void startCreateFolder(parentDir) },
      {
        label: "Rename",
        onSelect: () => {
          setPendingEdit({ path: node.path, parentDir: node.parentPath, initialValue: node.name });
        },
      },
      {
        label: "Duplicate",
        onSelect: () => void container.explorer.duplicate(node.parentPath, node.path),
      },
      {
        label: "Reveal in Explorer",
        onSelect: () => void container.explorer.revealPath(node.path),
      },
      {
        label: "Delete",
        danger: true,
        onSelect: () => {
          setPendingDelete(node);
        },
      },
    ];
  }

  return (
    <div className="explorer-panel">
      <div className="explorer-panel__header">
        <span className="explorer-panel__title">Explorer</span>
      </div>
      <div className="explorer-panel__folder-row">
        <span className="explorer-panel__folder-name" title={rootPath}>
          {snapshot.rootName?.toUpperCase()}
        </span>
        <div className="explorer-panel__actions">
          <button type="button" title="New File" onClick={() => void startCreateFile(rootPath)}>
            +File
          </button>
          <button type="button" title="New Folder" onClick={() => void startCreateFolder(rootPath)}>
            +Folder
          </button>
          <button
            type="button"
            title="Refresh Explorer"
            onClick={() => void container.explorer.refresh()}
          >
            Refresh
          </button>
          <button
            type="button"
            title="Collapse All"
            onClick={() => void container.explorer.collapseAll()}
          >
            Collapse
          </button>
        </div>
      </div>
      <FileTree
        snapshot={snapshot}
        dirtyPaths={dirtyPaths}
        activeDocPath={activeDocPath}
        editingPath={pendingEdit?.path ?? null}
        editingInitialValue={pendingEdit?.initialValue ?? ""}
        onToggleExpand={(path) => void container.explorer.toggleExpand(path)}
        onSelectFile={(path) => {
          void container.explorer.select(path);
          void container.workspace.openPath(path);
        }}
        onContextMenu={(event, node) => {
          setMenu({ x: event.clientX, y: event.clientY, node });
        }}
        onCommitEdit={(node, newName) => {
          const edit = pendingEdit;
          setPendingEdit(null);
          if (!edit || newName === "" || newName === edit.initialValue) {
            return;
          }
          void container.explorer.rename(edit.parentDir, node.path, newName);
        }}
        onCancelEdit={() => {
          setPendingEdit(null);
        }}
      />
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={contextMenuItems(menu.node)}
          onClose={() => {
            setMenu(null);
          }}
        />
      )}
      {pendingDelete && (
        <ConfirmDialog
          title="Delete"
          message={`Are you sure you want to delete "${pendingDelete.name}"? It will be moved to the recycle bin.`}
          confirmLabel="Delete"
          onCancel={() => {
            setPendingDelete(null);
          }}
          onConfirm={() => {
            void container.explorer.deleteEntry(pendingDelete.parentPath, pendingDelete.path);
            setPendingDelete(null);
          }}
        />
      )}
    </div>
  );
}
