import type { GitBlameLine } from "../ipc";
import type { FileCommit, FileGitContext, FileGitIpc, GitRef } from "./fileGitIpc";
import type { GitViewsService } from "./gitViewsService";

/** What a Git action is about: a file and the line (or lines) the user right-clicked or selected. */
export interface GitTarget {
  /** Absolute path of the file. */
  path: string;
  /** 1-based. */
  line: number;
  endLine: number;
}

export interface PickItem {
  label: string;
  description?: string;
  detail?: string;
}

/** Everything the Git actions need from the app; tests pass fakes. */
export interface FileGitHost {
  ipc: FileGitIpc;
  views: GitViewsService;
  /** The text of the file's open editor buffer (unsaved edits included), or `null` when it isn't open. */
  bufferText: (path: string) => string | null;
  pick: (placeholder: string, items: PickItem[]) => Promise<number | null>;
  copy: (text: string) => Promise<void>;
  openUrl: (url: string) => Promise<void>;
  /** Opens a file's text at a revision in a read-only tab. */
  openRevision: (path: string, revision: string, relative: string, text: string) => void;
  notice: (message: string) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

/** How long a file's blame is reused (menus and annotations ask several times in a row). */
const BLAME_TTL_MS = 10_000;
/** How far back the line actions look for a commit in the file's history. */
const HISTORY_SEARCH_LIMIT = 2000;
const PICK_LIMIT = 200;

export function shortHash(hash: string): string {
  return hash.slice(0, 7);
}

function sameText(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return a.replace(/\r\n?/g, "\n") === b.replace(/\r\n?/g, "\n");
}

function fileName(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

export function formatDate(seconds: number): string {
  if (seconds <= 0) return "";
  return new Date(seconds * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * The editor's per-file Git actions: compare a line's or the file's changes with earlier revisions, branches and
 * tags, show the commit behind a line, and the helpers the history views use. Every result comes from the file's own
 * repository through the backend; a working-file side is the editor's buffer, so unsaved edits are included.
 */
export class FileGitService {
  private readonly blames = new Map<string, { at: number; lines: Promise<GitBlameLine[]> }>();

  constructor(private readonly host: FileGitHost) {}

  private t(key: string, params?: Record<string, string | number>): string {
    return this.host.t(key, params);
  }

  async context(path: string): Promise<FileGitContext> {
    return this.host.ipc.context(path);
  }

  commitDetails(path: string, hash: string) {
    return this.host.ipc.commit(path, hash);
  }

  /** The file's blame (saved file), cached briefly. */
  blame(path: string): Promise<GitBlameLine[]> {
    const cached = this.blames.get(path);
    if (cached && Date.now() - cached.at < BLAME_TTL_MS) return cached.lines;
    const lines = this.host.ipc.blame(path);
    this.blames.set(path, { at: Date.now(), lines });
    lines.catch(() => this.blames.delete(path));
    return lines;
  }

  /** Forget cached blame (the file was saved, changed on disk, or a Git operation ran). */
  invalidate(path?: string): void {
    if (path === undefined) this.blames.clear();
    else this.blames.delete(path);
  }

  /** The commit that last changed `line`, or `null` when the line isn't committed yet. */
  async lineCommit(target: GitTarget): Promise<GitBlameLine | null> {
    const lines = await this.blame(target.path);
    const line = lines.find((entry) => entry.line === target.line);
    if (line === undefined) throw new Error(this.t("gitFile.lineNotInBlame"));
    return line.committed ? line : null;
  }

  private async requireLineCommit(target: GitTarget): Promise<GitBlameLine> {
    const line = await this.lineCommit(target);
    if (line === null) throw new Error(this.t("gitFile.lineUncommitted"));
    return line;
  }

  private working(path: string, saved: string | null): string | null {
    return this.host.bufferText(path) ?? saved;
  }

  /** Where `hash` is in the file's history (renames followed): the file's name there and in the commit before. */
  private async namesAround(path: string, hash: string, current: string): Promise<{ at: string; before: string | null }> {
    let skip = 0;
    while (skip < HISTORY_SEARCH_LIMIT) {
      const page = await this.host.ipc.log(path, skip, 200);
      const index = page.commits.findIndex((commit) => commit.hash === hash);
      if (index >= 0) {
        const at = page.commits[index]?.path ?? current;
        const next = page.commits[index + 1] ?? (page.more ? (await this.host.ipc.log(path, skip + index + 1, 1)).commits[0] : undefined);
        return { at, before: next ? (next.path ?? at) : null };
      }
      if (!page.more) break;
      skip += page.commits.length;
    }
    return { at: current, before: current };
  }

  /** Open Line Changes with Previous Revision: the commit that last changed the line, against its parent. */
  async lineChangesWithPrevious(target: GitTarget): Promise<void> {
    const line = await this.lineCommit(target);
    if (line === null) {
      await this.changesWithPrevious(target);
      return;
    }
    const context = await this.context(target.path);
    const names = await this.namesAround(target.path, line.hash, context.relative);
    const [before, after] = await Promise.all([
      names.before === null
        ? Promise.resolve({ text: null })
        : this.host.ipc.fileAt(target.path, `${line.hash}^`, names.before),
      this.host.ipc.fileAt(target.path, line.hash, names.at),
    ]);
    const short = shortHash(line.hash);
    this.host.views.showCompare({
      title: `${fileName(target.path)} (${short}^ ↔ ${short})`,
      leftLabel: `${short}^`,
      rightLabel: `${short} · ${line.summary}`,
      original: before.text,
      modified: after.text,
      path: target.path,
      revealLine: line.originalLine,
    });
  }

  /** Open Line Changes with Working File: the line's last commit against the editor's text. */
  async lineChangesWithWorking(target: GitTarget): Promise<void> {
    const line = await this.lineCommit(target);
    if (line === null) {
      await this.changesWithPrevious(target);
      return;
    }
    const context = await this.context(target.path);
    const names = await this.namesAround(target.path, line.hash, context.relative);
    const at = await this.host.ipc.fileAt(target.path, line.hash, names.at);
    const short = shortHash(line.hash);
    this.host.views.showCompare({
      title: `${fileName(target.path)} (${short} ↔ ${this.t("gitFile.working")})`,
      leftLabel: `${short} · ${line.summary}`,
      rightLabel: this.t("gitFile.working"),
      original: at.text,
      modified: this.working(target.path, null),
      path: target.path,
      revealLine: target.line,
    });
  }

  /** Open Changes with Previous Revision: uncommitted edits against HEAD, else the last commit against its parent. */
  async changesWithPrevious(target: GitTarget): Promise<void> {
    const context = await this.context(target.path);
    const head = await this.host.ipc.fileAt(target.path, "HEAD");
    if (head.text === null && !context.tracked) throw new Error(this.t("gitFile.notCommitted"));
    const working = this.working(target.path, head.text);
    if (!sameText(working, head.text)) {
      this.host.views.showCompare({
        title: `${fileName(target.path)} (HEAD ↔ ${this.t("gitFile.working")})`,
        leftLabel: "HEAD",
        rightLabel: this.t("gitFile.working"),
        original: head.text,
        modified: working,
        path: target.path,
        revealLine: target.line,
      });
      return;
    }
    const page = await this.host.ipc.log(target.path, 0, 2);
    const last = page.commits[0];
    if (last === undefined) throw new Error(this.t("gitFile.noHistory"));
    await this.showCommitChange(target.path, last, page.commits[1] ?? null, target.line);
  }

  /** A commit's version of the file against the version before it. */
  async showCommitChange(path: string, commit: FileCommit, previous: FileCommit | null, line: number | null): Promise<void> {
    const name = commit.path ?? (await this.context(path)).relative;
    const [before, after] = await Promise.all([
      previous === null
        ? Promise.resolve({ text: null })
        : this.host.ipc.fileAt(path, `${commit.hash}^`, previous.path ?? name),
      this.host.ipc.fileAt(path, commit.hash, name),
    ]);
    this.host.views.showCompare({
      title: `${fileName(path)} (${commit.shortHash}^ ↔ ${commit.shortHash})`,
      leftLabel: `${commit.shortHash}^`,
      rightLabel: `${commit.shortHash} · ${commit.subject}`,
      original: before.text,
      modified: after.text,
      path,
      revealLine: line,
    });
  }

  /** A commit's version of the file against the editor's text. */
  async compareCommitWithWorking(path: string, commit: FileCommit, line: number | null): Promise<void> {
    const name = commit.path ?? (await this.context(path)).relative;
    const at = await this.host.ipc.fileAt(path, commit.hash, name);
    this.host.views.showCompare({
      title: `${fileName(path)} (${commit.shortHash} ↔ ${this.t("gitFile.working")})`,
      leftLabel: `${commit.shortHash} · ${commit.subject}`,
      rightLabel: this.t("gitFile.working"),
      original: at.text,
      modified: this.working(path, null),
      path,
      revealLine: line,
    });
  }

  /** Opens the file as it was in `commit` in a read-only tab. */
  async openAtCommit(path: string, commit: FileCommit): Promise<void> {
    const name = commit.path ?? (await this.context(path)).relative;
    const at = await this.host.ipc.fileAt(path, commit.hash, name);
    if (at.text === null) throw new Error(this.t("gitFile.notInRevision", { revision: commit.shortHash }));
    this.host.openRevision(path, commit.hash, name, at.text);
  }

  /** The file's history as pick items (newest first, up to one page). */
  async pickCommit(path: string, placeholder: string): Promise<FileCommit | null> {
    const page = await this.host.ipc.log(path, 0, PICK_LIMIT);
    if (page.commits.length === 0) throw new Error(this.t("gitFile.noHistory"));
    const index = await this.host.pick(
      placeholder,
      page.commits.map((commit) => ({
        label: `${commit.shortHash}  ${commit.subject}`,
        description: commit.author,
        detail: [formatDate(commit.authorTime), commit.path ?? ""].filter(Boolean).join(" · "),
      })),
    );
    return index === null ? null : (page.commits[index] ?? null);
  }

  /** Open Changes with Revision...: a commit of the file's history against the editor's text. */
  async changesWithRevision(target: GitTarget): Promise<void> {
    const commit = await this.pickCommit(target.path, this.t("gitFile.pickRevision"));
    if (commit) await this.compareCommitWithWorking(target.path, commit, target.line);
  }

  async pickRef(path: string, placeholder: string, kinds: GitRef["kind"][]): Promise<GitRef | null> {
    const refs = (await this.host.ipc.refs(path)).filter((ref) => kinds.includes(ref.kind));
    if (refs.length === 0) throw new Error(this.t("gitFile.noRefs"));
    const index = await this.host.pick(
      placeholder,
      refs.map((ref) => ({
        label: ref.name,
        description: this.t(`gitFile.refKind.${ref.kind}`),
        detail: `${shortHash(ref.hash)} · ${formatDate(ref.time)}`,
      })),
    );
    return index === null ? null : (refs[index] ?? null);
  }

  /** Open Changes with Branch or Tag...: the file on a branch or tag against the editor's text. */
  async changesWithBranchOrTag(target: GitTarget): Promise<void> {
    const ref = await this.pickRef(target.path, this.t("gitFile.pickRef"), ["branch", "remote", "tag"]);
    if (ref === null) return;
    const at = await this.host.ipc.fileAt(target.path, ref.name);
    if (at.text === null) this.host.notice(this.t("gitFile.notInRevision", { revision: ref.name }));
    this.host.views.showCompare({
      title: `${fileName(target.path)} (${ref.name} ↔ ${this.t("gitFile.working")})`,
      leftLabel: ref.name,
      rightLabel: this.t("gitFile.working"),
      original: at.text,
      modified: this.working(target.path, null),
      path: target.path,
      revealLine: target.line,
    });
  }

  /** Quick Show Line Commit / Inspect Line Commit Details. */
  async showLineCommit(target: GitTarget, compact: boolean): Promise<void> {
    const line = await this.requireLineCommit(target);
    await this.host.views.showCommit(target.path, line.hash, compact, target.line);
  }

  /** Quick Open File History: pick a commit, then what to do with it. */
  async quickOpenHistory(target: GitTarget): Promise<void> {
    const commit = await this.pickCommit(target.path, this.t("gitFile.pickHistory"));
    if (commit === null) return;
    const actions = [
      "gitFile.action.changes",
      "gitFile.action.working",
      "gitFile.action.open",
      "gitFile.action.details",
    ];
    const choice = await this.host.pick(
      `${commit.shortHash} ${commit.subject}`,
      actions.map((key) => ({ label: this.t(key) })),
    );
    if (choice === 0) await this.showCommitChange(target.path, commit, await this.previousOf(target.path, commit), null);
    else if (choice === 1) await this.compareCommitWithWorking(target.path, commit, target.line);
    else if (choice === 2) await this.openAtCommit(target.path, commit);
    else if (choice === 3) await this.host.views.showCommit(target.path, commit.hash, false, null);
  }

  /** The commit of the file's history before `commit` (renames followed), or `null` for its first commit. */
  async previousOf(path: string, commit: FileCommit): Promise<FileCommit | null> {
    let skip = 0;
    while (skip < HISTORY_SEARCH_LIMIT) {
      const page = await this.host.ipc.log(path, skip, 200);
      const index = page.commits.findIndex((entry) => entry.hash === commit.hash);
      if (index >= 0) {
        const next = page.commits[index + 1];
        if (next) return next;
        return page.more ? ((await this.host.ipc.log(path, skip + index + 1, 1)).commits[0] ?? null) : null;
      }
      if (!page.more) return null;
      skip += page.commits.length;
    }
    return null;
  }
}
