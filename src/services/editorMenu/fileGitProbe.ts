import type { FileGitIpc } from "../git/fileGitIpc";
import { parseRemote } from "../git/remoteUrls";

/** What is known about one file's Git standing, for enabling menu items. */
export interface ProbeResult {
  /** `null` while unknown. */
  repository: boolean | null;
  /** Why Git can't be used for the file (not a repository, Git missing, outside the folder ...). */
  problem: string | null;
  tracked: boolean;
  remotes: number;
  /** Remotes on a host OpenMind can build web addresses for. */
  supportedRemotes: number;
  /** A GitHub remote (vscode.dev links). */
  github: boolean;
}

const UNKNOWN: ProbeResult = {
  repository: null,
  problem: null,
  tracked: true,
  remotes: 0,
  supportedRemotes: 0,
  github: false,
};

/** A file's standing is reused this long (a menu, then the command it runs, ask in a row). */
const TTL_MS = 30_000;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The Git facts the editor's menus need (in a repository? tracked? which remotes?), asked in the background and
 * cached briefly per file: a menu opens at once, reads what is known, and redraws when the answer arrives. Nothing
 * here runs while typing — only when a menu opens or a Git command asks.
 */
export class FileGitProbe {
  private readonly results = new Map<string, { at: number; result: ProbeResult; pending: boolean }>();
  private readonly listeners = new Set<() => void>();
  private changes = 0;

  constructor(
    private readonly ipc: FileGitIpc,
    private readonly now: () => number = () => Date.now(),
  ) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Grows with every answer (a snapshot for React). */
  version(): number {
    return this.changes;
  }

  private notify(): void {
    this.changes++;
    for (const listener of this.listeners) listener();
  }

  /** What is known about `path` now; starts a check when nothing (fresh) is known. */
  get(path: string): ProbeResult {
    const entry = this.results.get(path);
    if (entry === undefined || (!entry.pending && this.now() - entry.at > TTL_MS)) {
      void this.check(path, entry?.result ?? UNKNOWN);
      return entry?.result ?? UNKNOWN;
    }
    return entry.result;
  }

  /** Forget everything (a Git operation, a folder change). */
  invalidate(): void {
    this.results.clear();
    this.notify();
  }

  private async check(path: string, previous: ProbeResult): Promise<void> {
    this.results.set(path, { at: this.now(), result: previous, pending: true });
    let result: ProbeResult;
    try {
      const context = await this.ipc.context(path);
      const info = await this.ipc.remotes(path).catch(() => null);
      const parsed = (info?.remotes ?? []).map((remote) => parseRemote(remote.url));
      result = {
        repository: true,
        problem: null,
        tracked: context.tracked,
        remotes: info?.remotes.length ?? 0,
        supportedRemotes: parsed.filter((remote) => remote !== null).length,
        github: parsed.some((remote) => remote?.host === "github"),
      };
    } catch (error) {
      result = { ...UNKNOWN, repository: false, problem: message(error), tracked: false };
    }
    this.results.set(path, { at: this.now(), result, pending: false });
    this.notify();
  }
}

export type GitNeed = "repository" | "tracked" | "remote" | "github";

/** Why a Git action can't run for the file now (`null`: it can, or it isn't known yet). */
export function gitBlocker(
  result: ProbeResult,
  need: GitNeed,
  text: (key: string) => string,
): string | null {
  if (result.repository === null) return null;
  if (!result.repository) return result.problem ?? text("gitFile.notRepository");
  if (need === "repository") return null;
  if (!result.tracked) return text("gitFile.notCommitted");
  if (need === "tracked") return null;
  if (result.remotes === 0) return text("gitFile.noRemote");
  if (result.supportedRemotes === 0) return text("gitFile.noSupportedRemote");
  if (need === "github" && !result.github) return text("gitFile.noGithubRemote");
  return null;
}
