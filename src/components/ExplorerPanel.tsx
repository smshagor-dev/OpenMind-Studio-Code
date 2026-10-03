import { useEffect, useState, useSyncExternalStore } from "react";

import { container } from "../services/container";
import type { ExplorerNode, ExplorerSnapshot } from "../services/explorerService";
import { ConfirmDialog } from "./ConfirmDialog";
import { explorerContextMenu, type ExplorerMenuActions } from "./explorerContextMenu";
import { FileTree } from "./FileTree";
import { CollapseAllIcon, NewFileIcon, NewFolderIcon, PinIcon, RefreshIcon } from "./icons";
import { MenuPopup } from "./MenuPopup";
import { type PaneAction, PaneSection } from "./PaneSection";
import { useDismissOnOutside } from "./useDismissOnOutside";
import { type PendingConfirm, useExplorerInteractions } from "./useExplorerInteractions";
import { t } from "../i18n";

interface ExplorerPanelProps {
  activeDocPath: string | null;
  dirtyPaths: Set<string>;
  expanded: boolean;
  onToggle: () => void;
}

/** The workspace-folder section of the explorer: header actions, the file tree, context menu, rename/delete/move. */
export function ExplorerPanel({
  activeDocPath,
  dirtyPaths,
  expanded,
  onToggle,
}: ExplorerPanelProps) {
  const snapshot = useSyncExternalStore(
    (listener) => container.explorer.subscribe(listener),
    () => container.explorer.getSnapshot(),
  );
  const ui = useExplorerInteractions(snapshot);
  const [focusToken, setFocusToken] = useState(0);
  const pinned = usePinnedState(snapshot.rootPath);

  useEffect(
    () =>
      container.events.on("focusExplorer", () => {
        if (!expanded) onToggle();
        setFocusToken((token) => token + 1);
      }),
    [expanded, onToggle],
  );

  // A name box opened from a menu or the palette is shown even when this section was collapsed.
  const creating = snapshot.pendingCreate ?? null;
  useEffect(() => {
    if (creating !== null && !expanded) onToggle();
  }, [creating, expanded, onToggle]);

  if (!snapshot.rootPath) {
    return null;
  }
  const rootPath = snapshot.rootPath;

  return (
    <PaneSection
      title={snapshot.rootName ?? rootPath}
      expanded={expanded}
      onToggle={onToggle}
      grow
      actions={folderActions(ui.actions, {
        pinned,
        rootPath,
        rootName: snapshot.rootName,
      })}
    >
      <div
        className="explorer-panel"
        onKeyDown={(event) => {
          handleClipboardKeys(event, snapshot, ui.actions.paste);
        }}
      >
        <FileTree
          snapshot={snapshot}
          dirtyPaths={dirtyPaths}
          activeDocPath={activeDocPath}
          editingPath={ui.pendingEdit?.path ?? null}
          editingInitialValue={ui.pendingEdit?.initialValue ?? ""}
          creating={ui.pendingCreate}
          onCommitCreate={ui.commitCreate}
          onCancelCreate={ui.cancelCreate}
          createProblem={(name) => container.explorer.createNameProblem(name)}
          renameProblem={(path, name) => container.explorer.renameProblem(path, name)}
          focusToken={focusToken}
          onToggleExpand={(path) => void container.explorer.toggleExpand(path)}
          onSelect={(path) => void container.explorer.select(path)}
          onOpenFile={(path) => void container.workspace.openPath(path, { preview: true })}
          onKeepFileOpen={(path) => void container.workspace.openPath(path)}
          onContextMenu={(event, node) => {
            ui.setMenu({ x: event.clientX, y: event.clientY, node });
          }}
          onCommitEdit={ui.commitEdit}
          onCancelEdit={ui.cancelEdit}
          onRename={ui.actions.rename}
          onDelete={ui.actions.delete}
          onMove={ui.requestMove}
        />
      </div>
      {ui.menu ? (
        <ContextMenuOverlay
          x={ui.menu.x}
          y={ui.menu.y}
          items={explorerContextMenu(ui.menu.node, rootPath, ui.actions)}
          onClose={ui.closeMenu}
        />
      ) : null}
      {ui.confirm ? <ExplorerConfirm confirm={ui.confirm} onDone={ui.clearConfirm} /> : null}
    </PaneSection>
  );
}

interface FolderPinState {
  pinned: boolean;
  rootPath: string;
  rootName: string | null;
}

function folderActions(actions: ExplorerMenuActions, pin: FolderPinState): PaneAction[] {
  return [
    {
      label: t("explorer.newFile"),
      icon: <NewFileIcon />,
      onRun: () => {
        actions.newFile(null);
      },
    },
    {
      label: t("explorer.newFolder"),
      icon: <NewFolderIcon />,
      onRun: () => {
        actions.newFolder(null);
      },
    },
    {
      label: t("explorer.refresh"),
      icon: <RefreshIcon />,
      onRun: () => {
        container.run("explorer.refresh");
      },
    },
    {
      label: t("explorer.collapse"),
      icon: <CollapseAllIcon />,
      onRun: () => {
        container.run("explorer.collapseAll");
      },
    },
    {
      label: pin.pinned ? t("explorer.unpin") : t("explorer.pin"),
      icon: <PinIcon filled={pin.pinned} />,
      onRun: () => {
        if (pin.pinned) {
          void container.workspace.unpinFolder(pin.rootPath);
        } else {
          void container.workspace.pinFolder(pin.rootPath, pin.rootName ?? undefined);
        }
      },
    },
  ];
}

/** Whether `rootPath` is currently pinned; re-reads on mount, root change, and `pinnedFoldersChanged`. */
function usePinnedState(rootPath: string | null): boolean {
  const [pinned, setPinned] = useState(false);

  useEffect(() => {
    if (!rootPath) {
      return;
    }
    let cancelled = false;
    const refresh = () => {
      void container.workspace.loadPinnedFolders().then((entries) => {
        if (!cancelled) {
          setPinned(entries.some((entry) => entry.path === rootPath));
        }
      });
    };
    refresh();
    const unsubscribe = container.events.on("pinnedFoldersChanged", refresh);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [rootPath]);

  return pinned;
}

/** Ctrl+C / Ctrl+X / Ctrl+V on the focused tree — the explorer clipboard, like VS Code. */
function handleClipboardKeys(
  event: React.KeyboardEvent,
  snapshot: ExplorerSnapshot,
  paste: (node: ExplorerNode | null) => void,
) {
  if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return;
  if (!(event.target instanceof HTMLElement) || event.target.getAttribute("role") !== "tree")
    return;
  const selected = snapshot.selectedPath;
  if (event.code === "KeyC" && selected) container.explorer.setClipboard(selected, "copy");
  else if (event.code === "KeyX" && selected) container.explorer.setClipboard(selected, "cut");
  else if (event.code === "KeyV") paste(null);
  else return;
  event.preventDefault();
}

function ContextMenuOverlay(props: React.ComponentProps<typeof MenuPopup>) {
  useDismissOnOutside(true, props.onClose);
  return <MenuPopup {...props} autoFocus />;
}

function ExplorerConfirm({ confirm, onDone }: { confirm: PendingConfirm; onDone: () => void }) {
  const { node } = confirm;
  if (confirm.kind === "delete") {
    return (
      <ConfirmDialog
        title={t("explorer.deleteTitle")}
        message={t("explorer.deleteMessage", { name: node.name })}
        confirmLabel={t("explorer.moveToRecycleBin")}
        onCancel={onDone}
        onConfirm={() => {
          void container.explorer.deleteEntry(node.parentPath, node.path);
          onDone();
        }}
      />
    );
  }
  return (
    <ConfirmDialog
      title={t("explorer.move")}
      message={t("explorer.moveMessage", { name: node.name, target: confirm.destName })}
      confirmLabel={t("explorer.move")}
      tone="primary"
      onCancel={onDone}
      onConfirm={() => {
        void container.explorer.moveEntry(node.parentPath, node.path, confirm.destDir);
        onDone();
      }}
    />
  );
}
