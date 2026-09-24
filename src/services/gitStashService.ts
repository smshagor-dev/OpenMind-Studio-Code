import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { GitService } from "./gitService";
import type { GitStash } from "./ipc";
import type { Availability } from "./runtimeService";

/** A stash as one line: its message, or Git's own description. */
export function stashTitle(stash: GitStash): string {
  return stash.message ?? stash.description;
}

export interface StashState {
  stashes: GitStash[];
  loaded: boolean;
  busy: string | null;
  error: string | null;
  notice: string | null;
  message: string;
  includeUntracked: boolean;
  /** The stash the user is being asked to drop. */
  pendingDrop: GitStash | null;
}

const INITIAL: StashState = {
  stashes: [],
  loaded: false,
  busy: null,
  error: null,
  notice: null,
  message: "",
  includeUntracked: false,
  pendingDrop: null,
};

/**
 * Stashes: list, stash the current changes (with a message, optionally with
 * untracked files), apply (keeps it), pop (applies and removes it) and drop
 * (deleted for good — only after the confirmation). A conflicting apply/pop
 * shows Git's own message and leaves the conflict for the user: nothing is
 * resolved automatically. Every change refreshes Source Control.
 */
export class GitStashService {
  private state: StashState = INITIAL;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly git: GitService,
    private readonly events: EventBus<AppEvents>,
    /** Re-reads the repository status (`SourceControlService.refresh`). */
    private readonly changed: () => Promise<void>,
    /** Whether the working tree has anything a stash could take (tracked changes, untracked files). */
    private readonly changes: () => { tracked: number; untracked: number },
  ) {}

  getState(): StashState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Whether "Stash Changes" can run, and if not, why. */
  stashState(): Availability {
    if (this.state.busy !== null) return { enabled: false, reason: "Please wait — Git is busy." };
    const { tracked, untracked } = this.changes();
    if (tracked === 0 && untracked === 0) {
      return { enabled: false, reason: "There are no local changes to stash." };
    }
    if (tracked === 0 && !this.state.includeUntracked) {
      return {
        enabled: false,
        reason: 'Only untracked files changed. Tick "Include untracked files" to stash them.',
      };
    }
    return { enabled: true };
  }

  /** Apply, Pop and Drop are disabled only while Git is busy. */
  entryState(): Availability {
    return this.state.busy === null
      ? { enabled: true }
      : { enabled: false, reason: "Please wait — Git is busy." };
  }

  setMessage(message: string): void {
    this.update({ message });
  }

  setIncludeUntracked(includeUntracked: boolean): void {
    this.update({ includeUntracked });
  }

  async load(): Promise<void> {
    try {
      this.update({ stashes: await this.git.ipc.gitStashList(), loaded: true });
    } catch (error) {
      this.fail(String(error));
    }
  }

  async stash(): Promise<boolean> {
    if (!this.stashState().enabled) return false;
    const { message, includeUntracked } = this.state;
    const done = await this.act("Stashing", () =>
      this.git.ipc.gitStashPush(message.trim(), includeUntracked),
    );
    if (done) this.update({ message: "" });
    return done;
  }

  async apply(index: number): Promise<boolean> {
    return this.act("Applying the stash", async () => {
      await this.git.ipc.gitStashApply(index);
      return `Applied stash: ${this.titleOf(index)} (it is kept)`;
    });
  }

  async pop(index: number): Promise<boolean> {
    return this.act("Popping the stash", async () => {
      await this.git.ipc.gitStashPop(index);
      return `Popped stash: ${this.titleOf(index)}`;
    });
  }

  private titleOf(index: number): string {
    const stash = this.state.stashes.find((entry) => entry.index === index);
    return stash ? stashTitle(stash) : `stash@{${String(index)}}`;
  }

  requestDrop(stash: GitStash): void {
    this.update({ pendingDrop: stash });
  }

  cancelDrop(): void {
    if (this.state.pendingDrop !== null) this.update({ pendingDrop: null });
  }

  /** Drops the stash the user just confirmed. */
  async confirmDrop(): Promise<boolean> {
    const stash = this.state.pendingDrop;
    if (stash === null) return false;
    this.update({ pendingDrop: null });
    return this.act("Dropping the stash", async () => {
      await this.git.ipc.gitStashDrop(stash.index, true);
      return `Dropped stash: ${stashTitle(stash)}`;
    });
  }

  reset(): void {
    this.update({ ...INITIAL });
  }

  /** One action: busy, result as a notice, failure as an error (conflicts included), then fresh lists. */
  private async act(label: string, run: () => Promise<unknown>): Promise<boolean> {
    if (this.state.busy !== null) return false;
    this.update({ busy: label, error: null, notice: null });
    let ok = true;
    try {
      const result = await run();
      const first =
        typeof result === "string"
          ? result.split("\n").find((line) => line.trim() !== "")
          : undefined;
      this.update({ notice: first ?? `${label} — done.` });
      if (first !== undefined) this.git.log(first);
    } catch (error) {
      ok = false;
      this.fail(String(error));
    }
    this.update({ busy: null });
    await this.load();
    await this.changed();
    return ok;
  }

  private fail(message: string): void {
    this.update({ error: message });
    this.git.log(`Error: ${message}`);
    this.events.emit("appError", { message });
  }

  private update(patch: Partial<StashState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
