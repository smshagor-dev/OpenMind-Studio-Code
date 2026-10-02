import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExplorerNode, ExplorerSnapshot } from "../services/explorerService";
import { withDraft } from "../services/explorerTree";

const harness = vi.hoisted((): { current: unknown } => ({ current: null }));
vi.mock("../services/container", () => ({
  get container() {
    return harness.current;
  },
}));

import { FileTree, type FileTreeProps } from "./FileTree";
import { useExplorerInteractions } from "./useExplorerInteractions";

const ROOT = "C:/My Work";
const SRC = `${ROOT}/src`;

function node(path: string, name: string, isDir = false, parentPath = ROOT): ExplorerNode {
  return { path, name, parentPath, isDir, isSymlink: false };
}

const snapshot: ExplorerSnapshot = {
  rootPath: ROOT,
  rootName: "My Work",
  nodesByPath: new Map([
    [SRC, node(SRC, "src", true)],
    [`${SRC}/a.ts`, node(`${SRC}/a.ts`, "a.ts", false, SRC)],
    [`${ROOT}/README.md`, node(`${ROOT}/README.md`, "README.md")],
  ]),
  childrenByPath: new Map([
    [ROOT, [SRC, `${ROOT}/README.md`]],
    [SRC, [`${SRC}/a.ts`]],
  ]),
  expandedPaths: new Set([SRC]),
  selectedPath: null,
};

function setup() {
  const explorer = {
    prepareCreate: vi.fn().mockResolvedValue(undefined),
    createNamed: vi.fn((dir: string, name: string) => Promise.resolve(`${dir}/${name}`)),
    createFile: vi.fn(),
    createFolder: vi.fn(),
    revealPath: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(null),
  };
  const workspace = { openPath: vi.fn().mockResolvedValue("doc-1") };
  harness.current = { explorer, workspace };
  const hook = renderHook(() => useExplorerInteractions(snapshot));
  return { explorer, workspace, hook };
}

afterEach(() => {
  harness.current = null;
});

describe("Explorer: New File asks for the name first (VS Code)", () => {
  it("creates nothing until the name is given, then creates that name and opens it", async () => {
    const { explorer, workspace, hook } = setup();
    await act(async () => {
      await hook.result.current.startCreate("file", null);
    });
    expect(hook.result.current.pendingCreate).toEqual({ parentDir: ROOT, kind: "file" });
    expect(explorer.prepareCreate).toHaveBeenCalledWith(ROOT);
    // No "Untitled" file is made on disk.
    expect(explorer.createFile).not.toHaveBeenCalled();
    expect(explorer.createNamed).not.toHaveBeenCalled();
    act(() => {
      hook.result.current.commitCreate("main.f90");
    });
    expect(hook.result.current.pendingCreate).toBeNull();
    await waitFor(() => {
      expect(workspace.openPath).toHaveBeenCalledWith(`${ROOT}/main.f90`);
    });
    expect(explorer.createNamed).toHaveBeenCalledWith(ROOT, "main.f90", "file");
    expect(explorer.revealPath).toHaveBeenCalledWith(`${ROOT}/main.f90`);
  });

  it("Escape or an empty name creates nothing", async () => {
    const { explorer, hook } = setup();
    await act(async () => {
      await hook.result.current.startCreate("file", null);
    });
    act(() => {
      hook.result.current.cancelCreate();
    });
    expect(hook.result.current.pendingCreate).toBeNull();
    await act(async () => {
      await hook.result.current.startCreate("file", null);
    });
    act(() => {
      hook.result.current.commitCreate("");
    });
    // A late commit after the box closed does nothing either.
    act(() => {
      hook.result.current.commitCreate("late.txt");
    });
    expect(explorer.createNamed).not.toHaveBeenCalled();
  });

  it("creates inside the chosen folder, and a new folder is not opened as a file", async () => {
    const { explorer, workspace, hook } = setup();
    await act(async () => {
      await hook.result.current.startCreate("folder", node(SRC, "src", true));
    });
    expect(hook.result.current.pendingCreate).toEqual({ parentDir: SRC, kind: "folder" });
    act(() => {
      hook.result.current.commitCreate("lib");
    });
    await waitFor(() => {
      expect(explorer.revealPath).toHaveBeenCalledWith(`${SRC}/lib`);
    });
    expect(explorer.createNamed).toHaveBeenCalledWith(SRC, "lib", "folder");
    expect(workspace.openPath).not.toHaveBeenCalled();
  });

  it("doesn't open anything when the name was refused", async () => {
    const { explorer, workspace, hook } = setup();
    explorer.createNamed.mockResolvedValueOnce(null as unknown as string);
    await act(async () => {
      await hook.result.current.startCreate("file", null);
    });
    act(() => {
      hook.result.current.commitCreate("README.md");
    });
    await waitFor(() => {
      expect(explorer.createNamed).toHaveBeenCalledTimes(1);
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(workspace.openPath).not.toHaveBeenCalled();
  });
});

describe("the name box in the tree", () => {
  const rows = [
    { path: SRC, depth: 0 },
    { path: `${SRC}/a.ts`, depth: 1 },
    { path: `${ROOT}/README.md`, depth: 0 },
  ];

  it("goes first in the folder it is created in", () => {
    expect(withDraft(rows, ROOT, null).map((r) => r.path)).toEqual([SRC, `${SRC}/a.ts`, `${ROOT}/README.md`]);
    expect(withDraft(rows, ROOT, { parentDir: ROOT, kind: "file" })[0]).toEqual({ path: null, depth: 0, draft: "file" });
    const inSrc = withDraft(rows, ROOT, { parentDir: SRC, kind: "folder" });
    expect(inSrc[1]).toEqual({ path: null, depth: 1, draft: "folder" });
    expect(inSrc[2]?.path).toBe(`${SRC}/a.ts`);
  });

  function tree(props: Partial<FileTreeProps>) {
    const all: FileTreeProps = {
      snapshot,
      dirtyPaths: new Set(),
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
      ...props,
    };
    return render(<FileTree {...all} />);
  }

  it("is an empty, focused box: Enter gives the typed name, Escape cancels", () => {
    const commit = vi.fn();
    const cancel = vi.fn();
    tree({ creating: { parentDir: SRC, kind: "file" }, onCommitCreate: commit, onCancelCreate: cancel });
    const box = screen.getByRole("treeitem", { name: "New file name" }).querySelector("input") as HTMLInputElement;
    expect(box.value).toBe("");
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: "util.ts" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(commit).toHaveBeenCalledWith("util.ts");
    fireEvent.keyDown(box, { key: "Escape" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
