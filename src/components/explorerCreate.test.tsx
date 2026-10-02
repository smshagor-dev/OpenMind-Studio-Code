import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExplorerNode, ExplorerSnapshot } from "../services/explorerService";

const harness = vi.hoisted((): { current: unknown } => ({ current: null }));
vi.mock("../services/container", () => ({
  get container() {
    return harness.current;
  },
}));

import { useExplorerInteractions } from "./useExplorerInteractions";

const ROOT = "C:/My Work";

const snapshot: ExplorerSnapshot = {
  rootPath: ROOT,
  rootName: "My Work",
  nodesByPath: new Map(),
  childrenByPath: new Map(),
  expandedPaths: new Set(),
  selectedPath: null,
};

function node(path: string, name: string): ExplorerNode {
  return { path, name, parentPath: ROOT } as unknown as ExplorerNode;
}

function setup() {
  const explorer = {
    createFile: vi.fn().mockResolvedValue(`${ROOT}/Untitled`),
    createFolder: vi.fn().mockResolvedValue(`${ROOT}/New Folder`),
    revealPath: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn((_dir: string, _path: string, name: string) => Promise.resolve(`${ROOT}/${name}`)),
  };
  const workspace = { openPath: vi.fn().mockResolvedValue("doc-1") };
  harness.current = { explorer, workspace };
  const hook = renderHook(() => useExplorerInteractions(snapshot));
  return { explorer, workspace, hook };
}

afterEach(() => {
  harness.current = null;
});

describe("Explorer: New File", () => {
  it("opens the new file in the editor once it is named (as VS Code does)", async () => {
    const { explorer, workspace, hook } = setup();
    act(() => {
      hook.result.current.actions.newFile(null);
    });
    await waitFor(() => {
      expect(hook.result.current.pendingEdit?.created).toBe("file");
    });
    act(() => {
      hook.result.current.commitEdit(node(`${ROOT}/Untitled`, "Untitled"), "main.f90");
    });
    await waitFor(() => {
      expect(workspace.openPath).toHaveBeenCalledWith(`${ROOT}/main.f90`);
    });
    expect(explorer.rename).toHaveBeenCalledWith(ROOT, `${ROOT}/Untitled`, "main.f90");
    expect(explorer.revealPath).toHaveBeenLastCalledWith(`${ROOT}/main.f90`);
  });

  it("opens it under its default name when the name is left as it is", async () => {
    const { explorer, workspace, hook } = setup();
    act(() => {
      hook.result.current.actions.newFile(null);
    });
    await waitFor(() => {
      expect(hook.result.current.pendingEdit).not.toBeNull();
    });
    act(() => {
      hook.result.current.commitEdit(node(`${ROOT}/Untitled`, "Untitled"), "Untitled");
    });
    await waitFor(() => {
      expect(workspace.openPath).toHaveBeenCalledWith(`${ROOT}/Untitled`);
    });
    expect(explorer.rename).not.toHaveBeenCalled();
  });

  it("doesn't open anything when the rename fails, for a new folder, or for an ordinary rename", async () => {
    const { explorer, workspace, hook } = setup();
    explorer.rename.mockResolvedValueOnce(null as unknown as string);
    act(() => {
      hook.result.current.actions.newFile(null);
    });
    await waitFor(() => {
      expect(hook.result.current.pendingEdit).not.toBeNull();
    });
    act(() => {
      hook.result.current.commitEdit(node(`${ROOT}/Untitled`, "Untitled"), "taken.txt");
    });
    await waitFor(() => {
      expect(explorer.rename).toHaveBeenCalledTimes(1);
    });

    act(() => {
      hook.result.current.actions.newFolder(null);
    });
    await waitFor(() => {
      expect(hook.result.current.pendingEdit?.created).toBe("folder");
    });
    act(() => {
      hook.result.current.commitEdit(node(`${ROOT}/New Folder`, "New Folder"), "src");
    });

    const existing = node(`${ROOT}/a.txt`, "a.txt");
    act(() => {
      hook.result.current.actions.rename(existing);
    });
    act(() => {
      hook.result.current.commitEdit(existing, "b.txt");
    });
    await waitFor(() => {
      expect(explorer.rename).toHaveBeenCalledTimes(3);
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(workspace.openPath).not.toHaveBeenCalled();
  });
});
