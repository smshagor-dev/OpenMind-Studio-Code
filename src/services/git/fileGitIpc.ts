import { invoke } from "@tauri-apps/api/core";

import type { GitBlameLine, GitCommitFile } from "../ipc";

/** Where a file stands in Git (its own repository: a nested one or a worktree too). */
export interface FileGitContext {
  root: string;
  name: string;
  /** Repo-relative, forward slashes. */
  relative: string;
  tracked: boolean;
}

export interface FileCommit {
  hash: string;
  shortHash: string;
  parents: string[];
  author: string;
  email: string;
  /** Seconds since the Unix epoch. */
  authorTime: number;
  committer: string;
  commitTime: number;
  subject: string;
  /** The file's repo-relative name in this commit (renames are followed). */
  path: string | null;
  additions: number | null;
  deletions: number | null;
}

export interface FileLogPage {
  commits: FileCommit[];
  more: boolean;
}

export type GitRefKind = "branch" | "remote" | "tag";

export interface GitRef {
  name: string;
  kind: GitRefKind;
  hash: string;
  time: number;
}

export interface GitRemote {
  name: string;
  url: string;
}

export interface RemoteInfo {
  remotes: GitRemote[];
  branch: string | null;
  upstream: string | null;
  head: string | null;
}

export interface CommitDetails {
  hash: string;
  parents: string[];
  author: string;
  authorEmail: string;
  authorTime: number;
  committer: string;
  committerEmail: string;
  commitTime: number;
  message: string;
  files: GitCommitFile[];
}

/** The per-file Git commands; every one takes the file's absolute path (it must be inside the open folder). */
export interface FileGitIpc {
  context: (path: string) => Promise<FileGitContext>;
  log: (path: string, skip: number, limit: number) => Promise<FileLogPage>;
  /** `relative`: the file's name in that revision, when it was renamed since. */
  fileAt: (path: string, revision: string, relative?: string | null) => Promise<{ text: string | null }>;
  refs: (path: string) => Promise<GitRef[]>;
  remotes: (path: string) => Promise<RemoteInfo>;
  published: (path: string, hash: string) => Promise<string[]>;
  resolve: (path: string, revision: string) => Promise<string | null>;
  commit: (path: string, hash: string) => Promise<CommitDetails>;
  blame: (path: string) => Promise<GitBlameLine[]>;
}

export const tauriFileGitIpc: FileGitIpc = {
  context: (path) => invoke("git_file_context", { path }),
  log: (path, skip, limit) => invoke("git_file_log", { path, skip, limit }),
  fileAt: (path, revision, relative) =>
    invoke("git_file_at", { path, revision, relative: relative ?? null }),
  refs: (path) => invoke("git_file_refs", { path }),
  remotes: (path) => invoke("git_file_remotes", { path }),
  published: (path, hash) => invoke("git_file_published", { path, hash }),
  resolve: (path, revision) => invoke("git_file_resolve", { path, revision }),
  commit: (path, hash) => invoke("git_file_commit", { path, hash }),
  blame: (path) => invoke("git_file_blame", { path }),
};

/** All zeros: a line that isn't committed yet. */
export const UNCOMMITTED = "0".repeat(40);
