import { describe, expect, it, vi } from "vitest";

import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import {
  GitBlameService,
  blameAvailability,
  formatBlameTime,
  relativeToRoot,
} from "./gitBlameService";
import { GitCloneService, cloneAvailability, deriveFolderName } from "./gitCloneService";
import { GitHistoryService, commitFileWord, formatCommitDate } from "./gitHistoryService";
import { GitService } from "./gitService";
import { GitStashService, stashTitle } from "./gitStashService";
import type { GitRepoStatus, GitRuntime, GitStash } from "./ipc";
import { OutputService } from "./outputService";
import { createFakeIpc } from "../testUtils/fakeIpcClient";

const READY: GitRuntime = {
  ready: true,
  label: "OpenMind portable Git",
  reason: null,
  systemGit: null,
};
const MISSING: GitRuntime = {
  ready: false,
  label: null,
  reason: "Git runtime is not installed yet.",
  systemGit: null,
};

function harness(overrides: Parameters<typeof createFakeIpc>[0] = {}) {
  const ipc = createFakeIpc(overrides);
  const output = new OutputService();
  const git = new GitService(ipc, output);
  const events = new EventBus<AppEvents>();
  const errors: string[] = [];
  events.on("appError", (event) => errors.push(event.message));
  return { ipc, output, git, events, errors };
}

describe("clone", () => {
  it("derives the folder name from the address", () => {
    expect(deriveFolderName("https://host/owner/repo.git")).toBe("repo");
    expect(deriveFolderName("git@host:team/proj.git/")).toBe("proj");
    expect(deriveFolderName("C:\\repos\\my repo")).toBe("my repo");
    expect(deriveFolderName("")).toBe("");
    expect(deriveFolderName("https://host/..")).toBe("");
  });

  it("Clone needs Git, an address, a destination and a name — each with its reason", () => {
    const base = { runtime: READY, url: "u", parent: "C:/p", name: "n", busy: false };
    expect(cloneAvailability(base)).toEqual({ enabled: true });
    expect(cloneAvailability({ ...base, runtime: MISSING }).reason).toBe(
      "Git runtime is not installed yet.",
    );
    expect(cloneAvailability({ ...base, runtime: null }).enabled).toBe(false);
    expect(cloneAvailability({ ...base, url: " " }).reason).toContain("address");
    expect(cloneAvailability({ ...base, parent: null }).reason).toBe(
      "Choose a destination folder.",
    );
    expect(cloneAvailability({ ...base, name: "" }).reason).toContain("folder name");
    expect(cloneAvailability({ ...base, busy: true }).reason).toContain("already running");
  });

  it("clones into <folder>/<name>, offers to open it, and only opens it when asked", async () => {
    const { git, events, ipc } = harness({
      openFolderDialog: vi.fn().mockResolvedValue("C:/My Clones"),
      gitClone: vi.fn().mockResolvedValue("C:/My Clones/repo"),
    });
    const openFolder = vi.fn().mockResolvedValue(null);
    const clone = new GitCloneService(git, events, openFolder, () => READY);

    expect(clone.cloneState().reason).toContain("address");
    clone.setUrl("https://host/owner/repo.git");
    expect(clone.name()).toBe("repo");
    expect(clone.cloneState().reason).toBe("Choose a destination folder.");
    await clone.chooseFolder();
    expect(clone.cloneState()).toEqual({ enabled: true });

    expect(await clone.clone()).toBe(true);
    expect(ipc.gitClone).toHaveBeenCalledWith(
      "https://host/owner/repo.git",
      "C:/My Clones",
      "repo",
    );
    expect(clone.getState().cloned).toBe("C:/My Clones/repo");
    expect(openFolder).not.toHaveBeenCalled();

    await clone.openCloned();
    expect(openFolder).toHaveBeenCalledWith("C:/My Clones/repo");
    expect(clone.getState().cloned).toBeNull();
  });

  it("a destination that is not empty is refused and shown; nothing is offered to open", async () => {
    const message =
      'The folder "repo" already exists and is not empty. Nothing is overwritten — choose another folder or name.';
    const { git, events, errors } = harness({
      openFolderDialog: vi.fn().mockResolvedValue("C:/p"),
      gitClone: vi.fn().mockRejectedValue(message),
    });
    const openFolder = vi.fn();
    const clone = new GitCloneService(git, events, openFolder, () => READY);
    clone.setUrl("https://host/repo.git");
    await clone.chooseFolder();
    expect(await clone.clone()).toBe(false);
    expect(clone.getState().error).toBe(message);
    expect(clone.getState().cloned).toBeNull();
    expect(errors).toEqual([message]);
    expect(await clone.openCloned()).toBe(false);
    expect(openFolder).not.toHaveBeenCalled();
  });

  it("an authentication failure shows the credential message and stores nothing", async () => {
    const auth = "Authentication is required. Credential storage is not implemented yet.";
    const { git, events } = harness({
      openFolderDialog: vi.fn().mockResolvedValue("C:/p"),
      gitClone: vi.fn().mockRejectedValue(auth),
    });
    const clone = new GitCloneService(git, events, vi.fn(), () => READY);
    clone.setUrl("https://private/repo.git");
    await clone.chooseFolder();
    await clone.clone();
    expect(clone.getState().error).toBe(auth);
  });

  it("the entry button is disabled with a reason while Git is missing", () => {
    const { git, events } = harness();
    const clone = new GitCloneService(git, events, vi.fn(), () => MISSING);
    expect(clone.entryState()).toEqual({
      enabled: false,
      reason: "Git runtime is not installed yet.",
    });
    expect(new GitCloneService(git, events, vi.fn(), () => READY).entryState().enabled).toBe(true);
  });

  it("a cancelled folder dialog changes nothing", async () => {
    const { git, events } = harness({ openFolderDialog: vi.fn().mockResolvedValue(null) });
    const clone = new GitCloneService(git, events, vi.fn(), () => READY);
    expect(await clone.chooseFolder()).toBe(false);
    expect(clone.getState().parent).toBeNull();
  });
});

describe("history", () => {
  const commit = (n: number) => ({
    hash: String(n).repeat(40),
    shortHash: String(n).repeat(7),
    author: "Ada",
    date: "2026-01-02T03:04:05+00:00",
    subject: `commit ${String(n)}`,
  });

  it("loads the commits, selects one to list its files, and opens a file's diff", async () => {
    const files = [
      { path: "a.txt", origPath: null, status: "M" },
      { path: "new name.txt", origPath: "old name.txt", status: "R" },
    ];
    const { git, events, ipc } = harness({
      gitHistory: vi.fn().mockResolvedValue([commit(2), commit(1)]),
      gitCommitFiles: vi.fn().mockResolvedValue(files),
    });
    const showDiff = vi.fn().mockResolvedValue(undefined);
    const history = new GitHistoryService(git, events, showDiff);

    await history.load();
    expect(ipc.gitHistory).toHaveBeenCalledWith(100);
    expect(history.getState().commits.map((c) => c.subject)).toEqual(["commit 2", "commit 1"]);

    await history.select(commit(2).hash);
    expect(ipc.gitCommitFiles).toHaveBeenCalledWith(commit(2).hash);
    expect(history.getState().files).toEqual(files);
    expect(history.selectedCommit()?.subject).toBe("commit 2");

    await history.openFile(files[1] as never);
    expect(showDiff).toHaveBeenCalledWith(commit(2).hash, files[1]);

    await history.select(commit(2).hash);
    expect(history.getState().selected).toBeNull();
    expect(history.getState().files).toEqual([]);
  });

  it("a repository without commits is an empty, loaded list; errors are shown", async () => {
    const empty = harness({ gitHistory: vi.fn().mockResolvedValue([]) });
    const history = new GitHistoryService(empty.git, empty.events, vi.fn());
    await history.load();
    expect(history.getState()).toMatchObject({ commits: [], loaded: true, error: null });

    const failing = harness({ gitHistory: vi.fn().mockRejectedValue("fatal: bad object") });
    const broken = new GitHistoryService(failing.git, failing.events, vi.fn());
    await broken.load();
    expect(broken.getState().error).toBe("fatal: bad object");
  });

  it("reset forgets everything, and the small formatters behave", () => {
    const { git, events } = harness();
    const history = new GitHistoryService(git, events, vi.fn());
    history.reset();
    expect(history.getState().commits).toEqual([]);
    expect(commitFileWord("R")).toBe("Renamed");
    expect(commitFileWord("X")).toBe("X");
    expect(formatCommitDate("not a date")).toBe("");
    expect(formatCommitDate("2026-01-02T03:04:05+00:00")).not.toBe("");
  });
});

describe("stash", () => {
  const stashes: GitStash[] = [
    { index: 0, description: "On main: my work", message: "my work", branch: "main", date: "" },
    { index: 1, description: "WIP on main: abc1234 s", message: null, branch: "main", date: "" },
  ];

  function stashHarness(counts = { tracked: 1, untracked: 0 }, overrides = {}) {
    const h = harness({ gitStashList: vi.fn().mockResolvedValue(stashes), ...overrides });
    const changed = vi.fn().mockResolvedValue(undefined);
    const service = new GitStashService(h.git, h.events, changed, () => counts);
    return { ...h, service, changed };
  }

  it("Stash is disabled with a reason when there is nothing to stash", () => {
    expect(stashHarness({ tracked: 0, untracked: 0 }).service.stashState().reason).toBe(
      "There are no local changes to stash.",
    );
    const onlyNew = stashHarness({ tracked: 0, untracked: 2 }).service;
    expect(onlyNew.stashState().reason).toContain("Include untracked files");
    onlyNew.setIncludeUntracked(true);
    expect(onlyNew.stashState()).toEqual({ enabled: true });
    expect(stashHarness().service.stashState()).toEqual({ enabled: true });
  });

  it("stashes with a message, reloads the list and refreshes Source Control", async () => {
    const { service, ipc, changed } = stashHarness();
    service.setMessage("  my work ");
    expect(await service.stash()).toBe(true);
    expect(ipc.gitStashPush).toHaveBeenCalledWith("my work", false);
    expect(ipc.gitStashList).toHaveBeenCalled();
    expect(changed).toHaveBeenCalled();
    expect(service.getState().message).toBe("");
    expect(service.getState().stashes).toHaveLength(2);
  });

  it("lists stashes by message or Git's description, and Apply / Pop call the backend", async () => {
    const { service, ipc, changed } = stashHarness();
    await service.load();
    expect(service.getState().stashes.map(stashTitle)).toEqual([
      "my work",
      "WIP on main: abc1234 s",
    ]);
    await service.apply(1);
    expect(ipc.gitStashApply).toHaveBeenCalledWith(1);
    expect(service.getState().notice).toBe("Applied stash: WIP on main: abc1234 s (it is kept)");
    await service.pop(0);
    expect(service.getState().notice).toBe("Popped stash: my work");
    expect(ipc.gitStashPop).toHaveBeenCalledWith(0);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("Drop asks first: nothing is dropped until confirmed, and Cancel drops nothing", async () => {
    const { service, ipc } = stashHarness();
    service.requestDrop(stashes[0] as GitStash);
    expect(service.getState().pendingDrop).toEqual(stashes[0]);
    expect(ipc.gitStashDrop).not.toHaveBeenCalled();
    service.cancelDrop();
    expect(service.getState().pendingDrop).toBeNull();
    expect(await service.confirmDrop()).toBe(false);
    expect(ipc.gitStashDrop).not.toHaveBeenCalled();

    service.requestDrop(stashes[1] as GitStash);
    await service.confirmDrop();
    expect(ipc.gitStashDrop).toHaveBeenCalledWith(1, true);
    expect(service.getState().pendingDrop).toBeNull();
  });

  it("a conflict is shown as Git wrote it and the lists are still reloaded", async () => {
    const message =
      "error: Your local changes would be overwritten\nCONFLICT (content): Merge conflict in a.txt\nThe stash entry is kept in case you need it again.";
    const { service, errors, ipc, changed } = stashHarness(undefined, {
      gitStashPop: vi.fn().mockRejectedValue(message),
    });
    expect(await service.pop(0)).toBe(false);
    expect(service.getState().error).toBe(message);
    expect(errors).toEqual([message]);
    expect(ipc.gitStashList).toHaveBeenCalled();
    expect(changed).toHaveBeenCalled();
    expect(service.getState().busy).toBeNull();
  });

  it("only one stash action runs at a time", async () => {
    let release: () => void = () => undefined;
    const slow = new Promise<string>((resolve) => {
      release = () => {
        resolve("done");
      };
    });
    const { service } = stashHarness(undefined, { gitStashApply: vi.fn().mockReturnValue(slow) });
    const first = service.apply(0);
    expect(service.entryState().enabled).toBe(false);
    expect(await service.pop(0)).toBe(false);
    release();
    await first;
    expect(service.entryState().enabled).toBe(true);
  });
});

describe("blame", () => {
  const status = (changes: GitRepoStatus["changes"]): GitRepoStatus => ({
    branch: "main",
    detached: false,
    oid: "abc",
    upstream: null,
    ahead: 0,
    behind: 0,
    changes,
  });
  const repo = (changes: GitRepoStatus["changes"] = []) => ({
    root: "C:/My Projects/site",
    status: status(changes),
  });

  it("relative paths work in either slash style and refuse anything outside", () => {
    expect(relativeToRoot("C:/My Projects/site", "C:\\My Projects\\site\\src\\a b.txt")).toBe(
      "src/a b.txt",
    );
    expect(relativeToRoot("c:/my projects/site", "C:/My Projects/site/a.txt")).toBe("a.txt");
    for (const outside of [
      "C:/My Projects/other/a.txt",
      "C:/My Projects/site",
      "C:/My Projects/site2/a.txt",
      "C:/My Projects/site/../x",
      "D:/elsewhere/a.txt",
    ]) {
      expect(relativeToRoot("C:/My Projects/site", outside)).toBeNull();
    }
  });

  it("is disabled with a reason: no repository, no file, outside, untracked", () => {
    const active = "C:/My Projects/site/a.txt";
    expect(blameAvailability({ repo: null, activePath: active, busy: false }).reason).toContain(
      "repository",
    );
    expect(blameAvailability({ repo: repo(), activePath: null, busy: false }).reason).toContain(
      "Open a saved file",
    );
    expect(blameAvailability({ repo: repo(), activePath: "D:/x.txt", busy: false }).reason).toBe(
      "This file is outside the repository.",
    );
    const untracked = repo([
      {
        path: "a.txt",
        origPath: null,
        index: "unmodified",
        worktree: "untracked",
        conflicted: false,
      },
    ]);
    expect(blameAvailability({ repo: untracked, activePath: active, busy: false }).reason).toBe(
      "This file is untracked — it has no history to blame.",
    );
    expect(blameAvailability({ repo: repo(), activePath: active, busy: false })).toEqual({
      enabled: true,
    });
    expect(blameAvailability({ repo: repo(), activePath: active, busy: true }).enabled).toBe(false);
  });

  it("opens the blame of the active file and closes it; the file itself is never touched", async () => {
    const lines = [
      {
        line: 1,
        shortHash: "abc1234",
        author: "Ada",
        time: 1_700_000_000,
        summary: "first",
        content: "one",
        committed: true,
      },
    ];
    const { git, ipc } = harness({ gitBlame: vi.fn().mockResolvedValue(lines) });
    const blame = new GitBlameService(
      git,
      () => "C:\\My Projects\\site\\a.txt",
      () => repo(),
    );
    expect(blame.getView()).toBeNull();
    expect(await blame.open()).toBe(true);
    expect(ipc.gitBlame).toHaveBeenCalledWith("C:\\My Projects\\site\\a.txt");
    expect(blame.getView()?.lines).toEqual(lines);
    blame.close();
    expect(blame.getView()).toBeNull();
    expect(formatBlameTime(0)).toBe("");
    expect(formatBlameTime(1_700_000_000)).not.toBe("");
  });

  it("a file Git can't blame shows Git's reason in the panel", async () => {
    const { git } = harness({
      gitBlame: vi.fn().mockRejectedValue("Binary files can't be blamed."),
    });
    const blame = new GitBlameService(
      git,
      () => "C:/My Projects/site/a.bin",
      () => repo(),
    );
    expect(await blame.open()).toBe(false);
    expect(blame.getView()).toMatchObject({ error: "Binary files can't be blamed.", lines: [] });
  });

  it("does nothing when it is disabled", async () => {
    const { git, ipc } = harness();
    const blame = new GitBlameService(
      git,
      () => null,
      () => repo(),
    );
    expect(await blame.open()).toBe(false);
    expect(ipc.gitBlame).not.toHaveBeenCalled();
  });
});
