import type { GitChangeKind, GitFileChange, GitRepoStatus } from "./ipc";
import type { Availability } from "./runtimeService";

export interface ChangeGroups {
  staged: GitFileChange[];
  changes: GitFileChange[];
  untracked: GitFileChange[];
}

/** Splits a status into the three groups the view shows (a file can be in both Staged and Changes). */
export function groupChanges(status: GitRepoStatus): ChangeGroups {
  const groups: ChangeGroups = { staged: [], changes: [], untracked: [] };
  for (const change of status.changes) {
    if (change.worktree === "untracked") {
      groups.untracked.push(change);
      continue;
    }
    if (!change.conflicted && change.index !== "unmodified") groups.staged.push(change);
    if (change.conflicted || change.worktree !== "unmodified") groups.changes.push(change);
  }
  return groups;
}

const LETTERS: Record<GitChangeKind, string> = {
  unmodified: "",
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  copied: "C",
  typeChanged: "T",
  unmerged: "U",
  untracked: "U",
};

const WORDS: Record<GitChangeKind, string> = {
  unmodified: "Unmodified",
  modified: "Modified",
  added: "Added",
  deleted: "Deleted",
  renamed: "Renamed",
  copied: "Copied",
  typeChanged: "Type changed",
  unmerged: "Merge conflict",
  untracked: "Untracked",
};

/** The status letter (M, A, D, ...) and its meaning for one side of a change. */
export function badgeFor(
  change: GitFileChange,
  staged: boolean,
): { letter: string; title: string } {
  const kind: GitChangeKind = change.conflicted
    ? "unmerged"
    : staged
      ? change.index
      : change.worktree;
  return { letter: LETTERS[kind], title: WORDS[kind] };
}

export interface CommitInput {
  message: string;
  stagedCount: number;
  busy: boolean;
  identityMissing: boolean;
  conflicts: boolean;
}

/** Pure: whether Commit can run, and if not, why. */
export function commitAvailability(input: CommitInput): Availability {
  if (input.busy) return { enabled: false, reason: "Please wait — Git is busy." };
  if (input.message.trim() === "") return { enabled: false, reason: "Enter a commit message." };
  if (input.conflicts) {
    return { enabled: false, reason: "Resolve the merge conflicts before committing." };
  }
  if (input.stagedCount === 0) {
    return { enabled: false, reason: "There are no staged changes to commit." };
  }
  if (input.identityMissing) {
    return { enabled: false, reason: "Set your name and email for commits first." };
  }
  return { enabled: true };
}

/** `root` + a repo-relative path, in the same slash style as `root` (so the file opens as the same document). */
export function joinRepoPath(root: string, relative: string): string {
  const windows = root.includes("\\") || /^[A-Za-z]:/.test(root);
  const separator = windows ? "\\" : "/";
  const base = (windows ? root.replace(/\//g, "\\") : root).replace(/[\\/]+$/, "");
  return `${base}${separator}${windows ? relative.replace(/\//g, "\\") : relative}`;
}
