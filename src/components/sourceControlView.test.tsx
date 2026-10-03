import { ipcWorkspaceFeed } from "../testUtils/canonicalFeeds";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EventBus } from "../services/eventBus";
import type { AppEvents } from "../services/events";
import { GitBlameService } from "../services/gitBlameService";
import { GitCloneService } from "../services/gitCloneService";
import { GitHistoryService } from "../services/gitHistoryService";
import { GitService } from "../services/gitService";
import { GitStashService } from "../services/gitStashService";
import type { GitFileChange, GitSnapshot } from "../services/ipc";
import { OutputService } from "../services/outputService";
import { SourceControlService } from "../services/sourceControlService";
import { createFakeIpc } from "../testUtils/fakeIpcClient";

const harness = vi.hoisted((): { current: unknown } => ({ current: null }));

vi.mock("../services/container", () => ({
  get container() {
    return harness.current;
  },
}));
// Monaco doesn't run in jsdom; the diff host only receives the two texts.
vi.mock("../editor/MonacoDiffHost", () => ({
  MonacoDiffHost: (props: { original: string | null; modified: string | null }) => (
    <div data-testid="diff-host">{`${props.original ?? "∅"}|${props.modified ?? "∅"}`}</div>
  ),
}));

import { GitDiffViewer } from "./GitDiffViewer";
import { SourceControlView } from "./SourceControlView";

const READY = { ready: true, label: "OpenMind portable Git", reason: null, systemGit: null };

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

function repo(changes: GitFileChange[], patch: { git?: string } = {}): GitSnapshot {
  return {
    state: "repository",
    root: "C:/My Projects/site",
    name: "site",
    git: patch.git ?? "OpenMind portable Git",
    status: {
      branch: "main",
      detached: false,
      oid: "abc",
      upstream: null,
      ahead: 0,
      behind: 0,
      changes,
    },
  };
}

const CHANGES = [
  change("edited.txt", { worktree: "modified" }),
  change("staged.txt", { index: "modified" }),
  change("new file.txt", { worktree: "untracked" }),
];

let activePath: string | null = null;

async function setup(snapshot: GitSnapshot, overrides: Parameters<typeof createFakeIpc>[0] = {}) {
  activePath = null;
  const ipc = createFakeIpc({ gitSnapshot: vi.fn().mockResolvedValue(snapshot), ...overrides });
  const output = new OutputService();
  const git = new GitService(ipc, output);
  const events = new EventBus<AppEvents>();
  const sourceControl = new SourceControlService(git, events, vi.fn(), vi.fn());
  const gitFeed = ipcWorkspaceFeed(() => ipc.gitSnapshot());
  sourceControl.useCanonical(gitFeed);
  await gitFeed.refresh(); // the backend's first read of the folder
  await sourceControl.initialize();
  const run = vi.fn();
  const gitClone = new GitCloneService(git, events, vi.fn(), () => sourceControl.runtime());
  const gitHistory = new GitHistoryService(git, events, (hash, file) =>
    sourceControl.openCommitDiff(hash, file),
  );
  const gitStash = new GitStashService(
    git,
    events,
    () => sourceControl.refresh(),
    () => {
      const changes = sourceControl.status()?.changes ?? [];
      const untracked = changes.filter((change) => change.worktree === "untracked").length;
      return { tracked: changes.length - untracked, untracked };
    },
  );
  const gitBlame = new GitBlameService(
    git,
    () => activePath,
    () => sourceControl.repository(),
  );
  harness.current = {
    sourceControl,
    gitClone,
    gitHistory,
    gitStash,
    gitBlame,
    output,
    panel: { show: vi.fn() },
    run,
    themeKind: "dark",
  };
  return { ipc, sourceControl, run, gitClone, gitHistory, gitStash, gitBlame, events };
}

describe("SourceControlView", () => {
  beforeEach(() => {
    harness.current = null;
  });

  it("no folder: says so and offers Open Folder", async () => {
    const { run } = await setup({ state: "noWorkspace", runtime: READY });
    render(<SourceControlView />);
    expect(screen.getByText("Open a folder to use Source Control.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Folder" }));
    expect(run).toHaveBeenCalledWith("file.openFolder");
  });

  it("Git missing: says so, offers Install Git Runtime and only offers system Git labelled with its path", async () => {
    const { sourceControl } = await setup({
      state: "gitMissing",
      reason: "Git runtime is not installed yet.",
      systemGit: "C:\\Program Files\\Git\\cmd\\git.exe",
    });
    const installed = vi.spyOn(sourceControl, "installGitRuntime");
    render(<SourceControlView />);
    expect(screen.getAllByText("Git runtime is not installed yet.").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Install Git Runtime" }));
    expect(installed).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Use System Git" })).toHaveAttribute(
      "title",
      "Use System Git at C:\\Program Files\\Git\\cmd\\git.exe",
    );
  });

  it("not a repository: offers Initialize Repository", async () => {
    const { ipc } = await setup({ state: "notRepository", git: "OpenMind portable Git" });
    render(<SourceControlView />);
    expect(screen.getByText("This folder is not a Git repository.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Initialize Repository" }));
    await waitFor(() => {
      expect(ipc.gitInit).toHaveBeenCalled();
    });
  });

  it("repository: shows the name, branch, the Git in use and the three groups", async () => {
    await setup(repo(CHANGES, { git: "System Git at C:\\git.exe" }));
    render(<SourceControlView />);

    expect(screen.getByText("site")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Git branch main" })).toBeInTheDocument();
    expect(screen.getByText("Git: System Git at C:\\git.exe")).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "Staged Changes" })).getByText("staged.txt"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "Changes" })).getByText("edited.txt"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "Untracked Changes" })).getByText("new file.txt"),
    ).toBeInTheDocument();
  });

  it("a clean repository says so", async () => {
    await setup(repo([]));
    render(<SourceControlView />);
    expect(screen.getByText("No changes. The working tree is clean.")).toBeInTheDocument();
  });

  it("stage and unstage buttons call the backend with the file", async () => {
    const { ipc } = await setup(repo(CHANGES));
    render(<SourceControlView />);
    fireEvent.click(screen.getByRole("button", { name: "Stage edited.txt" }));
    await waitFor(() => {
      expect(ipc.gitStage).toHaveBeenCalledWith(["edited.txt"]);
    });
    fireEvent.click(screen.getByRole("button", { name: "Unstage staged.txt" }));
    await waitFor(() => {
      expect(ipc.gitUnstage).toHaveBeenCalledWith(["staged.txt"]);
    });
    fireEvent.click(screen.getByRole("button", { name: "Stage new file.txt" }));
    await waitFor(() => {
      expect(ipc.gitStage).toHaveBeenCalledWith(["new file.txt"]);
    });
  });

  it("Stage All and Unstage All are wired", async () => {
    const { ipc } = await setup(repo(CHANGES));
    render(<SourceControlView />);
    fireEvent.click(screen.getByRole("button", { name: "Stage All Changes" }));
    await waitFor(() => {
      expect(ipc.gitStageAll).toHaveBeenCalled();
    });
    fireEvent.click(screen.getByRole("button", { name: "Unstage All Changes" }));
    await waitFor(() => {
      expect(ipc.gitUnstageAll).toHaveBeenCalled();
    });
  });

  it("Commit is disabled with its reason until there is a message and staged changes", async () => {
    const { ipc } = await setup(repo(CHANGES));
    render(<SourceControlView />);
    const commit = screen.getByRole("button", { name: "Commit" });
    expect(commit).toBeDisabled();
    expect(commit).toHaveAttribute("title", "Enter a commit message.");

    fireEvent.change(screen.getByLabelText("Commit message"), { target: { value: "fix: it" } });
    expect(screen.getByRole("button", { name: "Commit" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Commit" }));
    await waitFor(() => {
      expect(ipc.gitCommit).toHaveBeenCalledWith("fix: it");
    });
  });

  it("Commit stays disabled when nothing is staged", async () => {
    await setup(repo([change("edited.txt", { worktree: "modified" })]));
    render(<SourceControlView />);
    fireEvent.change(screen.getByLabelText("Commit message"), { target: { value: "msg" } });
    const commit = screen.getByRole("button", { name: "Commit" });
    expect(commit).toBeDisabled();
    expect(commit).toHaveAttribute("title", "There are no staged changes to commit.");
  });

  it("discard shows a confirmation; Cancel discards nothing, Discard runs it", async () => {
    const { ipc } = await setup(repo(CHANGES));
    render(<SourceControlView />);
    fireEvent.click(screen.getByRole("button", { name: "Discard Changes edited.txt" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("edited.txt");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(ipc.gitDiscard).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Discard Changes edited.txt" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Discard Changes" }),
    );
    await waitFor(() => {
      expect(ipc.gitDiscard).toHaveBeenCalledWith(["edited.txt"], true);
    });
  });

  it("deleting an untracked file needs a confirmation as well", async () => {
    const { ipc } = await setup(repo(CHANGES));
    render(<SourceControlView />);
    fireEvent.click(screen.getByRole("button", { name: "Delete new file.txt" }));
    expect(ipc.gitDeleteUntracked).not.toHaveBeenCalled();
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete File" }),
    );
    await waitFor(() => {
      expect(ipc.gitDeleteUntracked).toHaveBeenCalledWith("new file.txt", true);
    });
  });

  it("the diff buttons open the working-tree and the staged diff", async () => {
    const { ipc } = await setup(repo(CHANGES));
    render(<SourceControlView />);
    fireEvent.click(screen.getByRole("button", { name: "Open Diff edited.txt" }));
    await waitFor(() => {
      expect(ipc.gitDiff).toHaveBeenCalledWith("edited.txt", false);
    });
    fireEvent.click(screen.getByRole("button", { name: "Open Staged Diff staged.txt" }));
    await waitFor(() => {
      expect(ipc.gitDiff).toHaveBeenCalledWith("staged.txt", true);
    });
  });

  it("Fetch, Pull and Push in the More menu are disabled with a reason when there is no upstream", async () => {
    await setup(repo(CHANGES));
    render(<SourceControlView />);
    fireEvent.click(screen.getByRole("button", { name: "More Actions" }));
    expect(screen.getByRole("menuitem", { name: "Fetch" })).toBeEnabled();
    const pull = screen.getByRole("menuitem", { name: "Pull" });
    expect(pull).toBeDisabled();
    expect(pull).toHaveAttribute("title", expect.stringContaining("no upstream"));
  });
});

describe("GitDiffViewer", () => {
  beforeEach(() => {
    harness.current = null;
  });

  it("shows both sides with a title, and closes", async () => {
    const { sourceControl } = await setup(repo(CHANGES), {
      gitDiff: vi
        .fn()
        .mockResolvedValue({ path: "edited.txt", original: "old", modified: "new", binary: false }),
    });
    render(<GitDiffViewer themeKind="dark" />);
    expect(screen.queryByRole("region", { name: "Git diff" })).toBeNull();

    await sourceControl.openDiff(CHANGES[0] as GitFileChange, false);
    expect(await screen.findByText("edited.txt (Working Tree)")).toBeInTheDocument();
    expect(screen.getByTestId("diff-host")).toHaveTextContent("old|new");
    fireEvent.click(screen.getByRole("button", { name: "Close diff" }));
    expect(screen.queryByRole("region", { name: "Git diff" })).toBeNull();
  });

  it("titles a staged diff, marks new files and shows nothing on the missing side", async () => {
    const { sourceControl } = await setup(repo(CHANGES), {
      gitDiff: vi
        .fn()
        .mockResolvedValue({ path: "staged.txt", original: null, modified: "x", binary: false }),
    });
    render(<GitDiffViewer themeKind="dark" />);
    await sourceControl.openDiff(CHANGES[1] as GitFileChange, true);
    expect(await screen.findByText("staged.txt (Staged)")).toBeInTheDocument();
    expect(screen.getByText(/New file/)).toBeInTheDocument();
    expect(screen.getByTestId("diff-host")).toHaveTextContent("∅|x");
  });

  it("a binary file shows the plain message instead of an editor", async () => {
    const { sourceControl } = await setup(repo(CHANGES), {
      gitDiff: vi
        .fn()
        .mockResolvedValue({ path: "a.bin", original: null, modified: null, binary: true }),
    });
    render(<GitDiffViewer themeKind="dark" />);
    await sourceControl.openDiff(CHANGES[0] as GitFileChange, false);
    expect(await screen.findByText("Binary file diff is not supported.")).toBeInTheDocument();
    expect(screen.queryByTestId("diff-host")).toBeNull();
  });

  it("an error is shown as an alert", async () => {
    const { sourceControl } = await setup(repo(CHANGES), {
      gitDiff: vi.fn().mockRejectedValue("File is too large to diff."),
    });
    render(<GitDiffViewer themeKind="dark" />);
    await sourceControl.openDiff(CHANGES[0] as GitFileChange, false);
    expect(await screen.findByRole("alert")).toHaveTextContent("File is too large to diff.");
  });
});
