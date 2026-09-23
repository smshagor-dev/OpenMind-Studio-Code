import { useEffect, useState, useSyncExternalStore } from "react";

import { container } from "../services/container";
import type { ExplorerNode, ExplorerSnapshot } from "../services/explorerService";
import { ConfirmDialog } from "./ConfirmDialog";
import { explorerContextMenu, type ExplorerMenuActions } from "./explorerContextMenu";
import { FileTree } from "./FileTree";
import { CollapseAllIcon, NewFileIcon, NewFolderIcon, RefreshIcon } from "./icons";
import { MenuPopup } from "./MenuPopup";
import { type PaneAction, PaneSection } from "./PaneSection";
import { useDismissOnOutside } from "./useDismissOnOutside";
import { type PendingConfirm, useExplorerInteractions } from "./useExplorerInteractions";

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

  useEffect(
    () =>
      container.events.on("focusExplorer", () => {
        if (!expanded) onToggle();
        setFocusToken((token) => token + 1);
      }),
    [expanded, onToggle],
  );

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
      actions={folderActions(ui.actions)}
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
          focusToken={focusToken}
          onToggleExpand={(path) => void container.explorer.toggleExpand(path)}
          onSelect={(path) => void container.explorer.select(path)}
          onOpenFile={(path) => void container.workspace.openPath(path)}
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

function folderActions(actions: ExplorerMenuActions): PaneAction[] {
  return [
    {
      label: "New File...",
      icon: <NewFileIcon />,
      onRun: () => {
        actions.newFile(null);
      },
    },
    {
      label: "New Folder...",
      icon: <NewFolderIcon />,
      onRun: () => {
        actions.newFolder(null);
      },
    },
    {
      label: "Refresh Explorer",
      icon: <RefreshIcon />,
      onRun: () => {
        container.run("explorer.refresh");
      },
    },
    {
      label: "Collapse Folders in Explorer",
      icon: <CollapseAllIcon />,
      onRun: () => {
        container.run("explorer.collapseAll");
      },
    },
  ];
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
        title="Delete"
        message={`Are you sure you want to delete '${node.name}'? You can restore it from the Recycle Bin.`}
        confirmLabel="Move to Recycle Bin"
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
      title="Move"
      message={`Are you sure you want to move '${node.name}' into '${confirm.destName}'?`}
      confirmLabel="Move"
      tone="primary"
      onCancel={onDone}
      onConfirm={() => {
        void container.explorer.moveEntry(node.parentPath, node.path, confirm.destDir);
        onDone();
      }}
    />
  );
}
