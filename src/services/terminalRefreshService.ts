import { readPrompt } from "./deps/depsWiring";
import type { RuntimeStatus } from "./ipc";
import { terminalPlainText } from "./network/networkWiring";
import type { TerminalService } from "./terminalService";

/** Which active, healthy runtime versions new processes get: `node@24.21.0` ... (sorted). */
export function runtimeFingerprint(runtimes: readonly RuntimeStatus[]): string {
  return runtimes
    .filter((runtime) => runtime.installed.some((version) => version.active && version.healthy))
    .map((runtime) => `${runtime.id}@${runtime.activeVersion ?? ""}`)
    .sort()
    .join(",");
}

/** What changed between two runtime sets, for people: "Node.js 24.21.0", "Python removed". */
export function describeRuntimeChange(
  before: readonly RuntimeStatus[],
  after: readonly RuntimeStatus[],
  removed: (name: string) => string,
): string {
  const active = (list: readonly RuntimeStatus[]) =>
    new Map(
      list
        .filter((runtime) => runtime.installed.some((version) => version.active && version.healthy))
        .map((runtime) => [runtime.id, runtime]),
    );
  const was = active(before);
  const now = active(after);
  const changes: string[] = [];
  for (const [id, runtime] of now) {
    if (was.get(id)?.activeVersion !== runtime.activeVersion) {
      changes.push(`${runtime.displayName} ${runtime.activeVersion ?? ""}`.trim());
    }
  }
  for (const [id, runtime] of was) if (!now.has(id)) changes.push(removed(runtime.displayName));
  return changes.join(", ");
}

export interface TerminalRefreshDeps {
  terminal: Pick<TerminalService, "getState" | "subscribe" | "onOutput" | "restartTerminal">;
  /** Whether a program besides the shell runs in the terminal (`null`: can't tell, so it is left alone). */
  isBusy: (id: string) => Promise<boolean | null>;
  /** The note shown at the top of a restarted terminal. */
  note: (change: string, folder: string) => string;
  /** Told once per change when some terminal is busy and will be refreshed when its program ends. */
  waiting: (titles: string[]) => void;
  /** How often a busy terminal is looked at again (ms). */
  recheckMs?: number;
}

/**
 * Keeps the integrated terminals in step with the portable runtimes. A shell keeps the environment it started with,
 * so a terminal opened before Node.js was installed (or switched, or removed) would not find the new `node`. When the
 * runtimes change, every ordinary terminal that is sitting at its prompt is started again in the folder its prompt
 * showed, in the same tab; one that is running a program is left alone and refreshed once the program has ended.
 * Nothing is ever typed into a shell, and a running program is never killed.
 */
export class TerminalRefreshService {
  private readonly bornWith = new Map<string, string>();
  private readonly folders = new Map<string, string>();
  private current: string | null = null;
  private change = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private refreshing = false;
  private waitingTold = false;

  constructor(private readonly deps: TerminalRefreshDeps) {}

  /** Follows new terminals (the environment they start with, and their prompt's folder). */
  start(fingerprint: string): () => void {
    this.current = fingerprint;
    this.adopt();
    return this.deps.terminal.subscribe(() => {
      this.adopt();
    });
  }

  /** The runtimes changed: terminals started before it are refreshed (now, or when their program ends). */
  async runtimesChanged(fingerprint: string, change: string): Promise<void> {
    if (this.current === null || fingerprint === this.current) return;
    this.current = fingerprint;
    this.change = change;
    this.waitingTold = false;
    await this.refreshStale();
  }

  /** Terminals that still have an older runtime environment. */
  stale(): string[] {
    return this.deps.terminal
      .getState()
      .sessions.filter(
        (session) =>
          session.refreshable === true && !session.exited && this.bornWith.get(session.id) !== this.current,
      )
      .map((session) => session.id);
  }

  async refreshStale(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    const busy: string[] = [];
    try {
      for (const id of this.stale()) {
        const session = this.deps.terminal.getState().sessions.find((candidate) => candidate.id === id);
        if (session === undefined) continue;
        const running = await this.deps.isBusy(id).catch(() => null);
        if (running !== false) {
          if (running === true) busy.push(session.title);
          continue;
        }
        const folder = this.folders.get(id) ?? session.cwd;
        await this.deps.terminal.restartTerminal(id, folder, this.deps.note(this.change, folder));
      }
    } finally {
      this.refreshing = false;
    }
    if (busy.length > 0) {
      if (!this.waitingTold) {
        this.waitingTold = true;
        this.deps.waiting(busy);
      }
      this.schedule();
    }
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refreshStale();
    }, this.deps.recheckMs ?? 3000);
  }

  /** New sessions get the environment in force now; their prompt's folder is followed (the user may `cd`). */
  private adopt(): void {
    for (const session of this.deps.terminal.getState().sessions) {
      if (this.bornWith.has(session.id) || this.current === null) continue;
      this.bornWith.set(session.id, this.current);
      const decoder = new TextDecoder();
      let pending = "";
      this.deps.terminal.onOutput(session.id, (data) => {
        pending += terminalPlainText(decoder.decode(data, { stream: true }));
        const lines = pending.split(/\r?\n|\r/);
        pending = (lines.pop() ?? "").slice(-2000);
        // A prompt can be the unfinished last line; look at it too.
        for (const line of [...lines, pending]) {
          const prompt = readPrompt(line);
          if (prompt?.folder != null) this.folders.set(session.id, prompt.folder);
        }
      });
    }
  }
}
