import { CollabDots } from "./collab/CollabDots";
import { useEffect, useRef, useState } from "react";

import type { ExplorerNode, ExplorerSnapshot } from "../services/explorerService";
import { visibleTreeRows, withDraft } from "../services/explorerTree";
import { FileTypeIcon, FolderTypeIcon } from "./fileIcons";
import { ChevronIcon } from "./icons";
import { InlineNameInput } from "./InlineNameInput";

/** VS Code's defaults: `workbench.tree.indent` = 8px, rows 22px, 8px left gutter. */
const INDENT = 8;
const GUTTER = 8;
const DRAG_MIME = "application/x-openmind-path";

export interface FileTreeProps {
  snapshot: ExplorerSnapshot;
  dirtyPaths: Set<string>;
  activeDocPath: string | null;
  editingPath: string | null;
  editingInitialValue: string;
  /** A new file/folder being named: a name box is drawn at the top of `parentDir`'s contents. */
  creating?: { parentDir: string; kind: "file" | "folder" } | null;
  onCommitCreate?: (name: string) => void;
  onCancelCreate?: () => void;
  /** Why a new entry's typed name can't be used, or `null`. */
  createProblem?: (name: string) => string | null;
  /** Why `path` can't be renamed to `name`, or `null`. */
  renameProblem?: (path: string, name: string) => string | null;
  /** Bumped by the parent to move keyboard focus into the tree (e.g. Ctrl+Shift+E). */
  focusToken: number;
  onToggleExpand: (path: string) => void;
  onSelect: (path: string) => void;
  /** Single click: opens the file (as a provisional preview tab when previews are enabled). */
  onOpenFile: (path: string) => void;
  /** Double-click / Enter: opens the file and keeps its tab. Falls back to `onOpenFile`. */
  onKeepFileOpen?: (path: string) => void;
  /** `node` is null for a right-click on empty space below the rows. */
  onContextMenu: (event: React.MouseEvent, node: ExplorerNode | null) => void;
  onCommitEdit: (node: ExplorerNode, newName: string) => void;
  onCancelEdit: () => void;
  onRename: (node: ExplorerNode) => void;
  onDelete: (node: ExplorerNode) => void;
  /** Drag-and-drop: move `source` into directory `destDir`. */
  onMove: (source: string, destDir: string) => void;
}

export function FileTree(props: FileTreeProps) {
  const { snapshot, focusToken } = props;
  const treeRef = useRef<HTMLDivElement | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  useEffect(() => {
    if (focusToken > 0) treeRef.current?.focus();
  }, [focusToken]);

  // Keep the selected row visible after keyboard navigation / reveal.
  useEffect(() => {
    const selected = snapshot.selectedPath;
    if (!selected || !treeRef.current) return;
    for (const row of treeRef.current.querySelectorAll<HTMLElement>("[data-path]")) {
      if (row.dataset.path === selected) {
        row.scrollIntoView({ block: "nearest" });
        break;
      }
    }
  }, [snapshot.selectedPath]);

  if (!snapshot.rootPath) {
    return null;
  }
  const rootPath = snapshot.rootPath;
  const rows = visibleTreeRows(snapshot);

  return (
    <div
      ref={treeRef}
      className={dropTarget === rootPath ? "file-tree file-tree--drop-target" : "file-tree"}
      role="tree"
      aria-label="Files Explorer"
      tabIndex={0}
      onKeyDown={(event) => {
        handleTreeKey(event, props);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        props.onContextMenu(event, null);
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(DRAG_MIME)) return;
        event.preventDefault();
        setDropTarget(rootPath);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDropTarget(null);
      }}
      onDrop={(event) => {
        event.preventDefault();
        const source = event.dataTransfer.getData(DRAG_MIME);
        const target = dropTarget ?? rootPath;
        setDropTarget(null);
        if (source) props.onMove(source, target);
      }}
    >
      {withDraft(rows, rootPath, props.creating ?? null).map((row) =>
        row.draft ? (
          <DraftRow key="__new__" depth={row.depth} kind={row.draft} {...props} />
        ) : (
          <TreeRow
            key={row.path}
            path={row.path}
            depth={row.depth}
            dropTarget={dropTarget}
            setDropTarget={setDropTarget}
            {...props}
          />
        ),
      )}
    </div>
  );
}

/** The name box of a new file or folder (VS Code): Enter creates it, Escape or an empty name creates nothing. */
function DraftRow(props: FileTreeProps & { depth: number; kind: "file" | "folder" }) {
  const { depth, kind } = props;
  return (
    <div
      className="tree-row tree-row--selected tree-row--draft"
      style={{ paddingLeft: `${GUTTER + depth * INDENT}px` }}
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={true}
      aria-label={kind === "file" ? "New file name" : "New folder name"}
    >
      {Array.from({ length: depth }, (_, level) => (
        <span
          key={level}
          className="tree-row__guide"
          style={{ left: `${GUTTER + level * INDENT + INDENT}px` }}
          aria-hidden="true"
        />
      ))}
      <span className="tree-row__twistie">
        {kind === "folder" ? <ChevronIcon expanded={false} /> : null}
      </span>
      {kind === "folder" ? <FolderTypeIcon name="" open={false} /> : <FileTypeIcon name="" />}
      <InlineNameInput
        initialValue=""
        onCommit={(value) => {
          props.onCommitCreate?.(value);
        }}
        onCancel={() => {
          props.onCancelCreate?.();
        }}
        validate={props.createProblem}
      />
    </div>
  );
}

/** VS Code list keyboard model: arrows move selection, Right/Left expand/collapse or step in/out, Enter opens, F2 renames, Delete deletes. */
function handleTreeKey(event: React.KeyboardEvent, props: FileTreeProps): void {
  if (event.target !== event.currentTarget) return; // e.g. typing in the inline rename input
  const { snapshot } = props;
  const rows = visibleTreeRows(snapshot);
  if (rows.length === 0) return;
  const index = rows.findIndex((row) => row.path === snapshot.selectedPath);
  const node = snapshot.selectedPath ? snapshot.nodesByPath.get(snapshot.selectedPath) : undefined;
  const selectAt = (i: number) => {
    const row = rows[Math.max(0, Math.min(rows.length - 1, i))];
    if (row) props.onSelect(row.path);
  };

  switch (event.key) {
    case "ArrowDown":
      selectAt(index < 0 ? 0 : index + 1);
      break;
    case "ArrowUp":
      selectAt(index < 0 ? 0 : index - 1);
      break;
    case "Home":
      selectAt(0);
      break;
    case "End":
      selectAt(rows.length - 1);
      break;
    case "ArrowRight":
      if (node?.isDir) {
        if (!snapshot.expandedPaths.has(node.path)) props.onToggleExpand(node.path);
        else if (rows[index + 1]?.depth === (rows[index]?.depth ?? 0) + 1) selectAt(index + 1);
      }
      break;
    case "ArrowLeft":
      if (node?.isDir && snapshot.expandedPaths.has(node.path)) props.onToggleExpand(node.path);
      else if (node && node.parentPath !== snapshot.rootPath) props.onSelect(node.parentPath);
      break;
    case "Enter":
    case " ":
      if (node?.isDir) props.onToggleExpand(node.path);
      else if (node) (props.onKeepFileOpen ?? props.onOpenFile)(node.path);
      break;
    case "F2":
      if (node) props.onRename(node);
      break;
    case "Delete":
      if (node) props.onDelete(node);
      break;
    default:
      return;
  }
  event.preventDefault();
}

interface TreeRowProps extends FileTreeProps {
  path: string;
  depth: number;
  dropTarget: string | null;
  setDropTarget: (path: string | null) => void;
}

function TreeRow(props: TreeRowProps) {
  const { path, depth, snapshot, dropTarget } = props;
  const node = snapshot.nodesByPath.get(path);
  if (!node) {
    return null;
  }
  const isExpanded = snapshot.expandedPaths.has(path);
  const isSelected = snapshot.selectedPath === path;
  const targetDir = node.isDir ? node.path : node.parentPath;
  const inDropTarget =
    dropTarget !== null && (path === dropTarget || node.parentPath === dropTarget);

  const rowClass = [
    "tree-row",
    isSelected ? "tree-row--selected" : "",
    props.activeDocPath === path ? "tree-row--active" : "",
    inDropTarget ? "tree-row--drop-target" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={rowClass}
      data-path={path}
      style={{ paddingLeft: `${GUTTER + depth * INDENT}px` }}
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={isSelected}
      aria-expanded={node.isDir ? isExpanded : undefined}
      title={node.path}
      draggable={props.editingPath !== path}
      onMouseDown={(event) => {
        if (event.button === 0) props.onSelect(path);
      }}
      onClick={() => {
        if (node.isDir) props.onToggleExpand(path);
        else props.onOpenFile(path);
      }}
      onDoubleClick={() => {
        if (!node.isDir) (props.onKeepFileOpen ?? props.onOpenFile)(path);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        props.onSelect(path);
        props.onContextMenu(event, node);
      }}
      {...rowDragHandlers(props, targetDir)}
    >
      {Array.from({ length: depth }, (_, level) => (
        <span
          key={level}
          className="tree-row__guide"
          style={{ left: `${GUTTER + level * INDENT + INDENT}px` }}
          aria-hidden="true"
        />
      ))}
      <span className="tree-row__twistie">
        {node.isDir ? <ChevronIcon expanded={isExpanded} /> : null}
      </span>
      {node.isDir ? (
        <FolderTypeIcon name={node.name} open={isExpanded} />
      ) : (
        <FileTypeIcon name={node.name} />
      )}
      <TreeRowLabel node={node} {...props} />
    </div>
  );
}

/** HTML5 drag-and-drop on a row: drag the row's path; dropping onto a file targets its folder. */
function rowDragHandlers(props: TreeRowProps, targetDir: string) {
  return {
    onDragStart: (event: React.DragEvent) => {
      event.dataTransfer.setData(DRAG_MIME, props.path);
      event.dataTransfer.effectAllowed = "move";
    },
    onDragOver: (event: React.DragEvent) => {
      if (!event.dataTransfer.types.includes(DRAG_MIME)) return;
      event.preventDefault();
      event.stopPropagation();
      props.setDropTarget(targetDir);
    },
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      props.setDropTarget(null);
      const source = event.dataTransfer.getData(DRAG_MIME);
      if (source) props.onMove(source, targetDir);
    },
    onDragEnd: () => {
      props.setDropTarget(null);
    },
  };
}

function TreeRowLabel(props: TreeRowProps & { node: ExplorerNode }) {
  const { node } = props;
  if (props.editingPath === node.path) {
    return (
      <InlineNameInput
        initialValue={props.editingInitialValue}
        onCommit={(value) => {
          props.onCommitEdit(node, value);
        }}
        onCancel={props.onCancelEdit}
        validate={(value) => props.renameProblem?.(node.path, value) ?? null}
      />
    );
  }
  return (
    <span
      className={node.isSymlink ? "tree-row__label tree-row__label--symlink" : "tree-row__label"}
    >
      {node.name}
      {props.dirtyPaths.has(node.path) ? (
        <span className="tree-row__dirty" aria-label="unsaved changes" />
      ) : null}
      <CollabDots
        path={node.path}
        folder={node.isDir && !props.snapshot.expandedPaths.has(node.path)}
      />
    </span>
  );
}
