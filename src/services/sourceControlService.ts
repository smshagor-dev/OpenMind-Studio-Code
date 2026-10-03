import type { EventBus } from "./eventBus";
import type { WorkspaceFeed } from "./state/canonicalStateService";
import type { AppEvents } from "./events";
import type { GitService } from "./gitService";
import type {
  GitBranch,
  GitCommitFile,
  GitDiffSides,
  GitFileChange,
  GitIdentity,
  GitRepoStatus,
  GitRuntime,
  GitSnapshot,
} from "./ipc";
import type { Availability } from "./runtimeService";
import {
  commitAvailability,
  groupChanges,
  joinRepoPath,
  type ChangeGroups,
} from "./sourceControlModel";

export {
  badgeFor,
  commitAvailability,
  groupChanges,
  joinRepoPath,
  type ChangeGroups,
  type CommitInput,
} from "./sourceControlModel";

export type PendingConfirm =
  | { kind: "discard"; paths: string[]; title: string; message: string; confirmLabel: string }
  | { kind: "discardAll"; title: string; message: string; confirmLabel: string }
  | { kind: "deleteUntracked"; path: string; title: string; message: string; confirmLabel: string }
  | { kind: "deleteBranch"; name: string; title: string; message: string; confirmLabel: string };

/** How a diff is titled: `a.txt (Working Tree)` or `a.txt (Staged)`. */
export function diffTitle(path: string, staged: boolean, commit: string | null = null): string {
  if (commit !== null) return `${path} (${commit.slice(0, 7)})`;
  return `${path} (${staged ? "Staged" : "Working Tree"})`;
}

export interface DiffView {
  path: string;
  staged: boolean;
  /** The commit (full hash) this diff belongs to, for the History panel; `null` for the working tree / index. */
  commit: string | null;
  loading: boolean;
  sides: GitDiffSides | null;
  error: string | null;
}

export interface SourceControlState {
  snapshot: GitSnapshot | null;
  loading: boolean;
  /** The action in flight, or `null`. */
  busy: string | null;
  message: string;
  notice: string | null;
  error: string | null;
  identity: GitIdentity | null;
  branches: GitBranch[];
  pending: PendingConfirm | null;
  diff: DiffView | null;
  allowSystem: boolean;
}

const INITIAL: SourceControlState = {
  snapshot: null,
  loading: false,
  busy: null,
  message: "",
  notice: null,
  error: null,
  identity: null,
  branches: [],
  pending: null,
  diff: null,
  allowSystem: false,
};

/** What the view is in: decides which panel of the Source Control view shows. */
export type ViewKind = "loading" | "noFolder" | "gitMissing" | "notRepository" | "repository";

/**
 * The Source Control view's brain: the repository snapshot from the backend,
 * the three change groups, the commit message, and every action (stage,
 * unstage, discard, commit, diff, branches, fetch/pull/push). Nothing runs
 * unless the user asked; destructive actions go through `pending` and only
 * run once `confirm()` is called. Git itself runs in the backend.
 */
export class SourceControlService {
  private state: SourceControlState = INITIAL;
  private readonly listeners = new Set<() => void>();
  private refreshSeq = 0;
  /** The canonical Git state of this window's folder (`src/services/state`): read once per folder by the backend. */
  private canonical: WorkspaceFeed<GitSnapshot> | null = null;
  private offs: (() => void)[] = [];

  constructor(
    private readonly git: GitService,
    private readonly events: EventBus<AppEvents>,
    /** Opens a file in the editor (`WorkspaceService.openPath`). */
    private readonly openFile: (path: string) => Promise<unknown>,
    private readonly showRuntimeManager: () => void,
    /** Called after an operation that can change files on disk (discard, switch, pull, delete): open editors and the Explorer catch up. */
    private readonly filesChanged: () => Promise<unknown> = () => Promise.resolve(),
  ) {}

  getState(): SourceControlState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The folder's Git state arrives through the canonical state (`useCanonical`). Runs no Git command that changes anything. */
  async initialize(): Promise<void> {
    this.dispose();
    this.offs.push(
      // The folder's Git state follows through the canonical state; what this window shows of the old one goes.
      this.events.on("workspaceFolderChanged", () => {
        this.update({ diff: null, message: "", notice: null, error: null });
      }),
    );
    const allowSystem = await this.git.ipc.gitAllowSystem().catch(() => false);
    this.update({ allowSystem });
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off();
  }

  // --- What the view shows ---

  viewKind(): ViewKind {
    const snapshot = this.state.snapshot;
    if (snapshot === null) return "loading";
    switch (snapshot.state) {
      case "noWorkspace":
        return "noFolder";
      case "gitMissing":
        return "gitMissing";
      case "notRepository":
        return "notRepository";
      case "repository":
        return "repository";
    }
  }

  status(): GitRepoStatus | null {
    const snapshot = this.state.snapshot;
    return snapshot?.state === "repository" ? snapshot.status : null;
  }

  groups(): ChangeGroups {
    const status = this.status();
    return status === null ? { staged: [], changes: [], untracked: [] } : groupChanges(status);
  }

  /** e.g. "main", "(detached)", "No commits yet". */
  branchLabel(): string | null {
    const status = this.status();
    if (status === null) return null;
    if (status.detached) return "(detached HEAD)";
    return status.branch ?? "(no branch)";
  }

  /** The number of files with changes (Changes + Untracked + Staged, each file once). */
  changeCount(): number {
    return this.status()?.changes.length ?? 0;
  }

  syncLabel(): string | null {
    const status = this.status();
    if (status === null || status.upstream === null) return null;
    return `${String(status.ahead)}↑ ${String(status.behind)}↓`;
  }

  identityMissing(): boolean {
    const identity = this.state.identity;
    return identity === null ? false : identity.name === null || identity.email === null;
  }

  commitState(): Availability {
    const status = this.status();
    return commitAvailability({
      message: this.state.message,
      stagedCount: this.groups().staged.length,
      busy: this.state.busy !== null,
      identityMissing: this.identityMissing(),
      conflicts: status?.changes.some((change) => change.conflicted) ?? false,
    });
  }

  private idle(): Availability {
    return this.state.busy === null
      ? { enabled: true }
      : { enabled: false, reason: "Please wait — Git is busy." };
  }

  stageAllState(): Availability {
    const groups = this.groups();
    if (groups.changes.length + groups.untracked.length === 0) {
      return { enabled: false, reason: "There are no changes to stage." };
    }
    return this.idle();
  }

  unstageAllState(): Availability {
    return this.groups().staged.length === 0
      ? { enabled: false, reason: "There are no staged changes." }
      : this.idle();
  }

  discardAllState(): Availability {
    const tracked = this.groups().changes.filter((change) => !change.conflicted);
    return tracked.length === 0
      ? { enabled: false, reason: "There are no changes to discard." }
      : this.idle();
  }

  fileActionState(): Availability {
    return this.idle();
  }

  /** Fetch, Pull and Push need a repository with a commit; Pull/Push also an upstream. */
  remoteState(action: "fetch" | "pull" | "push"): Availability {
    const status = this.status();
    if (status === null) return { enabled: false, reason: "Open a repository first." };
    if (!status.oid) return { enabled: false, reason: "Make a first commit before syncing." };
    if (status.detached)
      return { enabled: false, reason: "HEAD is detached — switch to a branch first." };
    if (action !== "fetch" && status.upstream === null) {
      return {
        enabled: false,
        reason: "This branch has no upstream. Publish it from the terminal with git push -u.",
      };
    }
    return this.idle();
  }

  // --- Reading ---

  /**
   * Follows the backend's canonical Git state of this window's folder: one `git status` per folder and burst of
   * changes (a save, a terminal `git checkout`, another window's commit), shared by every window on that folder.
   */
  useCanonical(feed: WorkspaceFeed<GitSnapshot>): () => void {
    this.canonical = feed;
    const off = feed.subscribe((snapshot) => {
      // `undefined`: this window opened another folder; its Git state follows as soon as the backend has read it.
      if (snapshot === undefined) this.update({ snapshot: null, loading: true, identity: null, branches: [] });
      else void this.applySnapshot(snapshot, ++this.refreshSeq);
    });
    const current = feed.current();
    if (current !== undefined) void this.applySnapshot(current, ++this.refreshSeq);
    return () => {
      off();
      this.canonical = null;
    };
  }

  /**
   * Refresh (after an operation, or the button): the backend reads the folder's Git state once for every window on it
   * and this waits until the result is here.
   */
  async refresh(): Promise<void> {
    const seq = ++this.refreshSeq;
    this.update({ loading: true });
    try {
      await this.canonical?.refresh();
      if (seq === this.refreshSeq) this.update({ loading: false });
    } catch (error) {
      if (seq !== this.refreshSeq) return;
      this.update({ loading: false, error: String(error) });
      this.git.log(`Source Control: ${String(error)}`);
    }
  }

  private async applySnapshot(snapshot: GitSnapshot, seq: number): Promise<void> {
    if (seq !== this.refreshSeq) return;
    const before = this.state.snapshot;
    this.update({ snapshot, loading: false });
    this.refreshOpenDiff();
    if (snapshot.state !== "repository") {
      this.update({ identity: null, branches: [] });
      return;
    }
    // The identity is the repository's config: read it again only for another repository (or the first time).
    const sameRepo = before?.state === "repository" && before.root === snapshot.root;
    if (!sameRepo || this.state.identity === null) await this.loadIdentity(seq);
  }

  private async loadIdentity(seq: number): Promise<void> {
    const identity = await this.git.ipc.gitIdentity().catch(() => null);
    if (seq === this.refreshSeq) this.update({ identity });
  }

  async loadBranches(): Promise<void> {
    if (this.status() === null) return;
    try {
      this.update({ branches: await this.git.ipc.gitBranches() });
    } catch (error) {
      this.fail(String(error));
    }
  }

  // --- Actions ---

  setMessage(message: string): void {
    this.update({ message });
  }

  async initRepository(): Promise<boolean> {
    return this.act("Initializing the repository", async () => {
      await this.git.ipc.gitInit();
      return "Initialized an empty Git repository.";
    });
  }

  async stage(paths: string[]): Promise<boolean> {
    if (paths.length === 0) return false;
    return this.act("Staging", () => this.git.ipc.gitStage(paths));
  }

  async stageAll(): Promise<boolean> {
    if (!this.stageAllState().enabled) return false;
    return this.act("Staging all changes", () => this.git.ipc.gitStageAll());
  }

  async unstage(paths: string[]): Promise<boolean> {
    if (paths.length === 0) return false;
    return this.act("Unstaging", () => this.git.ipc.gitUnstage(paths));
  }

  async unstageAll(): Promise<boolean> {
    if (!this.unstageAllState().enabled) return false;
    return this.act("Unstaging all changes", () => this.git.ipc.gitUnstageAll());
  }

  async commit(): Promise<boolean> {
    if (!this.commitState().enabled) return false;
    const message = this.state.message;
    const done = await this.act("Committing", () => this.git.ipc.gitCommit(message));
    if (done) this.update({ message: "" });
    return done;
  }

  async saveIdentity(name: string, email: string): Promise<boolean> {
    const saved = await this.act("Saving your name and email", async () => {
      await this.git.ipc.gitSetIdentity(name, email);
      return "Saved your name and email for commits in this repository.";
    });
    // The identity isn't part of `git status`: read it again explicitly.
    if (saved) await this.loadIdentity(this.refreshSeq);
    return saved;
  }

  async fetch(): Promise<boolean> {
    return this.remote("fetch", "Fetching", () => this.git.ipc.gitFetch());
  }

  async pull(): Promise<boolean> {
    return this.remote("pull", "Pulling", () => this.git.ipc.gitPull());
  }

  async push(): Promise<boolean> {
    return this.remote("push", "Pushing", () => this.git.ipc.gitPush());
  }

  private async remote(
    action: "fetch" | "pull" | "push",
    label: string,
    run: () => Promise<string>,
  ): Promise<boolean> {
    if (!this.remoteState(action).enabled) return false;
    return this.act(label, async () => {
      const output = await run();
      const first = output.split("\n").find((line) => line.trim() !== "");
      return first ?? `${label.replace(/ing$/, "e")} finished.`;
    });
  }

  // --- Branches ---

  async switchBranch(name: string): Promise<boolean> {
    return this.act(
      `Switching to ${name}`,
      async () => {
        await this.git.ipc.gitSwitchBranch(name);
        return `Switched to ${name}.`;
      },
      true,
    );
  }

  async createBranch(name: string): Promise<boolean> {
    return this.act(`Creating ${name}`, async () => {
      await this.git.ipc.gitCreateBranch(name);
      return `Created and switched to ${name}.`;
    });
  }

  requestDeleteBranch(name: string): void {
    this.update({
      pending: {
        kind: "deleteBranch",
        name,
        title: "Delete Branch",
        message: `Delete the branch "${name}"? Git refuses if it has commits that aren't merged.`,
        confirmLabel: "Delete Branch",
      },
    });
  }

  // --- Destructive: confirmation first ---

  requestDiscard(paths: string[]): void {
    if (paths.length === 0) return;
    const what =
      paths.length === 1
        ? `the changes in "${paths[0] ?? ""}"`
        : `the changes in ${String(paths.length)} files`;
    this.update({
      pending: {
        kind: "discard",
        paths,
        title: "Discard Changes",
        message: `Discard ${what}? This can't be undone.`,
        confirmLabel: "Discard Changes",
      },
    });
  }

  requestDiscardAll(): void {
    if (!this.discardAllState().enabled) return;
    this.update({
      pending: {
        kind: "discardAll",
        title: "Discard All Changes",
        message:
          "Discard all changes to tracked files? Untracked files are kept. This can't be undone.",
        confirmLabel: "Discard All Changes",
      },
    });
  }

  requestDeleteUntracked(path: string): void {
    this.update({
      pending: {
        kind: "deleteUntracked",
        path,
        title: "Delete File",
        message: `Delete the untracked file "${path}" from disk? It can't be restored by Git.`,
        confirmLabel: "Delete File",
      },
    });
  }

  cancelPending(): void {
    if (this.state.pending !== null) this.update({ pending: null });
  }

  /** Runs the action the user just confirmed. */
  async confirm(): Promise<boolean> {
    const pending = this.state.pending;
    if (pending === null) return false;
    this.update({ pending: null });
    switch (pending.kind) {
      case "discard":
        return this.act(
          "Discarding changes",
          () => this.git.ipc.gitDiscard(pending.paths, true),
          true,
        );
      case "discardAll":
        return this.act("Discarding all changes", () => this.git.ipc.gitDiscardAll(true), true);
      case "deleteUntracked":
        return this.act(
          "Deleting the file",
          () => this.git.ipc.gitDeleteUntracked(pending.path, true),
          true,
        );
      case "deleteBranch":
        return this.act(`Deleting ${pending.name}`, async () => {
          await this.git.ipc.gitDeleteBranch(pending.name, true);
          return `Deleted branch ${pending.name}.`;
        });
    }
  }

  // --- Editor ---

  async openChangedFile(path: string): Promise<void> {
    const snapshot = this.state.snapshot;
    if (snapshot?.state !== "repository") return;
    await this.openFile(joinRepoPath(snapshot.root, path));
  }

  /** `keepSides`: reloading the diff already showing — the old text stays until the new arrives (no flicker). */
  async openDiff(change: GitFileChange, staged: boolean, keepSides = false): Promise<void> {
    const view: DiffView = {
      path: change.path,
      staged,
      commit: null,
      loading: true,
      sides: keepSides ? (this.state.diff?.sides ?? null) : null,
      error: null,
    };
    this.update({ diff: view });
    try {
      const sides = await this.git.ipc.gitDiff(change.path, staged);
      if (this.state.diff?.path === view.path && this.state.diff.staged === staged) {
        this.update({ diff: { ...view, loading: false, sides } });
      }
    } catch (error) {
      if (this.state.diff?.path === view.path) {
        this.update({ diff: { ...view, loading: false, error: String(error) } });
      }
    }
  }

  /** Shows one file of a commit (from the History panel) against that commit's first parent. */
  async openCommitDiff(hash: string, file: GitCommitFile): Promise<void> {
    const view: DiffView = {
      path: file.path,
      staged: false,
      commit: hash,
      loading: true,
      sides: null,
      error: null,
    };
    this.update({ diff: view });
    try {
      const sides = await this.git.ipc.gitCommitDiff(hash, file);
      if (this.state.diff?.commit === hash && this.state.diff.path === file.path) {
        this.update({ diff: { ...view, loading: false, sides } });
      }
    } catch (error) {
      if (this.state.diff?.commit === hash) {
        this.update({ diff: { ...view, loading: false, error: String(error) } });
      }
    }
  }

  /** Which Git is usable, from the last snapshot (`null` until one has arrived). */
  runtime(): GitRuntime | null {
    const snapshot = this.state.snapshot;
    if (snapshot === null) return null;
    switch (snapshot.state) {
      case "noWorkspace":
        return snapshot.runtime;
      case "gitMissing":
        return {
          ready: false,
          label: null,
          reason: snapshot.reason,
          systemGit: snapshot.systemGit,
        };
      case "notRepository":
      case "repository":
        return { ready: true, label: snapshot.git, reason: null, systemGit: null };
    }
  }

  /** The repository root and status, for panels that work on it (blame, stash). */
  repository(): { root: string; status: GitRepoStatus } | null {
    const snapshot = this.state.snapshot;
    return snapshot?.state === "repository"
      ? { root: snapshot.root, status: snapshot.status }
      : null;
  }

  closeDiff(): void {
    if (this.state.diff !== null) this.update({ diff: null });
  }

  // --- Runtime ---

  /** Opens the Runtime Manager, where Git is installed. */
  installGitRuntime(): void {
    this.showRuntimeManager();
  }

  /** Lets OpenMind use the Git found on the machine (labelled "System Git at <path>" wherever it is shown). */
  async useSystemGit(): Promise<void> {
    await this.git.ipc.gitSetAllowSystem(true);
    this.update({ allowSystem: true });
    await this.refresh();
  }

  async stopUsingSystemGit(): Promise<void> {
    await this.git.ipc.gitSetAllowSystem(false);
    this.update({ allowSystem: false });
    await this.refresh();
  }

  // --- Internals ---

  /** Runs one action: busy while it runs, its result as a notice, failures as an error, then a fresh status. */
  private async act(
    label: string,
    run: () => Promise<unknown>,
    touchesFiles = false,
  ): Promise<boolean> {
    if (this.state.busy !== null) return false;
    this.update({ busy: label, error: null, notice: null });
    try {
      const result = await run();
      const notice = typeof result === "string" && result !== "" ? result : null;
      this.update({ busy: null, notice });
      if (notice !== null) this.git.log(notice);
      await this.refresh();
      if (touchesFiles) await this.filesChanged();
      return true;
    } catch (error) {
      this.update({ busy: null });
      this.fail(String(error));
      await this.refresh();
      return false;
    }
  }

  /** After an action: reload the diff being shown, or close it when the file no longer has that kind of change. */
  private refreshOpenDiff(): void {
    const diff = this.state.diff;
    if (diff === null || diff.commit !== null) return;
    const change = this.status()?.changes.find((entry) => entry.path === diff.path);
    const stillThere =
      change !== undefined &&
      (diff.staged
        ? !change.conflicted && change.index !== "unmodified"
        : change.conflicted || change.worktree !== "unmodified");
    if (change !== undefined && stillThere) {
      void this.openDiff(change, diff.staged, true);
    } else {
      // Don't leave stale diff text on screen: close it and say why.
      this.closeDiff();
      this.events.emit("appNotice", {
        message: `Diff closed: ${diff.path} no longer has ${diff.staged ? "staged" : "unstaged"} changes.`,
      });
    }
  }

  private fail(message: string): void {
    this.update({ error: message });
    this.git.log(`Error: ${message}`);
    this.events.emit("appError", { message });
  }

  private update(patch: Partial<SourceControlState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
