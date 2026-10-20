import type { GitRemote, GitRef, RemoteInfo } from "./fileGitIpc";
import { shortHash, type FileGitHost, type FileGitService, type GitTarget } from "./fileGitService";
import { commitUrl, fileUri, fileUrl, parseRemote, vscodeDevUrl, type LineSpan, type ParsedRemote } from "./remoteUrls";

/** Open (in the browser) or copy (to the clipboard). */
export type Delivery = "open" | "copy";

interface ChosenRemote {
  remote: GitRemote;
  parsed: ParsedRemote;
}

function sameText(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return a.replace(/\r\n?/g, "\n") === b.replace(/\r\n?/g, "\n");
}

/** The remote a remote-tracking branch belongs to (`origin/feature/x` → `origin`), longest name first. */
export function remoteOfBranch(remotes: GitRemote[], branch: string): GitRemote | null {
  return (
    [...remotes]
      .sort((a, b) => b.name.length - a.name.length)
      .find((remote) => branch.startsWith(`${remote.name}/`)) ?? null
  );
}

/**
 * Web addresses for the file, its lines and its commits on the repository's remote — opened in the browser or copied
 * — and the Copy As items. An address is only made when it is true: the host is one whose scheme is known, the commit
 * is on that remote (a remote-tracking branch contains it), and the file exists in that revision. Otherwise the user
 * is told why, never handed a link that would 404.
 */
export class FileGitRemote {
  constructor(
    private readonly host: FileGitHost,
    private readonly git: FileGitService,
    /** The open folder (for Copy Relative Path), or `null`. */
    private readonly workspaceRoot: () => string | null,
  ) {}

  private t(key: string, params?: Record<string, string | number>): string {
    return this.host.t(key, params);
  }

  private async deliver(url: string, how: Delivery): Promise<void> {
    if (how === "open") {
      await this.host.openUrl(url);
    } else {
      await this.host.copy(url);
      this.host.notice(this.t("gitFile.copied", { text: url }));
    }
  }

  private parse(remote: GitRemote): ParsedRemote {
    const parsed = parseRemote(remote.url);
    if (parsed === null) throw new Error(this.t("gitFile.unsupportedRemote", { name: remote.name, url: remote.url }));
    return parsed;
  }

  /** The upstream's remote, else `origin`, else the only remote, else the user picks. */
  private async chooseRemote(info: RemoteInfo): Promise<ChosenRemote> {
    if (info.remotes.length === 0) throw new Error(this.t("gitFile.noRemote"));
    const upstream = info.upstream ? remoteOfBranch(info.remotes, info.upstream) : null;
    let remote =
      upstream ??
      info.remotes.find((candidate) => candidate.name === "origin") ??
      (info.remotes.length === 1 ? info.remotes[0] : undefined);
    if (remote === undefined) {
      const index = await this.host.pick(
        this.t("gitFile.pickRemote"),
        info.remotes.map((candidate) => ({ label: candidate.name, description: candidate.url })),
      );
      if (index === null) throw new CancelledError();
      remote = info.remotes[index];
    }
    if (remote === undefined) throw new CancelledError();
    return { remote, parsed: this.parse(remote) };
  }

  /** Throws unless `hash` is in a remote-tracking branch of `remote`. */
  private async requirePublished(path: string, hash: string, remote: GitRemote): Promise<void> {
    const branches = await this.host.ipc.published(path, hash);
    if (!branches.some((branch) => branch.startsWith(`${remote.name}/`))) {
      throw new Error(this.t("gitFile.notPublished", { hash: shortHash(hash), remote: remote.name }));
    }
  }

  /** The selected lines, when the editor's text is the revision's (otherwise the numbers would point elsewhere). */
  private lines(target: GitTarget, revisionText: string | null): LineSpan | null {
    const buffer = this.host.bufferText(target.path);
    if (buffer !== null && !sameText(buffer, revisionText)) return null;
    return { start: target.line, end: Math.max(target.line, target.endLine) };
  }

  /** The file at the current commit (a permanent link), with the selected lines. */
  async fileOnRemote(target: GitTarget, how: Delivery): Promise<void> {
    const url = await this.currentFileUrl(target, (parsed, head, relative, lines) =>
      fileUrl(parsed, head, relative, lines),
    );
    await this.deliver(url, how);
  }

  private async currentFileUrl(
    target: GitTarget,
    build: (parsed: ParsedRemote, head: string, relative: string, lines: LineSpan | null) => string | null,
  ): Promise<string> {
    const context = await this.git.context(target.path);
    const info = await this.host.ipc.remotes(target.path);
    if (info.head === null) throw new Error(this.t("gitFile.noHistory"));
    const at = await this.host.ipc.fileAt(target.path, "HEAD");
    if (at.text === null) throw new Error(this.t("gitFile.notCommitted"));
    const chosen = await this.chooseRemote(info);
    await this.requirePublished(target.path, info.head, chosen.remote);
    const url = build(chosen.parsed, info.head, context.relative, this.lines(target, at.text));
    if (url === null) throw new Error(this.t("gitFile.noVscodeDev", { name: chosen.remote.name }));
    return url;
  }

  /** The file on a branch or tag the user picks (which must be on the remote). */
  async fileOnRemoteFrom(target: GitTarget, how: Delivery): Promise<void> {
    const ref = await this.git.pickRef(target.path, this.t("gitFile.pickRemoteRef"), ["remote", "tag"]);
    if (ref === null) return;
    const info = await this.host.ipc.remotes(target.path);
    const { parsed, revision } = await this.refOnRemote(target.path, info, ref);
    const context = await this.git.context(target.path);
    const at = await this.host.ipc.fileAt(target.path, ref.name);
    if (at.text === null) throw new Error(this.t("gitFile.notInRevision", { revision: ref.name }));
    await this.deliver(fileUrl(parsed, revision, context.relative, this.lines(target, at.text)), how);
  }

  private async refOnRemote(
    path: string,
    info: RemoteInfo,
    ref: GitRef,
  ): Promise<ChosenRemote & { revision: string }> {
    if (ref.kind === "remote") {
      const remote = remoteOfBranch(info.remotes, ref.name);
      if (remote === null) throw new Error(this.t("gitFile.noRemote"));
      return { remote, parsed: this.parse(remote), revision: ref.name.slice(remote.name.length + 1) };
    }
    // A tag: its commit must be on the remote (pushed tags can't be checked without the network).
    const chosen = await this.chooseRemote(info);
    await this.requirePublished(path, ref.hash, chosen.remote);
    return { ...chosen, revision: ref.name };
  }

  /** The commit that last changed the line. */
  async commitOnRemote(target: GitTarget, how: Delivery): Promise<void> {
    const line = await this.git.lineCommit(target);
    if (line === null) throw new Error(this.t("gitFile.lineUncommitted"));
    const info = await this.host.ipc.remotes(target.path);
    const chosen = await this.chooseRemote(info);
    await this.requirePublished(target.path, line.hash, chosen.remote);
    await this.deliver(commitUrl(chosen.parsed, line.hash), how);
  }

  /** Share > Copy vscode.dev Link (GitHub repositories, pinned to the current commit). */
  async copyVscodeDevLink(target: GitTarget): Promise<void> {
    const url = await this.currentFileUrl(target, (parsed, head, relative, lines) =>
      vscodeDevUrl(parsed, head, relative, lines),
    );
    await this.deliver(url, "copy");
  }

  /** Copy As > Copy Link to File at Revision...: the file's address on the remote at a commit of its history. */
  async linkAtRevision(target: GitTarget): Promise<void> {
    const commit = await this.git.pickCommit(target.path, this.t("gitFile.pickRevision"));
    if (commit === null) return;
    const info = await this.host.ipc.remotes(target.path);
    const chosen = await this.chooseRemote(info);
    await this.requirePublished(target.path, commit.hash, chosen.remote);
    const relative = commit.path ?? (await this.git.context(target.path)).relative;
    await this.deliver(fileUrl(chosen.parsed, commit.hash, relative, null), "copy");
  }

  /** Copy As > Copy Relative Path (relative to the open folder, in the path's own separator style). */
  async copyRelativePath(target: GitTarget): Promise<void> {
    const root = this.workspaceRoot();
    const relative = root === null ? null : relativeTo(root, target.path);
    if (relative === null) throw new Error(this.t("gitFile.outsideFolder"));
    await this.host.copy(relative);
    this.host.notice(this.t("gitFile.copied", { text: relative }));
  }

  /** Copy As > Copy Link to File: a `file:` address with the line. */
  async copyFileLink(target: GitTarget): Promise<void> {
    const uri = fileUri(target.path, target.line);
    await this.host.copy(uri);
    this.host.notice(this.t("gitFile.copied", { text: uri }));
  }

  async copySha(target: GitTarget): Promise<void> {
    const line = await this.git.lineCommit(target);
    if (line === null) throw new Error(this.t("gitFile.lineUncommitted"));
    await this.host.copy(line.hash);
    this.host.notice(this.t("gitFile.copied", { text: line.hash }));
  }

  async copyMessage(target: GitTarget): Promise<void> {
    const line = await this.git.lineCommit(target);
    if (line === null) throw new Error(this.t("gitFile.lineUncommitted"));
    const details = await this.host.ipc.commit(target.path, line.hash);
    await this.host.copy(details.message);
    this.host.notice(this.t("gitFile.copiedMessage", { hash: shortHash(line.hash) }));
  }
}

/** A user-dismissed picker: not an error to show. */
export class CancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelledError";
  }
}

/** `path` relative to `root` (either separator, case-insensitive drive), or `null` when it isn't inside. */
export function relativeTo(root: string, path: string): string | null {
  const separator = path.includes("\\") ? "\\" : "/";
  const unify = (text: string) => text.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = unify(root);
  const full = unify(path);
  const windows = /^[a-zA-Z]:\//.test(base) || base.startsWith("//");
  const prefix = `${base}/`;
  const inside = windows ? full.toLowerCase().startsWith(prefix.toLowerCase()) : full.startsWith(prefix);
  if (!inside) return null;
  return full.slice(prefix.length).split("/").join(separator);
}
