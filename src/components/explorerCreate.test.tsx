import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExplorerNode, ExplorerSnapshot } from "../services/explorerService";
import { withDraft } from "../services/explorerTree";

const harness = vi.hoisted((): { current: unknown } => ({ current: null }));
vi.mock("../services/container", async () => {
  const collab = (await import("../testUtils/collabStub")).collabStub();
  return {
    get container() {
      return { collab, ...(harness.current ?? {}) };
    },
  };
});

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
    beginCreate: vi.fn().mockResolvedValue(undefined),
    commitCreate: vi.fn().mockResolvedValue(null),
    cancelCreate: vi.fn(),
    rename: vi.fn().mockResolvedValue(null),
  };
  harness.current = { explorer };
  const hook = renderHook(() => useExplorerInteractions(snapshot));
  return { explorer, hook };
}

afterEach(() => {
  harness.current = null;
});

describe("Explorer: New File asks for the name first (VS Code)", () => {
  it("the name box, its commit and its cancel all belong to the Explorer service (one source of truth)", async () => {
    const { explorer, hook } = setup();
    await act(async () => {
      await hook.result.current.startCreate("folder", node(SRC, "src", true));
    });
    expect(explorer.beginCreate).toHaveBeenCalledWith("folder", node(SRC, "src", true));
    act(() => {
      hook.result.current.commitCreate("lib");
    });
    expect(explorer.commitCreate).toHaveBeenCalledWith("lib");
    act(() => {
      hook.result.current.cancelCreate();
    });
    expect(explorer.cancelCreate).toHaveBeenCalledTimes(1);
  });

  it("shows the box the service holds", () => {
    harness.current = { explorer: {} };
    const pending = renderHook(() =>
      useExplorerInteractions({ ...snapshot, pendingCreate: { parentDir: ROOT, kind: "file" } }),
    );
    expect(pending.result.current.pendingCreate).toEqual({ parentDir: ROOT, kind: "file" });
    const none = renderHook(() => useExplorerInteractions(snapshot));
    expect(none.result.current.pendingCreate).toBeNull();
  });
});

describe("the name box in the tree", () => {
  const rows = [
    { path: SRC, depth: 0 },
    { path: `${SRC}/a.ts`, depth: 1 },
    { path: `${ROOT}/README.md`, depth: 0 },
  ];

  it("goes first in the folder it is created in", () => {
    expect(withDraft(rows, ROOT, null).map((r) => r.path)).toEqual([
      SRC,
      `${SRC}/a.ts`,
      `${ROOT}/README.md`,
    ]);
    expect(withDraft(rows, ROOT, { parentDir: ROOT, kind: "file" })[0]).toEqual({
      path: null,
      depth: 0,
      draft: "file",
    });
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
    tree({
      creating: { parentDir: SRC, kind: "file" },
      onCommitCreate: commit,
      onCancelCreate: cancel,
    });
    const box = screen
      .getByRole("treeitem", { name: "New file name" })
      .querySelector("input") as HTMLInputElement;
    expect(box.value).toBe("");
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: "util.ts" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(commit).toHaveBeenCalledWith("util.ts");
    fireEvent.keyDown(box, { key: "Escape" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("says why a name can't be used, keeps the box open on Enter, and cancels when left", () => {
    const commit = vi.fn();
    const cancel = vi.fn();
    tree({
      creating: { parentDir: ROOT, kind: "file" },
      onCommitCreate: commit,
      onCancelCreate: cancel,
      createProblem: (name) => (name.includes("?") ? 'The name "a?.py" contains "?".' : null),
    });
    const box = screen
      .getByRole("treeitem", { name: "New file name" })
      .querySelector("input") as HTMLInputElement;
    fireEvent.change(box, { target: { value: "a?.py" } });
    expect(screen.getByRole("alert").textContent).toContain('contains "?"');
    expect(box.getAttribute("aria-invalid")).toBe("true");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(commit).not.toHaveBeenCalled();
    fireEvent.blur(box);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
  });
});
