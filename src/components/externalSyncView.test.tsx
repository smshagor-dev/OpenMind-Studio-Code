import { ipcWorkspaceFeed } from "../testUtils/canonicalFeeds";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EventBus } from "../services/eventBus";
import type { AppEvents } from "../services/events";
import { GitService } from "../services/gitService";
import type { GitFileChange, GitSnapshot } from "../services/ipc";
import { OutputService } from "../services/outputService";
import { SourceControlService } from "../services/sourceControlService";
import type { EditorTabView } from "../services/workspaceService";
import { createFakeIpc } from "../testUtils/fakeIpcClient";

const harness = vi.hoisted((): { current: unknown } => ({ current: null }));

vi.mock("../services/container", async () => {
  const collab = (await import("../testUtils/collabStub")).collabStub();
  return {
    get container() {
      return { collab, ...(harness.current ?? {}) };
    },
  };
});
vi.mock("../editor/MonacoDiffHost", () => ({
  MonacoDiffHost: (props: { original: string | null; modified: string | null }) => (
    <div data-testid="diff-host">{`${props.original ?? ""}|${props.modified ?? ""}`}</div>
  ),
}));

import { ErrorToast } from "./ErrorToast";
import { ExternalChangeBanner } from "./ExternalChangeBanner";
import { ExternalCompareViewer } from "./ExternalCompareViewer";
import { TabBar } from "./TabBar";

function tab(
  external: EditorTabView["external"],
  patch: Partial<EditorTabView> = {},
): EditorTabView {
  return {
    id: "doc-1",
    docId: "doc-1",
    kind: "text",
    preview: false,
    groupId: "group-1",
    path: "C:/My Site/notes.txt",
    title: "notes.txt",
    dirty: true,
    encoding: "utf8",
    lineEnding: "lf",
    external,
    ...patch,
  };
}

function fakeContainer() {
  const fileSync = {
    compare: vi.fn().mockReturnValue(true),
    keepMine: vi.fn(),
    reloadFromDisk: vi.fn().mockResolvedValue(true),
    closeCompare: vi.fn(),
    subscribe: () => () => undefined,
    getState: () => ({ compare: null }),
  };
  const run = vi.fn();
  harness.current = { fileSync, run };
  return { fileSync, run };
}

describe("ExternalChangeBanner", () => {
  beforeEach(() => {
    harness.current = null;
  });

  it("renders nothing while the file is in sync", () => {
    fakeContainer();
    const { container } = render(<ExternalChangeBanner tab={tab("none")} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("changed with unsaved edits: the warning and the four choices; Reload asks first", () => {
    const { fileSync, run } = fakeContainer();
    render(<ExternalChangeBanner tab={tab("changed")} />);
    const banner = within(screen.getByRole("alert"));
    expect(
      banner.getByText("File changed on disk while you have unsaved changes."),
    ).toBeInTheDocument();

    fireEvent.click(banner.getByRole("button", { name: "Compare" }));
    expect(fileSync.compare).toHaveBeenCalledWith("doc-1");
    fireEvent.click(banner.getByRole("button", { name: "Keep My Changes" }));
    expect(fileSync.keepMine).toHaveBeenCalledWith("doc-1");
    fireEvent.click(banner.getByRole("button", { name: "Save As…" }));
    expect(run).toHaveBeenCalledWith("file.saveAs");

    fireEvent.click(banner.getByRole("button", { name: "Reload from Disk" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("Your unsaved changes will be lost");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(fileSync.reloadFromDisk).not.toHaveBeenCalled();

    fireEvent.click(banner.getByRole("button", { name: "Reload from Disk" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Reload from Disk" }),
    );
    expect(fileSync.reloadFromDisk).toHaveBeenCalledWith("doc-1");
  });

  it("deleted: the text is kept and Save, Save As and Close Tab are offered", () => {
    const { run } = fakeContainer();
    render(<ExternalChangeBanner tab={tab("deleted")} />);
    expect(screen.getByText(/deleted or moved on disk/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(run).toHaveBeenCalledWith("file.save");
    fireEvent.click(screen.getByRole("button", { name: "Close Tab" }));
    expect(run).toHaveBeenCalledWith("file.closeActiveTab");
    expect(screen.queryByRole("button", { name: "Compare" })).toBeNull();
  });
});

describe("ExternalCompareViewer", () => {
  it("shows the disk text on the left and the edits on the right, and closes", () => {
    const closeCompare = vi.fn();
    const state = {
      compare: { docId: "doc-1", title: "notes.txt", disk: "theirs", buffer: "mine" },
    };
    harness.current = {
      fileSync: { subscribe: () => () => undefined, getState: () => state, closeCompare },
    };
    render(<ExternalCompareViewer themeKind="dark" />);
    expect(screen.getByRole("region", { name: "Compare with disk" })).toBeInTheDocument();
    expect(screen.getByTestId("diff-host")).toHaveTextContent("theirs|mine");
    fireEvent.click(screen.getByRole("button", { name: "Close compare" }));
    expect(closeCompare).toHaveBeenCalled();
  });
});

describe("tabs and notices", () => {
  it("a deleted tab is marked and explains itself; a conflicted tab is flagged", () => {
    render(
      <TabBar
        tabs={[
          tab("deleted", { id: "a", docId: "a", title: "gone.txt", path: "C:/x/gone.txt" }),
          tab("changed", { id: "b", docId: "b", title: "edited.txt", path: "C:/x/edited.txt" }),
        ]}
        activeId="a"
        onSelect={() => undefined}
        onClose={() => undefined}
        onKeepOpen={() => undefined}
      />,
    );
    const tabs = screen.getAllByRole("tab");
    expect(tabs[0]).toHaveClass("tab--deleted");
    expect(tabs[0]).toHaveAttribute("title", "C:/x/gone.txt (deleted on disk)");
    expect(tabs[1]).toHaveClass("tab--conflict");
    expect(tabs[1]?.getAttribute("title")).toContain("changed on disk");
  });

  it("an info notice is a status message, an error stays an alert", () => {
    render(
      <ErrorToast
        toasts={[
          { id: 1, message: "notes.txt reloaded from disk.", kind: "info" },
          { id: 2, message: "Something failed" },
        ]}
        onDismiss={() => undefined}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("notes.txt reloaded from disk.");
    expect(screen.getByText("Something failed")).toBeInTheDocument();
  });
});

describe("Source Control and stale content", () => {
  const change = (path: string, patch: Partial<GitFileChange>): GitFileChange => ({
    path,
    origPath: null,
    index: "unmodified",
    worktree: "unmodified",
    conflicted: false,
    ...patch,
  });
  const repo = (changes: GitFileChange[]): GitSnapshot => ({
    state: "repository",
    root: "C:/My Site",
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
    },
  });

  async function scRig(snapshots: GitSnapshot[]) {
    const snapshot = vi.fn();
    for (const entry of snapshots.slice(0, -1)) snapshot.mockResolvedValueOnce(entry);
    snapshot.mockResolvedValue(snapshots[snapshots.length - 1]);
    const ipc = createFakeIpc({ gitSnapshot: snapshot });
    const events = new EventBus<AppEvents>();
    const notices: string[] = [];
    events.on("appNotice", ({ message }) => notices.push(message));
    const filesChanged = vi.fn().mockResolvedValue(undefined);
    const sc = new SourceControlService(
      new GitService(ipc, new OutputService()),
      events,
      vi.fn(),
      vi.fn(),
      filesChanged,
    );
    const gitFeed = ipcWorkspaceFeed(() => ipc.gitSnapshot());
    sc.useCanonical(gitFeed);
    await gitFeed.refresh(); // the backend's first read of the folder
    await sc.initialize();
    return { sc, ipc, notices, filesChanged };
  }

  it("branch switch, discard, delete and pull refresh open editors; staging does not", async () => {
    const { sc, filesChanged } = await scRig([repo([change("a.txt", { worktree: "modified" })])]);
    await sc.stage(["a.txt"]);
    await sc.unstage(["a.txt"]);
    expect(filesChanged).not.toHaveBeenCalled();

    await sc.switchBranch("other");
    expect(filesChanged).toHaveBeenCalledTimes(1);
    sc.requestDiscard(["a.txt"]);
    await sc.confirm();
    expect(filesChanged).toHaveBeenCalledTimes(2);
    sc.requestDiscardAll();
    await sc.confirm();
    expect(filesChanged).toHaveBeenCalledTimes(3);
    sc.requestDeleteUntracked("n.txt");
    await sc.confirm();
    expect(filesChanged).toHaveBeenCalledTimes(4);
  });

  it("a failed operation does not report files as changed", async () => {
    const { sc, filesChanged } = await scRig([repo([])]);
    vi.mocked(sc["git"].ipc.gitSwitchBranch).mockRejectedValue(
      "error: local changes would be overwritten",
    );
    expect(await sc.switchBranch("other")).toBe(false);
    expect(filesChanged).not.toHaveBeenCalled();
  });

  it("a staged diff whose staged state disappears is closed with a notice, not left stale", async () => {
    const staged = repo([change("a.txt", { index: "modified" })]);
    const unstaged = repo([change("a.txt", { worktree: "modified" })]);
    const { sc, notices } = await scRig([staged, unstaged]);
    await sc.openDiff(change("a.txt", { index: "modified" }), true);
    expect(sc.getState().diff?.staged).toBe(true);

    await sc.refresh(); // e.g. the terminal ran `git restore --staged a.txt`
    expect(sc.getState().diff).toBeNull();
    expect(notices).toEqual(["Diff closed: a.txt no longer has staged changes."]);
  });

  it("a diff that is still valid stays and reloads without blanking", async () => {
    const same = repo([change("a.txt", { worktree: "modified" })]);
    const { sc, ipc } = await scRig([same]);
    await sc.openDiff(change("a.txt", { worktree: "modified" }), false);
    const before = sc.getState().diff?.sides;
    expect(before).not.toBeNull();
    const calls = vi.mocked(ipc.gitDiff).mock.calls.length;
    await sc.refresh();
    expect(sc.getState().diff?.sides).toEqual(before);
    await vi.waitFor(() => {
      expect(vi.mocked(ipc.gitDiff).mock.calls.length).toBeGreaterThan(calls);
    });
  });
});
