import { beforeEach, expect, it, vi } from "vitest";
import type { GitSnapshot } from "../ipc";
const state = vi.hoisted(() => ({ snapshot: null as GitSnapshot | null }));
const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  documentSave: vi.fn(),
  diff: vi.fn(),
  choose: vi.fn(),
  enable: vi.fn(),
  show: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: mocks.save }));
const host = {
  workspace: { ensureWorkspace: vi.fn() },
  sourceControl: { refresh: vi.fn(), getState: () => state },
  ipc: { documentSave: mocks.documentSave, gitDiff: mocks.diff },
  layout: { showView: mocks.show },
  extensions: {
    registry: {
      ensureLoaded: vi.fn(),
      all: () => [
        { id: "test.plugin", enabled: true, manifest: { version: "1" } },
      ],
      find: (id: string) => (id === "test.plugin" ? {} : undefined),
    },
    service: {
      chooseVsix: mocks.choose,
      setEnabled: mocks.enable,
      getState: () => ({ error: null }),
    },
  },
};
import {
  agentGitChanges,
  agentPlugins,
  exportAgentChat,
} from "./agentNativeActions";
beforeEach(() => {
  vi.clearAllMocks();
});
it("reports staged and unstaged file sides from the existing Git service", async () => {
  state.snapshot = {
    state: "repository",
    root: "C:/p",
    name: "p",
    git: "git",
    status: {
      branch: "main",
      detached: false,
      oid: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      changes: [
        {
          path: "a.ts",
          origPath: null,
          index: "modified",
          worktree: "modified",
          conflicted: false,
        },
      ],
    },
  };
  mocks.diff.mockResolvedValue({
    original: "before",
    modified: "after",
    binary: false,
  });
  const result = await agentGitChanges(host);
  expect(mocks.diff).toHaveBeenCalledWith("a.ts", true);
  expect(mocks.diff).toHaveBeenCalledWith("a.ts", false);
  expect(result).toContain("staged");
  expect(result).toContain("working tree");
  expect(result).toContain("before");
});
it("opens plugin inspection and toggles known extensions", async () => {
  await agentPlugins(host, "install");
  expect(mocks.choose).toHaveBeenCalledOnce();
  expect(mocks.show).toHaveBeenCalledWith("extensions");
  await agentPlugins(host, "disable test.plugin");
  expect(mocks.enable).toHaveBeenCalledWith("test.plugin", false);
  await expect(agentPlugins(host, "disable missing")).rejects.toThrow(
    "exact ID",
  );
});
it("writes export to the chosen path and preserves cancellation", async () => {
  mocks.save.mockResolvedValueOnce(null);
  expect(await exportAgentChat(host, "text")).toBeNull();
  expect(mocks.documentSave).not.toHaveBeenCalled();
  mocks.save.mockResolvedValueOnce("C:/chat.md");
  expect(await exportAgentChat(host, "# Chat")).toBe("C:/chat.md");
  expect(mocks.documentSave).toHaveBeenCalledWith(
    "C:/chat.md",
    "# Chat",
    "utf8",
  );
});
