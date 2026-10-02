import { useCallback, useState } from "react";

import { container } from "../services/container";
import type { ExplorerNode, ExplorerSnapshot } from "../services/explorerService";
import { isSameOrDescendant } from "../services/explorerTree";
import type { ExplorerMenuActions } from "./explorerContextMenu";

export interface PendingEdit {
  path: string;
  parentDir: string;
  initialValue: string;
  /** Set for an entry the user just created: a new file opens in the editor once it is named (as in VS Code). */
  created?: "file" | "folder";
}

export type PendingConfirm =
  | { kind: "delete"; node: ExplorerNode }
  | { kind: "move"; node: ExplorerNode; destDir: string; destName: string };

export interface ContextMenuState {
  x: number;
  y: number;
  node: ExplorerNode | null;
}

/** Where "New File/Folder" and "Paste" land: the given/selected folder, else that file's folder, else the root. */
export function targetDirFor(snapshot: ExplorerSnapshot, node: ExplorerNode | null): string {
  const selected =
    node ?? (snapshot.selectedPath ? snapshot.nodesByPath.get(snapshot.selectedPath) : undefined);
  if (!selected) return snapshot.rootPath ?? "";
  return selected.isDir ? selected.path : selected.parentPath;
}

/**
 * The explorer's transient, UI-only interaction state (which context menu,
 * inline rename or confirmation is open) plus the actions that open them.
 * The actual file operations are all `ExplorerService` calls.
 */
export function useExplorerInteractions(snapshot: ExplorerSnapshot) {
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const [pendingEdit, setPendingEdit] = useState<PendingEdit | null>(null);

  async function startCreate(kind: "file" | "folder", node: ExplorerNode | null) {
    const parentDir = targetDirFor(snapshot, node);
    const created =
      kind === "file"
        ? await container.explorer.createFile(parentDir)
        : await container.explorer.createFolder(parentDir);
    if (created) {
      await container.explorer.revealPath(created);
      const initialValue = kind === "file" ? "Untitled" : "New Folder";
      setPendingEdit({ path: created, parentDir, initialValue, created: kind });
    }
  }

  function requestMove(source: string, destDir: string) {
    const node = snapshot.nodesByPath.get(source);
    if (!node || node.parentPath === destDir || isSameOrDescendant(destDir, source)) return;
    const destName =
      destDir === snapshot.rootPath
        ? (snapshot.rootName ?? destDir)
        : (snapshot.nodesByPath.get(destDir)?.name ?? destDir);
    setConfirm({ kind: "move", node, destDir, destName });
  }

  function commitEdit(node: ExplorerNode, newName: string) {
    const edit = pendingEdit;
    setPendingEdit(null);
    if (!edit) return;
    const opensFile = edit.created === "file";
    if (newName === "" || newName === edit.initialValue) {
      if (opensFile) void openCreated(node.path);
      return;
    }
    void container.explorer.rename(edit.parentDir, node.path, newName).then((renamed) => {
      if (opensFile && renamed !== null) void openCreated(renamed);
    });
  }

  /** A new file opens as a kept (not provisional) tab, selected in the tree, like VS Code. */
  async function openCreated(path: string) {
    await container.workspace.openPath(path);
    await container.explorer.revealPath(path);
  }

  const actions: ExplorerMenuActions = {
    newFile: (node) => {
      void startCreate("file", node);
    },
    newFolder: (node) => {
      void startCreate("folder", node);
    },
    rename: (node) => {
      setPendingEdit({ path: node.path, parentDir: node.parentPath, initialValue: node.name });
    },
    delete: (node) => {
      setConfirm({ kind: "delete", node });
    },
    paste: (node) => {
      void container.explorer.paste(targetDirFor(snapshot, node));
    },
  };

  const closeMenu = useCallback(() => {
    setMenu(null);
  }, []);

  return {
    menu,
    setMenu,
    closeMenu,
    confirm,
    clearConfirm: () => {
      setConfirm(null);
    },
    pendingEdit,
    cancelEdit: () => {
      setPendingEdit(null);
    },
    commitEdit,
    requestMove,
    actions,
  };
}
