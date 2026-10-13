import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ExplorerNode, ExplorerSnapshot } from "../services/explorerService";
import { FileTree, type FileTreeProps } from "./FileTree";

// The collaboration dots read the app's live services; these tests are about the component alone.
vi.mock("./collab/CollabDots", () => ({ CollabDots: () => null }));

function node(path: string, parentPath: string, isDir: boolean): ExplorerNode {
  return { path, name: path.split("/").pop() ?? path, isDir, isSymlink: false, parentPath };
}

function snapshot(overrides: Partial<ExplorerSnapshot> = {}): ExplorerSnapshot {
  const nodes = [
    node("/r/src", "/r", true),
    node("/r/src/a.ts", "/r/src", false),
    node("/r/README.md", "/r", false),
  ];
  return {
    rootPath: "/r",
    rootName: "r",
    nodesByPath: new Map(nodes.map((n) => [n.path, n])),
    childrenByPath: new Map([
      ["/r", ["/r/src", "/r/README.md"]],
      ["/r/src", ["/r/src/a.ts"]],
    ]),
    expandedPaths: new Set<string>(),
    selectedPath: null,
    ...overrides,
  };
}

function renderTree(props: Partial<FileTreeProps> = {}) {
  const handlers = {
    onToggleExpand: vi.fn(),
    onSelect: vi.fn(),
    onOpenFile: vi.fn(),
    onContextMenu: vi.fn(),
    onCommitEdit: vi.fn(),
    onCancelEdit: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    onMove: vi.fn(),
  };
  render(
    <FileTree
      snapshot={snapshot()}
      dirtyPaths={new Set()}
      activeDocPath={null}
      editingPath={null}
      editingInitialValue=""
      focusToken={0}
      {...handlers}
      {...props}
    />,
  );
  return { ...handlers, ...props, tree: screen.getByRole("tree") };
}

describe("FileTree", () => {
  it("renders only visible rows, with the folder collapsed", () => {
    renderTree();

    expect(screen.getByText("src")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
    expect(screen.queryByText("a.ts")).not.toBeInTheDocument();
  });

  it("clicking a folder toggles it; clicking a file opens it", () => {
    const { onToggleExpand, onOpenFile } = renderTree();

    fireEvent.click(screen.getByText("src"));
    fireEvent.click(screen.getByText("README.md"));

    expect(onToggleExpand).toHaveBeenCalledWith("/r/src");
    expect(onOpenFile).toHaveBeenCalledWith("/r/README.md");
  });

  it("ArrowDown moves the selection to the next visible row", () => {
    const { tree, onSelect } = renderTree({ snapshot: snapshot({ selectedPath: "/r/src" }) });

    fireEvent.keyDown(tree, { key: "ArrowDown" });

    expect(onSelect).toHaveBeenCalledWith("/r/README.md");
  });

  it("ArrowRight expands a collapsed folder, then steps into its first child", () => {
    const collapsed = renderTree({ snapshot: snapshot({ selectedPath: "/r/src" }) });
    fireEvent.keyDown(collapsed.tree, { key: "ArrowRight" });
    expect(collapsed.onToggleExpand).toHaveBeenCalledWith("/r/src");
  });

  it("ArrowLeft on a nested file selects its parent folder", () => {
    const { tree, onSelect } = renderTree({
      snapshot: snapshot({ selectedPath: "/r/src/a.ts", expandedPaths: new Set(["/r/src"]) }),
    });

    fireEvent.keyDown(tree, { key: "ArrowLeft" });

    expect(onSelect).toHaveBeenCalledWith("/r/src");
  });

  it("Enter opens the selected file, F2 renames it, Delete deletes it", () => {
    const { tree, onOpenFile, onRename, onDelete } = renderTree({
      snapshot: snapshot({ selectedPath: "/r/README.md" }),
    });

    fireEvent.keyDown(tree, { key: "Enter" });
    fireEvent.keyDown(tree, { key: "F2" });
    fireEvent.keyDown(tree, { key: "Delete" });

    expect(onOpenFile).toHaveBeenCalledWith("/r/README.md");
    expect(onRename).toHaveBeenCalledWith(expect.objectContaining({ path: "/r/README.md" }));
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ path: "/r/README.md" }));
  });

  it("renders indent guides for nested rows", () => {
    renderTree({ snapshot: snapshot({ expandedPaths: new Set(["/r/src"]) }) });

    const nestedRow = screen.getByText("a.ts").closest("[role=treeitem]");
    expect(nestedRow?.querySelectorAll(".tree-row__guide")).toHaveLength(1);
    expect(nestedRow).toHaveAttribute("aria-level", "2");
  });

  it("marks the active editor's file even when the editor spells its path differently", () => {
    renderTree({ activeDocPath: "\\r\\README.md" });

    expect(screen.getByText("README.md").closest("[role=treeitem]")).toHaveClass(
      "tree-row--active",
    );
    expect(screen.getByText("src").closest("[role=treeitem]")).not.toHaveClass("tree-row--active");
  });

  it("scrolls the selected row into view on every reveal, also when the selection didn't change", () => {
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    const props = (revealSeq: number) => ({
      snapshot: snapshot({ selectedPath: "/r/README.md", revealSeq }),
      dirtyPaths: new Set<string>(),
      activeDocPath: null,
      editingPath: null,
      editingInitialValue: "",
      focusToken: 0,
      onToggleExpand: vi.fn(),
      onSelect: vi.fn(),
      onOpenFile: vi.fn(),
      onContextMenu: vi.fn(),
      onCommitEdit: vi.fn(),
      onCancelEdit: vi.fn(),
      onRename: vi.fn(),
      onDelete: vi.fn(),
      onMove: vi.fn(),
    });
    const { rerender } = render(<FileTree {...props(1)} />);
    expect(scroll).toHaveBeenCalledTimes(1);

    rerender(<FileTree {...props(1)} />); // an unrelated re-render: no scroll
    expect(scroll).toHaveBeenCalledTimes(1);

    rerender(<FileTree {...props(2)} />); // the same file revealed again
    expect(scroll).toHaveBeenCalledTimes(2);
    expect(scroll.mock.instances[1]).toBe(screen.getByText("README.md").closest("[data-path]"));
    scroll.mockRestore();
  });
});
