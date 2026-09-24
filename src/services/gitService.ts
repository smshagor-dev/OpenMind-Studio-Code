import type { GitLogEntry, IpcClient } from "./ipc";
import type { OutputService } from "./outputService";
import { stamped } from "./outputService";

export const GIT_CHANNEL = "Git";

/**
 * The Git facade: the backend commands (`IpcClient.git*`) plus the Git output
 * channel. Every command the backend runs arrives as a `git:log` event and is
 * written there — the command label (never a commit message or a long path
 * list), its folder, its output and its exit code. It holds no repository
 * state; `SourceControlService` does.
 */
export class GitService {
  private off: (() => void) | null = null;

  constructor(
    readonly ipc: IpcClient,
    private readonly output: OutputService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async initialize(): Promise<void> {
    this.output.ensureChannel(GIT_CHANNEL);
    this.off?.();
    try {
      this.off = await this.ipc.onGitLog((entry) => {
        this.logEntry(entry);
      });
    } catch (error) {
      this.log(`Git output unavailable: ${String(error)}`);
    }
  }

  dispose(): void {
    this.off?.();
    this.off = null;
  }

  /** One backend command, the way the Git channel shows it. */
  logEntry(entry: GitLogEntry): void {
    this.log(entry.label);
    this.output.append(GIT_CHANNEL, `cwd: ${entry.cwd}`);
    if (entry.stdout !== "") this.output.append(GIT_CHANNEL, entry.stdout);
    if (entry.stderr !== "") this.output.append(GIT_CHANNEL, entry.stderr);
    this.output.append(
      GIT_CHANNEL,
      `exit code: ${entry.code === null ? "none (stopped)" : String(entry.code)}`,
    );
  }

  /** A line of the panel's own (an action's result or failure). */
  log(message: string): void {
    this.output.append(GIT_CHANNEL, stamped(message, this.now()));
  }
}
