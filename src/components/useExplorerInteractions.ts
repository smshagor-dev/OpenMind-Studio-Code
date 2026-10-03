import { useCallback, useState } from "react";

import { container } from "../services/container";
import { type ExplorerNode, type ExplorerSnapshot, targetDirFor } from "../services/explorerService";
import { isSameOrDescendant } from "../services/explorerTree";
import type { ExplorerMenuActions } from "./explorerContextMenu";

export interface PendingEdit {
  path: string;
  parentDir: string;
  initialValue: string;
}

export type PendingConfirm =
  | { kind: "delete"; node: ExplorerNode }
  | { kind: "move"; node: ExplorerNode; destDir: string; destName: string };

export interface ContextMenuState {
  x: number;
  y: number;
  node: ExplorerNode | null;
}

/**
 * The explorer's transient, UI-only interaction state (which context menu, inline rename or confirmation is open) plus
 * the actions that open them. The tree, the name box of a new entry and every file operation are `ExplorerService`'s.
 */
export function useExplorerInteractions(snapshot: ExplorerSnapshot) {
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const [pendingEdit, setPendingEdit] = useState<PendingEdit | null>(null);

  async function startCreate(kind: "file" | "folder", node: ExplorerNode | null) {
    setPendingEdit(null);
    await container.explorer.beginCreate(kind, node);
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
    pendingCreate: snapshot.pendingCreate ?? null,
    commitCreate: (name: string) => {
      void container.explorer.commitCreate(name);
    },
    cancelCreate: () => {
      container.explorer.cancelCreate();
    },
    startCreate,
    requestMove,
    actions,
  };
}
