import { useCallback, useState } from "react";

import { container } from "../services/container";
import type { ExplorerNode, ExplorerSnapshot } from "../services/explorerService";
import { isSameOrDescendant } from "../services/explorerTree";
import type { ExplorerMenuActions } from "./explorerContextMenu";

export interface PendingEdit {
  path: string;
  parentDir: string;
  initialValue: string;
}

/** A new file or folder being named in the tree: nothing exists on disk until the name is confirmed (VS Code). */
export interface PendingCreate {
  parentDir: string;
  kind: "file" | "folder";
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
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);

  async function startCreate(kind: "file" | "folder", node: ExplorerNode | null) {
    const parentDir = targetDirFor(snapshot, node);
    setPendingEdit(null);
    await container.explorer.prepareCreate(parentDir);
    setPendingCreate({ parentDir, kind });
  }

  /** The typed name: an empty one (Escape, or leaving the box empty) creates nothing. A new file opens in the editor. */
  function commitCreate(name: string) {
    const create = pendingCreate;
    setPendingCreate(null);
    if (!create || name === "") return;
    void container.explorer.createNamed(create.parentDir, name, create.kind).then(async (created) => {
      if (created === null) return;
      if (create.kind === "file") await container.workspace.openPath(created);
      await container.explorer.revealPath(created);
    });
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
    if (!edit || newName === "" || newName === edit.initialValue) return;
    void container.explorer.rename(edit.parentDir, node.path, newName);
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
    pendingCreate,
    commitCreate,
    cancelCreate: () => {
      setPendingCreate(null);
    },
    startCreate,
    requestMove,
    actions,
  };
}
