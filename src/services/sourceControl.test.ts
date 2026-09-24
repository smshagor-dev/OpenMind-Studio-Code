import { describe, expect, it, vi } from "vitest";

import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import { GIT_CHANNEL, GitService } from "./gitService";
import type { GitFileChange, GitLogEntry, GitRepoStatus, GitSnapshot } from "./ipc";
import { OutputService } from "./outputService";
import {
  SourceControlService,
  badgeFor,
  commitAvailability,
  groupChanges,
  joinRepoPath,
} from "./sourceControlService";
import { createFakeIpc } from "../testUtils/fakeIpcClient";

function change(path: string, patch: Partial<GitFileChange> = {}): GitFileChange {
  return {
    path,
    origPath: null,
    index: "unmodified",
    worktree: "unmodified",
    conflicted: false,
    ...patch,
  };
}

function repo(changes: GitFileChange[], patch: Partial<GitRepoStatus> = {}): GitSnapshot {
  return {
    state: "repository",
    root: "C:/My Projects/site",
    name: "site",
    git: "OpenMind portable Git",
    status: {
      branch: "main",
      detached: false,
      oid: "abc",
      upstream: null,
      ahead: 0,
      behind: 0,
      changes,
      ...patch,
    },
  };
}

const MIXED = [
  change("edited.txt", { worktree: "modified" }),
  change("staged.txt", { index: "modified" }),
  change("both.txt", { index: "added", worktree: "modified" }),
  change("new.txt", { worktree: "untracked" }),
];

async function setup(snapshot: GitSnapshot, overrides: Parameters<typeof createFakeIpc>[0] = {}) {
  const ipc = createFakeIpc({ gitSnapshot: vi.fn().mockResolvedValue(snapshot), ...overrides });
  const output = new OutputService();
  const git = new GitService(ipc, output, () => new Date(2026, 0, 1, 10, 0, 0));
  const events = new EventBus<AppEvents>();
  const openFile = vi.fn().mockResolvedValue(null);
  const installGit = vi.fn();
  const sc = new SourceControlService(git, events, openFile, installGit);
  await sc.initialize();
  return { sc, ipc, output, git, events, openFile, installGit };
}

describe("pure helpers", () => {
  it("groups a file staged and modified into both Staged and Changes, untracked apart", () => {
    const status = (repo(MIXED) as { status: GitRepoStatus }).status;
    const groups = groupChanges(status);
    expect(groups.staged.map((c) => c.path)).toEqual(["staged.txt", "both.txt"]);
    expect(groups.changes.map((c) => c.path)).toEqual(["edited.txt", "both.txt"]);
    expect(groups.untracked.map((c) => c.path)).toEqual(["new.txt"]);
  });

  it("a conflicted file is only under Changes, badged as a conflict", () => {
    const conflict = change("c.txt", { index: "unmerged", worktree: "unmerged", conflicted: true });
    const groups = groupChanges({
      branch: "main",
      detached: false,
      oid: "a",
      upstream: null,
      ahead: 0,
      behind: 0,
      changes: [conflict],
    });
    expect(groups.staged).toEqual([]);
    expect(groups.changes).toHaveLength(1);
    expect(badgeFor(conflict, false)).toEqual({ letter: "U", title: "Merge conflict" });
  });

  it("badges use the side they are shown on", () => {
    const both = change("b.txt", { index: "added", worktree: "modified" });
    expect(badgeFor(both, true)).toEqual({ letter: "A", title: "Added" });
    expect(badgeFor(both, false)).toEqual({ letter: "M", title: "Modified" });
    expect(badgeFor(change("x", { worktree: "deleted" }), false).letter).toBe("D");
  });

  it("commit needs a message, staged changes and an identity, in that order", () => {
    const base = {
      message: "msg",
      stagedCount: 1,
      busy: false,
      identityMissing: false,
      conflicts: false,
    };
    expect(commitAvailability(base)).toEqual({ enabled: true });
    expect(commitAvailability({ ...base, message: "   " }).reason).toBe("Enter a commit message.");
    expect(commitAvailability({ ...base, stagedCount: 0 }).reason).toBe(
      "There are no staged changes to commit.",
    );
    expect(commitAvailability({ ...base, identityMissing: true }).reason).toContain(
      "name and email",
    );
    expect(commitAvailability({ ...base, conflicts: true }).reason).toContain("conflicts");
    expect(commitAvailability({ ...base, busy: true }).reason).toContain("busy");
  });

  it("joins a repo path in the root's own slash style, keeping spaces", () => {
    expect(joinRepoPath("C:/My Projects/site", "src/a b.txt")).toBe(
      "C:\\My Projects\\site\\src\\a b.txt",
    );
    expect(joinRepoPath("C:\\My Projects\\site\\", "a.txt")).toBe("C:\\My Projects\\site\\a.txt");
    expect(joinRepoPath("/home/me/site", "src/a.txt")).toBe("/home/me/site/src/a.txt");
  });
});

describe("view states", () => {
  it("no folder open", async () => {
    const { sc } = await setup({ state: "noWorkspace" });
    expect(sc.viewKind()).toBe("noFolder");
    expect(sc.branchLabel()).toBeNull();
  });

  it("Git runtime missing: the reason, and installing opens the Runtime Manager", async () => {
    const { sc, installGit } = await setup({
      state: "gitMissing",
      reason: "Git runtime is not installed yet.",
      systemGit: "C:\\Program Files\\Git\\cmd\\git.exe",
    });
    expect(sc.viewKind()).toBe("gitMissing");
    sc.installGitRuntime();
    expect(installGit).toHaveBeenCalled();
  });

  it("system Git is only used after the user allows it", async () => {
    const { sc, ipc } = await setup({
      state: "gitMissing",
      reason: "Git runtime is not installed yet.",
      systemGit: "C:\\git.exe",
    });
    expect(ipc.gitSetAllowSystem).not.toHaveBeenCalled();
    await sc.useSystemGit();
    expect(ipc.gitSetAllowSystem).toHaveBeenCalledWith(true);
    expect(sc.getState().allowSystem).toBe(true);
  });

  it("not a repository: Initialize Repository runs git init and refreshes", async () => {
    const snapshot = vi
      .fn()
      .mockResolvedValueOnce({ state: "notRepository", git: "OpenMind portable Git" })
      .mockResolvedValue(repo([]));
    const { sc, ipc } = await setup({ state: "noWorkspace" }, { gitSnapshot: snapshot });
    expect(sc.viewKind()).toBe("notRepository");
    expect(await sc.initRepository()).toBe(true);
    expect(ipc.gitInit).toHaveBeenCalled();
    expect(sc.viewKind()).toBe("repository");
  });

  it("repository: branch, dirty count, sync label and groups", async () => {
    const { sc } = await setup(repo(MIXED, { upstream: "origin/main", ahead: 2, behind: 1 }));
    expect(sc.viewKind()).toBe("repository");
    expect(sc.branchLabel()).toBe("main");
    expect(sc.changeCount()).toBe(4);
    expect(sc.syncLabel()).toBe("2↑ 1↓");
    expect(sc.groups().staged).toHaveLength(2);
  });

  it("a detached HEAD says so", async () => {
    const { sc } = await setup(repo([], { branch: null, detached: true }));
    expect(sc.branchLabel()).toBe("(detached HEAD)");
  });
});

describe("actions", () => {
  it("stage, unstage, stage all and unstage all call the backend and refresh", async () => {
    const { sc, ipc } = await setup(repo(MIXED));
    await sc.stage(["edited.txt"]);
    expect(ipc.gitStage).toHaveBeenCalledWith(["edited.txt"]);
    await sc.unstage(["staged.txt"]);
    expect(ipc.gitUnstage).toHaveBeenCalledWith(["staged.txt"]);
    await sc.stageAll();
    expect(ipc.gitStageAll).toHaveBeenCalled();
    await sc.unstageAll();
    expect(ipc.gitUnstageAll).toHaveBeenCalled();
    expect(ipc.gitSnapshot).toHaveBeenCalledTimes(5);
  });

  it("bulk actions are disabled with a reason when there is nothing to do", async () => {
    const { sc } = await setup(repo([]));
    expect(sc.stageAllState().reason).toBe("There are no changes to stage.");
    expect(sc.unstageAllState().reason).toBe("There are no staged changes.");
    expect(sc.discardAllState().reason).toBe("There are no changes to discard.");
  });

  it("discard asks first: nothing runs until confirmed, and Cancel runs nothing", async () => {
    const { sc, ipc } = await setup(repo(MIXED));
    sc.requestDiscard(["edited.txt"]);
    expect(sc.getState().pending?.message).toContain("edited.txt");
    expect(ipc.gitDiscard).not.toHaveBeenCalled();
    sc.cancelPending();
    expect(sc.getState().pending).toBeNull();
    expect(ipc.gitDiscard).not.toHaveBeenCalled();

    sc.requestDiscard(["edited.txt"]);
    await sc.confirm();
    expect(ipc.gitDiscard).toHaveBeenCalledWith(["edited.txt"], true);
    expect(sc.getState().pending).toBeNull();
  });

  it("discard all and deleting an untracked file need confirmation too", async () => {
    const { sc, ipc } = await setup(repo(MIXED));
    sc.requestDiscardAll();
    expect(ipc.gitDiscardAll).not.toHaveBeenCalled();
    await sc.confirm();
    expect(ipc.gitDiscardAll).toHaveBeenCalledWith(true);

    sc.requestDeleteUntracked("new.txt");
    expect(ipc.gitDeleteUntracked).not.toHaveBeenCalled();
    await sc.confirm();
    expect(ipc.gitDeleteUntracked).toHaveBeenCalledWith("new.txt", true);
  });

  it("deleting a branch needs confirmation", async () => {
    const { sc, ipc } = await setup(repo([]));
    sc.requestDeleteBranch("old");
    expect(ipc.gitDeleteBranch).not.toHaveBeenCalled();
    await sc.confirm();
    expect(ipc.gitDeleteBranch).toHaveBeenCalledWith("old", true);
  });

  it("commit: disabled without message or staged changes, then commits, clears the message and refreshes", async () => {
    const { sc, ipc } = await setup(repo(MIXED));
    sc.setMessage("");
    expect(sc.commitState().reason).toBe("Enter a commit message.");
    expect(await sc.commit()).toBe(false);
    expect(ipc.gitCommit).not.toHaveBeenCalled();

    const none = await setup(repo([change("edited.txt", { worktree: "modified" })]));
    none.sc.setMessage("msg");
    expect(none.sc.commitState().reason).toBe("There are no staged changes to commit.");

    sc.setMessage("fix: thing");
    expect(sc.commitState()).toEqual({ enabled: true });
    const before = vi.mocked(ipc.gitSnapshot).mock.calls.length;
    expect(await sc.commit()).toBe(true);
    expect(ipc.gitCommit).toHaveBeenCalledWith("fix: thing");
    expect(sc.getState().message).toBe("");
    expect(sc.getState().notice).toContain("abc1234");
    expect(vi.mocked(ipc.gitSnapshot).mock.calls.length).toBeGreaterThan(before);
  });

  it("a missing identity blocks commit and can be saved", async () => {
    const { sc, ipc } = await setup(repo(MIXED), {
      gitIdentity: vi.fn().mockResolvedValue({ name: null, email: null }),
    });
    sc.setMessage("msg");
    expect(sc.identityMissing()).toBe(true);
    expect(sc.commitState().reason).toContain("name and email");
    await sc.saveIdentity("Test", "t@example.com");
    expect(ipc.gitSetIdentity).toHaveBeenCalledWith("Test", "t@example.com");
  });

  it("a failing action shows Git's message, raises an error and leaves the state usable", async () => {
    const { sc, events } = await setup(repo(MIXED), {
      gitStage: vi.fn().mockRejectedValue("fatal: something failed"),
    });
    const errors: string[] = [];
    events.on("appError", (event) => errors.push(event.message));
    expect(await sc.stage(["edited.txt"])).toBe(false);
    expect(sc.getState().error).toBe("fatal: something failed");
    expect(errors).toEqual(["fatal: something failed"]);
    expect(sc.getState().busy).toBeNull();
  });

  it("opening a file uses the repository root and keeps spaces", async () => {
    const { sc, openFile } = await setup(repo(MIXED));
    await sc.openChangedFile("src/a b.txt");
    expect(openFile).toHaveBeenCalledWith("C:\\My Projects\\site\\src\\a b.txt");
  });

  it("remote actions explain what is missing", async () => {
    const noUpstream = await setup(repo([]));
    expect(noUpstream.sc.remoteState("fetch")).toEqual({ enabled: true });
    expect(noUpstream.sc.remoteState("pull").reason).toContain("no upstream");
    const fresh = await setup(repo([], { oid: null }));
    expect(fresh.sc.remoteState("fetch").reason).toContain("first commit");
    const linked = await setup(repo([], { upstream: "origin/main" }));
    expect(linked.sc.remoteState("push")).toEqual({ enabled: true });
    await linked.sc.push();
    expect(linked.ipc.gitPush).toHaveBeenCalled();
  });
});

describe("diff", () => {
  it("opens the working-tree and staged diff of a file and closes it", async () => {
    const { sc, ipc } = await setup(repo(MIXED));
    await sc.openDiff(MIXED[0] as GitFileChange, false);
    expect(ipc.gitDiff).toHaveBeenCalledWith("edited.txt", false);
    expect(sc.getState().diff).toMatchObject({ path: "edited.txt", staged: false, loading: false });
    expect(sc.getState().diff?.sides?.modified).toBe("b");
    await sc.openDiff(MIXED[1] as GitFileChange, true);
    expect(ipc.gitDiff).toHaveBeenLastCalledWith("staged.txt", true);
    sc.closeDiff();
    expect(sc.getState().diff).toBeNull();
  });

  it("an open staged diff closes when its file is unstaged, and a working-tree diff reloads after an edit", async () => {
    const staged = repo([change("a.txt", { index: "modified" })]);
    const unstaged = repo([change("a.txt", { worktree: "modified" })]);
    const snapshot = vi.fn().mockResolvedValueOnce(staged).mockResolvedValue(unstaged);
    const { sc, ipc } = await setup(staged, { gitSnapshot: snapshot });
    await sc.openDiff(change("a.txt", { index: "modified" }), true);
    expect(sc.getState().diff?.staged).toBe(true);
    await sc.unstage(["a.txt"]);
    expect(sc.getState().diff).toBeNull();

    await sc.openDiff(change("a.txt", { worktree: "modified" }), false);
    const calls = vi.mocked(ipc.gitDiff).mock.calls.length;
    await sc.stage(["b.txt"]);
    expect(sc.getState().diff?.staged).toBe(false);
    expect(vi.mocked(ipc.gitDiff).mock.calls.length).toBeGreaterThan(calls);
  });

  it("a diff error is shown in the diff, not thrown", async () => {
    const { sc } = await setup(repo(MIXED), {
      gitDiff: vi.fn().mockRejectedValue("File is too large to diff."),
    });
    await sc.openDiff(MIXED[0] as GitFileChange, false);
    expect(sc.getState().diff?.error).toBe("File is too large to diff.");
  });

  it("a binary file's sides say so", async () => {
    const { sc } = await setup(repo(MIXED), {
      gitDiff: vi
        .fn()
        .mockResolvedValue({ path: "a.bin", original: null, modified: null, binary: true }),
    });
    await sc.openDiff(MIXED[0] as GitFileChange, false);
    expect(sc.getState().diff?.sides?.binary).toBe(true);
  });
});

describe("Git output channel", () => {
  it("writes each backend command with its folder, output and exit code", async () => {
    const handlers: ((entry: GitLogEntry) => void)[] = [];
    const { output } = await setup(repo([]), {
      onGitLog: vi.fn().mockImplementation((handler: (entry: GitLogEntry) => void) => {
        handlers.push(handler);
        return Promise.resolve(() => undefined);
      }),
    });
    const git = new GitService(
      createFakeIpc({
        onGitLog: vi.fn().mockImplementation((handler: (entry: GitLogEntry) => void) => {
          handlers.push(handler);
          return Promise.resolve(() => undefined);
        }),
      }),
      output,
      () => new Date(2026, 0, 1, 10, 0, 0),
    );
    await git.initialize();
    handlers.at(-1)?.({
      label: "git add -- 1 path",
      cwd: "C:/My Projects/site",
      code: 0,
      stdout: "",
      stderr: "warning: LF will be replaced by CRLF",
    });
    expect(output.getLines(GIT_CHANNEL)).toEqual([
      "[10:00:00] git add -- 1 path",
      "cwd: C:/My Projects/site",
      "warning: LF will be replaced by CRLF",
      "exit code: 0",
    ]);
  });
});
