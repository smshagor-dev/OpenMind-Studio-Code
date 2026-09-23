import type { ExplorerNode, ExplorerSnapshot } from "../services/explorerService";
import { iconColorForFile } from "./fileIcons";
import { ChevronIcon, FileIcon, FolderIcon } from "./icons";
import { InlineNameInput } from "./InlineNameInput";

export interface FileTreeProps {
  snapshot: ExplorerSnapshot;
  dirtyPaths: Set<string>;
  activeDocPath: string | null;
  editingPath: string | null;
  editingInitialValue: string;
  onToggleExpand: (path: string) => void;
  onSelectFile: (path: string) => void;
  onContextMenu: (event: React.MouseEvent, node: ExplorerNode) => void;
  onCommitEdit: (node: ExplorerNode, newName: string) => void;
  onCancelEdit: () => void;
}

export function FileTree(props: FileTreeProps) {
  const { snapshot } = props;
  if (!snapshot.rootPath) {
    return null;
  }
  const rootChildren = snapshot.childrenByPath.get(snapshot.rootPath) ?? [];

  return (
    <div className="file-tree" role="tree">
      {rootChildren.map((path) => (
        <FileTreeRow key={path} path={path} depth={0} {...props} />
      ))}
    </div>
  );
}

function FileTreeRow({
  path,
  depth,
  snapshot,
  dirtyPaths,
  activeDocPath,
  editingPath,
  editingInitialValue,
  onToggleExpand,
  onSelectFile,
  onContextMenu,
  onCommitEdit,
  onCancelEdit,
}: FileTreeProps & { path: string; depth: number }) {
  const node = snapshot.nodesByPath.get(path);
  if (!node) {
    return null;
  }

  const isExpanded = snapshot.expandedPaths.has(path);
  const isEditing = editingPath === path;
  const isSelected = snapshot.selectedPath === path;
  const isActive = activeDocPath === path;
  const isDirty = dirtyPaths.has(path);

  const rowClass = [
    "file-tree__row",
    isSelected ? "file-tree__row--selected" : "",
    isActive ? "file-tree__row--active" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <div
        className={rowClass}
        style={{ paddingLeft: `${depth * 16 + 4}px` }}
        role="treeitem"
        aria-selected={isSelected}
        aria-expanded={node.isDir ? isExpanded : undefined}
        onClick={() => {
          if (node.isDir) {
            onToggleExpand(path);
          } else {
            onSelectFile(path);
          }
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          onContextMenu(event, node);
        }}
      >
        {node.isDir ? (
          <ChevronIcon expanded={isExpanded} />
        ) : (
          <span className="file-tree__spacer" aria-hidden="true" />
        )}
        {node.isDir ? (
          <FolderIcon open={isExpanded} />
        ) : (
          <FileIcon color={iconColorForFile(node.name)} />
        )}
        {isEditing ? (
          <InlineNameInput
            initialValue={editingInitialValue}
            onCommit={(value) => {
              onCommitEdit(node, value);
            }}
            onCancel={onCancelEdit}
          />
        ) : (
          <span className="file-tree__name">
            {node.name}
            {isDirty ? (
              <span className="file-tree__dirty-dot" aria-label="unsaved changes">
                &#9679;
              </span>
            ) : null}
          </span>
        )}
      </div>
      {node.isDir && isExpanded
        ? (snapshot.childrenByPath.get(path) ?? []).map((childPath) => (
            <FileTreeRow
              key={childPath}
              path={childPath}
              depth={depth + 1}
              snapshot={snapshot}
              dirtyPaths={dirtyPaths}
              activeDocPath={activeDocPath}
              editingPath={editingPath}
              editingInitialValue={editingInitialValue}
              onToggleExpand={onToggleExpand}
              onSelectFile={onSelectFile}
              onContextMenu={onContextMenu}
              onCommitEdit={onCommitEdit}
              onCancelEdit={onCancelEdit}
            />
          ))
        : null}
    </>
  );
}
