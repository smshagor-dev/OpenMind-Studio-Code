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
vi.mock("../editor/MonacoDiffHost", () => ({ MonacoDiffHost: () => <div /> }));

import { GitBlameViewer } from "./GitBlameViewer";
import { GitCloneForm } from "./GitCloneForm";
import { GitHistoryPanel } from "./GitHistoryPanel";
import { GitStashPanel } from "./GitStashPanel";
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

function repo(changes: GitFileChange[], patch: { upstream?: string | null } = {}): GitSnapshot {
  return {
    state: "repository",
    root: "C:/My Projects/site",
    name: "site",
    git: "OpenMind portable Git",
    status: {
      branch: "main",
      detached: false,
      oid: "abc",
      upstream: patch.upstream ?? null,
      ahead: 0,
      behind: 0,
      changes,
    },
  };
}

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
  const openFolder = vi.fn().mockResolvedValue(null);
  const gitClone = new GitCloneService(git, events, openFolder, () => sourceControl.runtime());
  const gitHistory = new GitHistoryService(git, events, (hash, file) =>
    sourceControl.openCommitDiff(hash, file),
  );
  const gitStash = new GitStashService(
    git,
    events,
    () => sourceControl.refresh(),
    () => {
      const changes = sourceControl.status()?.changes ?? [];
      const untracked = changes.filter((entry) => entry.worktree === "untracked").length;
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
    run: vi.fn(),
  };
  return { ipc, sourceControl, gitClone, gitHistory, gitStash, gitBlame, openFolder };
}

describe("Clone Repository", () => {
  beforeEach(() => {
    harness.current = null;
  });

  it("with no folder open: a Clone button opens a form, and Clone says why it is disabled", async () => {
    await setup({ state: "noWorkspace", runtime: READY });
    render(<SourceControlView />);

    fireEvent.click(screen.getByRole("button", { name: "Clone Repository" }));
    const form = within(screen.getByRole("form", { name: "Clone Repository" }));
    const clone = form.getByRole("button", { name: "Clone" });
    expect(clone).toBeDisabled();
    expect(clone).toHaveAttribute("title", "Enter the address of the repository to clone.");

    fireEvent.change(form.getByLabelText("Repository address"), {
      target: { value: "https://host/owner/repo.git" },
    });
    expect(form.getByLabelText("Folder name")).toHaveValue("repo");
    expect(form.getByRole("button", { name: "Clone" })).toHaveAttribute(
      "title",
      "Choose a destination folder.",
    );
  });

  it("clones, then offers to open the folder", async () => {
    const { ipc, openFolder } = await setup(
      { state: "noWorkspace", runtime: READY },
      {
        openFolderDialog: vi.fn().mockResolvedValue("C:/My Clones"),
        gitClone: vi.fn().mockResolvedValue("C:/My Clones/repo"),
      },
    );
    render(<GitCloneForm />);
    fireEvent.click(screen.getByRole("button", { name: "Clone Repository" }));
    fireEvent.change(screen.getByLabelText("Repository address"), {
      target: { value: "C:/repos/bare repo.git" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Choose Folder…" }));
    expect(await screen.findByText("C:/My Clones")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clone" }));
    await waitFor(() => {
      expect(ipc.gitClone).toHaveBeenCalledWith(
        "C:/repos/bare repo.git",
        "C:/My Clones",
        "bare repo",
      );
    });
    expect(await screen.findByText("Cloned to C:/My Clones/repo")).toBeInTheDocument();
    expect(openFolder).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open Cloned Folder" }));
    await waitFor(() => {
      expect(openFolder).toHaveBeenCalledWith("C:/My Clones/repo");
    });
  });

  it("a non-empty destination shows the refusal and no Open button", async () => {
    await setup(
      { state: "notRepository", git: "OpenMind portable Git" },
      {
        openFolderDialog: vi.fn().mockResolvedValue("C:/p"),
        gitClone: vi.fn().mockRejectedValue('The folder "repo" already exists and is not empty.'),
      },
    );
    render(<SourceControlView />);
    fireEvent.click(screen.getByRole("button", { name: "Clone Repository" }));
    fireEvent.change(screen.getByLabelText("Repository address"), {
      target: { value: "https://host/repo.git" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Choose Folder…" }));
    await screen.findByText("C:/p");
    fireEvent.click(screen.getByRole("button", { name: "Clone" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already exists and is not empty");
    expect(screen.queryByRole("button", { name: "Open Cloned Folder" })).toBeNull();
  });

  it("with Git missing the Clone button is disabled with the reason", async () => {
    await setup({
      state: "gitMissing",
      reason: "Git runtime is not installed yet.",
      systemGit: null,
    });
    render(<SourceControlView />);
    const button = screen.getByRole("button", { name: "Clone Repository" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Git runtime is not installed yet.");
  });
});

describe("History panel", () => {
  beforeEach(() => {
    harness.current = null;
  });

  const commits = [
    {
      hash: "a".repeat(40),
      shortHash: "aaaaaaa",
      author: "Ada Lovelace",
      date: "2026-01-02T03:04:05+00:00",
      subject: "fix: the thing",
    },
    {
      hash: "b".repeat(40),
      shortHash: "bbbbbbb",
      author: "Bob",
      date: "2026-01-01T00:00:00+00:00",
      subject: "initial",
    },
  ];

  it("lists commits with short hash, subject and author", async () => {
    await setup(repo([]), { gitHistory: vi.fn().mockResolvedValue(commits) });
    render(<GitHistoryPanel />);
    expect(await screen.findByText("fix: the thing")).toBeInTheDocument();
    expect(screen.getByText("aaaaaaa")).toBeInTheDocument();
    expect(screen.getByText(/Ada Lovelace/)).toBeInTheDocument();
    expect(screen.getByText("initial")).toBeInTheDocument();
  });

  it("selecting a commit shows its files, and a file opens that commit's diff", async () => {
    const { ipc, sourceControl } = await setup(repo([]), {
      gitHistory: vi.fn().mockResolvedValue(commits),
      gitCommitFiles: vi.fn().mockResolvedValue([
        { path: "src/a b.txt", origPath: null, status: "M" },
        { path: "new name.txt", origPath: "old name.txt", status: "R" },
      ]),
    });
    render(<GitHistoryPanel />);
    fireEvent.click(await screen.findByText("fix: the thing"));
    const files = within(await screen.findByRole("list", { name: "Files in aaaaaaa" }));
    expect(files.getByText("src/a b.txt")).toBeInTheDocument();
    expect(files.getByText("← old name.txt")).toBeInTheDocument();

    fireEvent.click(files.getByText("src/a b.txt"));
    await waitFor(() => {
      expect(ipc.gitCommitDiff).toHaveBeenCalledWith(commits[0]?.hash, {
        path: "src/a b.txt",
        origPath: null,
        status: "M",
      });
    });
    expect(sourceControl.getState().diff?.commit).toBe(commits[0]?.hash);
  });

  it("an empty repository says there are no commits", async () => {
    await setup(repo([]));
    render(<GitHistoryPanel />);
    expect(await screen.findByText("There are no commits yet.")).toBeInTheDocument();
  });
});

describe("Stash panel", () => {
  beforeEach(() => {
    harness.current = null;
  });

  const stashes = [
    { index: 0, description: "On main: my work", message: "my work", branch: "main", date: "" },
    { index: 1, description: "WIP on main: abc1234 s", message: null, branch: "main", date: "" },
  ];

  it("lists stashes with Apply, Pop and Drop; Stash is disabled when there is nothing to stash", async () => {
    await setup(repo([]), { gitStashList: vi.fn().mockResolvedValue(stashes) });
    render(<GitStashPanel />);
    expect(await screen.findByText("my work")).toBeInTheDocument();
    expect(screen.getByText("WIP on main: abc1234 s")).toBeInTheDocument();
    const stash = screen.getByRole("button", { name: "Stash Changes" });
    expect(stash).toBeDisabled();
    expect(stash).toHaveAttribute("title", "There are no local changes to stash.");
    for (const action of ["Apply", "Pop", "Drop"]) {
      expect(screen.getByRole("button", { name: `${action} stash my work` })).toBeEnabled();
    }
  });

  it("stashes with a message and wires Apply and Pop", async () => {
    const { ipc } = await setup(repo([change("a.txt", { worktree: "modified" })]), {
      gitStashList: vi.fn().mockResolvedValue(stashes),
    });
    render(<GitStashPanel />);
    await screen.findByText("my work");
    fireEvent.change(screen.getByLabelText("Stash message"), { target: { value: "wip" } });
    fireEvent.click(screen.getByRole("button", { name: "Stash Changes" }));
    await waitFor(() => {
      expect(ipc.gitStashPush).toHaveBeenCalledWith("wip", false);
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply stash my work" }));
    await waitFor(() => {
      expect(ipc.gitStashApply).toHaveBeenCalledWith(0);
    });
    fireEvent.click(screen.getByRole("button", { name: "Pop stash my work" }));
    await waitFor(() => {
      expect(ipc.gitStashPop).toHaveBeenCalledWith(0);
    });
  });

  it("Drop shows a confirmation; Cancel keeps the stash, Drop deletes it", async () => {
    const { ipc } = await setup(repo([]), { gitStashList: vi.fn().mockResolvedValue(stashes) });
    render(<GitStashPanel />);
    await screen.findByText("my work");
    fireEvent.click(screen.getByRole("button", { name: "Drop stash my work" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("my work");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(ipc.gitStashDrop).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Drop stash my work" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Drop Stash" }),
    );
    await waitFor(() => {
      expect(ipc.gitStashDrop).toHaveBeenCalledWith(0, true);
    });
  });

  it("a conflicting pop shows Git's message as an alert", async () => {
    await setup(repo([]), {
      gitStashList: vi.fn().mockResolvedValue(stashes),
      gitStashPop: vi.fn().mockRejectedValue("CONFLICT (content): Merge conflict in a.txt"),
    });
    render(<GitStashPanel />);
    await screen.findByText("my work");
    fireEvent.click(screen.getByRole("button", { name: "Pop stash my work" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("CONFLICT (content)");
  });
});

describe("Blame", () => {
  beforeEach(() => {
    harness.current = null;
  });

  it("the Blame button is disabled with a reason for an untracked file", async () => {
    await setup(repo([change("new.txt", { worktree: "untracked" })]));
    activePath = "C:/My Projects/site/new.txt";
    render(<SourceControlView />);
    const button = screen.getByRole("button", { name: "Blame Active File" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "This file is untracked — it has no history to blame.");
  });

  it("shows every line with its commit, author and summary, and closes", async () => {
    const { gitBlame } = await setup(repo([]), {
      gitBlame: vi.fn().mockResolvedValue([
        {
          line: 1,
          shortHash: "abc1234",
          author: "Ada",
          time: 1_700_000_000,
          summary: "first commit",
          content: "line one",
          committed: true,
        },
        {
          line: 2,
          shortHash: "0000000",
          author: "Not Committed Yet",
          time: 0,
          summary: "Uncommitted changes",
          content: "edited",
          committed: false,
        },
      ]),
    });
    activePath = "C:\\My Projects\\site\\a.txt";
    render(<GitBlameViewer />);
    expect(screen.queryByRole("region", { name: "Git blame" })).toBeNull();

    await gitBlame.open();
    const region = within(await screen.findByRole("region", { name: "Git blame" }));
    expect(region.getByText("abc1234")).toBeInTheDocument();
    expect(region.getByText("Ada")).toBeInTheDocument();
    expect(region.getAllByText("first commit").length).toBeGreaterThan(0);
    expect(region.getByText("Not Committed Yet")).toBeInTheDocument();
    fireEvent.click(region.getByRole("button", { name: "Close blame" }));
    expect(screen.queryByRole("region", { name: "Git blame" })).toBeNull();
  });

  it("a binary file shows Git's reason instead of lines", async () => {
    const { gitBlame } = await setup(repo([]), {
      gitBlame: vi.fn().mockRejectedValue("Binary files can't be blamed."),
    });
    activePath = "C:/My Projects/site/a.bin";
    render(<GitBlameViewer />);
    await gitBlame.open();
    expect(await screen.findByRole("alert")).toHaveTextContent("Binary files can't be blamed.");
  });
});

describe("Renames and remote errors in the view", () => {
  beforeEach(() => {
    harness.current = null;
  });

  it("a staged rename shows the new name with its old name", async () => {
    await setup(repo([change("new name.txt", { index: "renamed", origPath: "old name.txt" })]));
    render(<SourceControlView />);
    const staged = within(screen.getByRole("region", { name: "Staged Changes" }));
    expect(staged.getByText("new name.txt")).toBeInTheDocument();
    expect(staged.getByText("← old name.txt")).toBeInTheDocument();
    expect(staged.getByTitle("Renamed")).toHaveTextContent("R");
    // Unstaging the rename unstages both halves.
    fireEvent.click(staged.getByRole("button", { name: "Unstage new name.txt" }));
  });

  it("an authentication failure from fetch is shown as the credential message", async () => {
    const auth = "Authentication is required. Credential storage is not implemented yet.";
    await setup(repo([], { upstream: "origin/main" }), {
      gitFetch: vi.fn().mockRejectedValue(auth),
    });
    render(<SourceControlView />);
    fireEvent.click(screen.getByRole("button", { name: "More Actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Fetch" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(auth);
  });
});
