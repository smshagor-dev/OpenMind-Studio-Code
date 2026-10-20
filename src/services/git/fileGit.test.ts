import { describe, expect, it, vi } from "vitest";

import type { GitBlameLine } from "../ipc";
import type { FileCommit, FileGitIpc, FileLogPage, RemoteInfo } from "./fileGitIpc";
import { CancelledError, FileGitRemote, relativeTo, remoteOfBranch } from "./fileGitRemote";
import { FileGitService, type FileGitHost, type GitTarget } from "./fileGitService";
import { GitViewsService } from "./gitViewsService";

const PATH = "C:\\work\\repo\\src\\a.ts";
const TARGET: GitTarget = { path: PATH, line: 2, endLine: 3 };
const H1 = "1".repeat(40);
const H2 = "2".repeat(40);
const H3 = "3".repeat(40);

function commit(hash: string, path: string, subject: string): FileCommit {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    parents: [],
    author: "Ada",
    email: "ada@x.io",
    authorTime: 1_700_000_000,
    committer: "Ada",
    commitTime: 1_700_000_000,
    subject,
    path,
    additions: 1,
    deletions: 0,
  };
}

function blameLine(line: number, hash: string, committed = true): GitBlameLine {
  return {
    line,
    originalLine: line + 10,
    hash,
    shortHash: hash.slice(0, 7),
    author: "Ada",
    time: 1_700_000_000,
    summary: "change it",
    content: `line ${String(line)}`,
    committed,
  };
}

/** A repository where src/a.ts was docs/a.ts before commit H2 renamed it. */
function fakeIpc(overrides: Partial<FileGitIpc> = {}): FileGitIpc {
  const history = [commit(H3, "src/a.ts", "third"), commit(H2, "src/a.ts", "rename"), commit(H1, "docs/a.ts", "first")];
  const texts: Record<string, string | null> = {
    [`HEAD:src/a.ts`]: "head\n",
    [`${H3}:src/a.ts`]: "head\n",
    [`${H3}^:src/a.ts`]: "before third\n",
    [`${H2}:src/a.ts`]: "renamed\n",
    [`${H2}^:docs/a.ts`]: "first\n",
    [`${H1}:docs/a.ts`]: "first\n",
  };
  return {
    context: vi.fn(() => Promise.resolve({ root: "C:/work/repo", name: "repo", relative: "src/a.ts", tracked: true })),
    log: vi.fn((_path: string, skip: number, limit: number) =>
      Promise.resolve({ commits: history.slice(skip, skip + limit), more: skip + limit < history.length }),
    ),
    fileAt: vi.fn((_path: string, revision: string, relative?: string | null) =>
      Promise.resolve({ text: texts[`${revision}:${relative ?? "src/a.ts"}`] ?? null }),
    ),
    refs: vi.fn(() =>
      Promise.resolve([
        { name: "main", kind: "branch" as const, hash: H3, time: 1 },
        { name: "origin/main", kind: "remote" as const, hash: H2, time: 1 },
        { name: "v1", kind: "tag" as const, hash: H1, time: 1 },
      ]),
    ),
    remotes: vi.fn(() =>
      Promise.resolve<RemoteInfo>({
        remotes: [{ name: "origin", url: "git@github.com:owner/repo.git" }],
        branch: "main",
        upstream: "origin/main",
        head: H3,
      }),
    ),
    published: vi.fn((_path: string, hash: string) => Promise.resolve(hash === H3 ? ["origin/main"] : [])),
    resolve: vi.fn(() => Promise.resolve(null)),
    commit: vi.fn((_path: string, hash: string) =>
      Promise.resolve({
        hash,
        parents: [],
        author: "Ada",
        authorEmail: "ada@x.io",
        authorTime: 1,
        committer: "Ada",
        committerEmail: "ada@x.io",
        commitTime: 1,
        message: "subject\n\nbody",
        files: [],
      }),
    ),
    blame: vi.fn(() => Promise.resolve([blameLine(1, H1), blameLine(2, H2), blameLine(3, "0".repeat(40), false)])),
    ...overrides,
  };
}

function setup(options: { ipc?: FileGitIpc; buffer?: string | null; picks?: (number | null)[] } = {}) {
  const ipc = options.ipc ?? fakeIpc();
  const views = new GitViewsService(ipc);
  const picks = [...(options.picks ?? [])];
  const host: FileGitHost = {
    ipc,
    views,
    bufferText: () => (options.buffer === undefined ? "head\n" : options.buffer),
    pick: vi.fn(() => Promise.resolve(picks.length > 0 ? (picks.shift() ?? null) : null)),
    copy: vi.fn(() => Promise.resolve()),
    openUrl: vi.fn(() => Promise.resolve()),
    openRevision: vi.fn(),
    notice: vi.fn(),
    t: (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key),
  };
  const git = new FileGitService(host);
  const remote = new FileGitRemote(host, git, () => "C:\\work\\repo");
  return { ipc, views, host, git, remote };
}

describe("FileGitService", () => {
  it("opens a line's last commit against its parent, following the rename back", async () => {
    const { views, git } = setup();
    await git.lineChangesWithPrevious(TARGET);
    const compare = views.getState().compare;
    expect(compare?.original).toBe("first\n");
    expect(compare?.modified).toBe("renamed\n");
    expect(compare?.revealLine).toBe(12);
    expect(compare?.leftLabel).toBe("2222222^");
  });

  it("an uncommitted line opens the working file against HEAD", async () => {
    const { views, git } = setup({ buffer: "edited\n" });
    await git.lineChangesWithPrevious({ ...TARGET, line: 3 });
    expect(views.getState().compare).toMatchObject({ leftLabel: "HEAD", original: "head\n", modified: "edited\n" });
  });

  it("with no unsaved or uncommitted edits, Open Changes shows the last commit against the one before", async () => {
    const { views, git } = setup();
    await git.changesWithPrevious(TARGET);
    expect(views.getState().compare).toMatchObject({ original: "before third\n", modified: "head\n" });
  });

  it("a line's commit against the working buffer includes unsaved edits", async () => {
    const { views, git } = setup({ buffer: "unsaved\n" });
    await git.lineChangesWithWorking(TARGET);
    expect(views.getState().compare).toMatchObject({ original: "renamed\n", modified: "unsaved\n", revealLine: 2 });
  });

  it("a branch or tag without the file is compared as absent, with a notice", async () => {
    const { views, host, git } = setup({ picks: [2] });
    await git.changesWithBranchOrTag(TARGET);
    expect(views.getState().compare?.original).toBeNull();
    expect(host.notice).toHaveBeenCalledWith(expect.stringContaining("gitFile.notInRevision"));
  });

  it("quick history opens a picked commit at its revision in a read-only tab", async () => {
    const { host, git } = setup({ picks: [2, 2] });
    await git.quickOpenHistory(TARGET);
    expect(host.openRevision).toHaveBeenCalledWith(PATH, H1, "docs/a.ts", "first\n");
  });

  it("a dismissed picker does nothing", async () => {
    const { views, git } = setup({ picks: [null] });
    await git.changesWithRevision(TARGET);
    expect(views.getState().compare).toBeNull();
  });

  it("reuses blame for a moment and forgets it on invalidate", async () => {
    const { ipc, git } = setup();
    await git.lineCommit(TARGET);
    await git.lineCommit(TARGET);
    expect(ipc.blame).toHaveBeenCalledTimes(1);
    git.invalidate(PATH);
    await git.lineCommit(TARGET);
    expect(ipc.blame).toHaveBeenCalledTimes(2);
  });

  it("finds the commit before one, also across pages", async () => {
    const { git } = setup();
    const previous = await git.previousOf(PATH, commit(H2, "src/a.ts", "rename"));
    expect(previous?.hash).toBe(H1);
    expect(await git.previousOf(PATH, commit(H1, "docs/a.ts", "first"))).toBeNull();
  });

  it("an untracked file without HEAD text can't be compared", async () => {
    const ipc = fakeIpc({
      context: () => Promise.resolve({ root: "r", name: "r", relative: "new.ts", tracked: false }),
      fileAt: () => Promise.resolve({ text: null }),
    });
    const { git } = setup({ ipc });
    await expect(git.changesWithPrevious(TARGET)).rejects.toThrow("gitFile.notCommitted");
  });
});

describe("FileGitRemote", () => {
  it("opens the file at the pushed commit with the selected lines", async () => {
    const { host, remote } = setup();
    await remote.fileOnRemote(TARGET, "open");
    expect(host.openUrl).toHaveBeenCalledWith(`https://github.com/owner/repo/blob/${H3}/src/a.ts#L2-L3`);
  });

  it("leaves out line numbers when the editor's text differs from the commit", async () => {
    const { host, remote } = setup({ buffer: "changed\n" });
    await remote.fileOnRemote(TARGET, "copy");
    expect(host.copy).toHaveBeenCalledWith(`https://github.com/owner/repo/blob/${H3}/src/a.ts`);
  });

  it("refuses a commit that isn't pushed to the remote", async () => {
    const ipc = fakeIpc({ published: () => Promise.resolve([]) });
    const { remote } = setup({ ipc });
    await expect(remote.fileOnRemote(TARGET, "open")).rejects.toThrow("gitFile.notPublished");
  });

  it("refuses a repository without a remote, or one on an unknown host", async () => {
    const none = fakeIpc({ remotes: () => Promise.resolve({ remotes: [], branch: "main", upstream: null, head: H3 }) });
    await expect(setup({ ipc: none }).remote.fileOnRemote(TARGET, "open")).rejects.toThrow("gitFile.noRemote");
    const other = fakeIpc({
      remotes: () =>
        Promise.resolve({ remotes: [{ name: "origin", url: "https://git.example.com/o/r.git" }], branch: "main", upstream: null, head: H3 }),
    });
    await expect(setup({ ipc: other }).remote.fileOnRemote(TARGET, "open")).rejects.toThrow("gitFile.unsupportedRemote");
  });

  it("asks which remote to use when there are several and no upstream or origin", async () => {
    const ipc = fakeIpc({
      remotes: () =>
        Promise.resolve({
          remotes: [
            { name: "a", url: "git@github.com:a/r.git" },
            { name: "b", url: "git@gitlab.com:b/r.git" },
          ],
          branch: "main",
          upstream: null,
          head: H3,
        }),
      published: () => Promise.resolve(["b/main"]),
    });
    const { host, remote } = setup({ ipc, picks: [1] });
    await remote.fileOnRemote(TARGET, "open");
    expect(host.openUrl).toHaveBeenCalledWith(`https://gitlab.com/b/r/-/blob/${H3}/src/a.ts#L2-3`);
    const cancelled = setup({ ipc, picks: [null] });
    await expect(cancelled.remote.fileOnRemote(TARGET, "open")).rejects.toBeInstanceOf(CancelledError);
  });

  it("opens the file on a picked remote branch by the branch's name", async () => {
    const ipc = fakeIpc({ fileAt: () => Promise.resolve({ text: "x\n" }) });
    const { host, remote } = setup({ ipc, picks: [0], buffer: "y\n" });
    await remote.fileOnRemoteFrom(TARGET, "open");
    expect(host.openUrl).toHaveBeenCalledWith("https://github.com/owner/repo/blob/main/src/a.ts");
  });

  it("opens the commit of the line, and refuses an uncommitted line", async () => {
    const ipc = fakeIpc({ published: () => Promise.resolve(["origin/main"]) });
    const { host, remote } = setup({ ipc });
    await remote.commitOnRemote(TARGET, "open");
    expect(host.openUrl).toHaveBeenCalledWith(`https://github.com/owner/repo/commit/${H2}`);
    await expect(remote.commitOnRemote({ ...TARGET, line: 3 }, "open")).rejects.toThrow("gitFile.lineUncommitted");
  });

  it("copies a vscode.dev link for GitHub only", async () => {
    const { host, remote } = setup();
    await remote.copyVscodeDevLink(TARGET);
    expect(host.copy).toHaveBeenCalledWith(`https://vscode.dev/github/owner/repo/blob/${H3}/src/a.ts#L2`);
    const gitlab = fakeIpc({
      remotes: () =>
        Promise.resolve({ remotes: [{ name: "origin", url: "git@gitlab.com:g/r.git" }], branch: "main", upstream: "origin/main", head: H3 }),
    });
    await expect(setup({ ipc: gitlab }).remote.copyVscodeDevLink(TARGET)).rejects.toThrow("gitFile.noVscodeDev");
  });

  it("copies the relative path, a file link, the SHA and the message", async () => {
    const { host, remote } = setup();
    await remote.copyRelativePath(TARGET);
    expect(host.copy).toHaveBeenLastCalledWith("src\\a.ts");
    await remote.copyFileLink(TARGET);
    expect(host.copy).toHaveBeenLastCalledWith("file:///C:/work/repo/src/a.ts#L2");
    await remote.copySha(TARGET);
    expect(host.copy).toHaveBeenLastCalledWith(H2);
    await remote.copyMessage(TARGET);
    expect(host.copy).toHaveBeenLastCalledWith("subject\n\nbody");
  });
});

describe("path helpers", () => {
  it("makes paths relative in their own separator style and refuses outside ones", () => {
    expect(relativeTo("C:\\work\\repo", "c:\\Work\\Repo\\src\\a b.ts")).toBe("src\\a b.ts");
    expect(relativeTo("/home/me/p", "/home/me/p/src/a.ts")).toBe("src/a.ts");
    expect(relativeTo("/home/me/p", "/home/me/pp/a.ts")).toBeNull();
    expect(relativeTo("/home/me/p", "/home/me/P/a.ts")).toBeNull();
  });

  it("finds a branch's remote by the longest matching name", () => {
    const remotes = [
      { name: "origin", url: "" },
      { name: "origin/fork", url: "" },
    ];
    expect(remoteOfBranch(remotes, "origin/fork/main")?.name).toBe("origin/fork");
    expect(remoteOfBranch(remotes, "origin/main")?.name).toBe("origin");
    expect(remoteOfBranch(remotes, "upstream/main")).toBeNull();
  });
});

describe("GitViewsService", () => {
  it("loads history page by page and drops an answer for a closed view", async () => {
    const { ipc, views } = setup();
    await views.openHistory(PATH, "graph");
    expect(views.getState().history?.commits).toHaveLength(3);
    expect(views.getState().history?.mode).toBe("graph");
    let release: (value: FileLogPage) => void = () => undefined;
    ipc.log = vi.fn(
      () =>
        new Promise<FileLogPage>((resolve) => {
          release = resolve;
        }),
    );
    views.closeHistory();
    const slow = new GitViewsService(ipc);
    const opening = slow.openHistory(PATH, "list");
    slow.closeHistory();
    release({ commits: [commit(H1, "a", "x")], more: false });
    await opening;
    expect(slow.getState().history).toBeNull();
  });

  it("shows a commit and keeps only the newest answer", async () => {
    const { views } = setup();
    const first = views.showCommit(PATH, H1, true, 2);
    const second = views.showCommit(PATH, H2, false, null);
    await Promise.all([first, second]);
    expect(views.getState().commit?.details?.hash).toBe(H2);
    expect(views.getState().commit?.compact).toBe(false);
    views.closeAll();
    expect(views.getState()).toEqual({ compare: null, history: null, commit: null });
  });
});
