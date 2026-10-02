import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { IpcClient, ShellInfo, ShellKind } from "./ipc";
import type { PanelService } from "./panelService";
import { safely } from "./safely";

export interface TerminalSession {
  id: string;
  shell: ShellKind;
  title: string;
  cwd: string;
  /** The shell process ended (typed `exit`, crashed, ...); the tab stays until the user closes it. */
  exited: boolean;
  exitCode: number | null;
  /**
   * An ordinary shell the app may start again in its folder when the runtimes change (it would keep a stale PATH).
   * Never a task's program or a terminal an extension owns (the extension holds its id).
   */
  refreshable?: boolean;
}

export interface TerminalState {
  sessions: TerminalSession[];
  activeId: string | null;
  /** Every shell this machine actually has — unavailable ones are never listed. */
  shells: ShellInfo[];
  lastShell: ShellKind | null;
}

/** Where a session's output goes; implemented by the xterm-hosting component. */
export interface TerminalSink {
  write: (data: Uint8Array) => void;
  clear: () => void;
  /** The text the user has selected in this terminal view (empty when nothing is). */
  selection?: () => string;
}

const STATE_KEY = "terminal.state";
const INITIAL_COLS = 80;
const INITIAL_ROWS = 24;

interface PersistedState {
  lastShell: ShellKind | null;
}

const EMPTY_STATE: TerminalState = {
  sessions: [],
  activeId: null,
  shells: [],
  lastShell: null,
};

/**
 * Owns the integrated terminal's UI-facing state — the session list and the
 * active session — and drives the Rust PTY backend over IPC.
 * The shells themselves (processes, output, process-tree cleanup) live in
 * `openmind-terminal`; this class only mirrors them. Raw output is never stored
 * or persisted: it's handed to whichever `TerminalSink` is attached, buffered
 * only for the instant between a session being created and its view attaching.
 * No terminal is ever started except by an explicit user action.
 */
export class TerminalService {
  private state: TerminalState = EMPTY_STATE;
  private readonly listeners = new Set<() => void>();
  private readonly sinks = new Map<string, TerminalSink>();
  private readonly inputTaps = new Set<(id: string, data: string) => void>();
  /** Listeners of a session's raw output (a task's problem matchers read it). */
  private readonly taps = new Map<string, Set<(data: Uint8Array) => void>>();
  /** Callers waiting for a session to end (a task chain waits for each step). */
  private readonly exitWaiters = new Map<string, ((code: number | null) => void)[]>();
  private readonly pending = new Map<string, Uint8Array[]>();
  /** Sessions the user closed, so late output from their dying process is dropped, not buffered. */
  private readonly closedIds = new Set<string>();
  private readonly unsubscribers: (() => void)[] = [];
  private disposed = false;

  constructor(
    private readonly ipc: IpcClient,
    private readonly events: EventBus<AppEvents>,
    /** The workspace folder new terminals should start in, if one is open. */
    private readonly getCwd: () => string | null,
    /** The bottom panel these terminals live in (shown on create, hidden when the last one closes). */
    private readonly panel: PanelService,
    /** Where terminal lifecycle events are logged (the Output panel's "Terminal" channel). */
    private readonly log: (line: string) => void = () => undefined,
  ) {}

  getState(): TerminalState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async initialize(): Promise<void> {
    const saved = await this.ipc.settingsGet(STATE_KEY).catch(() => null);
    const persisted = saved === null ? null : parsePersisted(saved);
    const shells = await safely(
      this.events,
      () => this.ipc.terminalListShells(),
      "detect available shells",
      [],
    );
    const availableShells = shells.filter((shell) => shell.available);
    const lastShell = availableShells.some((shell) => shell.kind === persisted?.lastShell)
      ? (persisted?.lastShell ?? null)
      : null;
    this.update({ shells: availableShells, lastShell });

    const offs = await Promise.all([
      this.ipc.onTerminalOutput((id, data) => {
        this.handleOutput(id, data);
      }),
      this.ipc.onTerminalExit((id, code) => {
        this.handleExit(id, code);
      }),
    ]).catch((error: unknown) => {
      this.events.emit("appError", { message: `Terminal events unavailable: ${String(error)}` });
      return [];
    });
    this.unsubscribers.push(...offs);
    if (this.disposed) this.dispose();
  }

  /**
   * Opens a new terminal (in the open workspace folder, if any) and shows the panel. `options.show: false` keeps the
   * panel as it is (an extension's terminal: the panel never opens by itself); `options.title` names the tab.
   */
  async createTerminal(
    shell?: ShellKind,
    cwdOverride?: string | null,
    options: { title?: string; show?: boolean; refreshable?: boolean } = {},
  ): Promise<string | null> {
    if (shell !== undefined && !this.state.shells.some((candidate) => candidate.kind === shell)) {
      // Only shells found on this machine are ever offered, so this is a stale or foreign request.
      this.events.emit("appError", {
        message: "Can't start a terminal: that shell isn't available on this machine.",
      });
      return null;
    }
    const kind = shell ?? this.state.lastShell;
    const cwd = cwdOverride ?? this.getCwd();
    const info = await safely(
      this.events,
      () => this.ipc.terminalCreate(kind, cwd, INITIAL_COLS, INITIAL_ROWS),
      "start a terminal",
      null,
    );
    if (info === null) {
      return null;
    }
    const label = this.state.shells.find((candidate) => candidate.kind === info.shell)?.label;
    const sameShell = this.state.sessions.filter((session) => session.shell === info.shell).length;
    const session: TerminalSession = {
      id: info.id,
      shell: info.shell,
      title:
        options.title ??
        (sameShell === 0 ? (label ?? info.shell) : `${label ?? info.shell} (${sameShell + 1})`),
      cwd: info.cwd,
      exited: false,
      exitCode: null,
      refreshable: options.refreshable ?? true,
    };
    this.update({
      sessions: [...this.state.sessions, session],
      activeId: session.id,
      lastShell: info.shell,
    });
    this.log(`Started ${session.title} in ${session.cwd}`);
    if (options.show !== false) await this.panel.show("terminal");
    await this.persist();
    return session.id;
  }

  /**
   * A terminal that runs one task step as its own program (started by `start`, which asks the backend). It shows
   * the panel only when `show` is true (the user just confirmed the task). Returns the session id, or null.
   */
  async createTaskTerminal(
    title: string,
    start: (cols: number, rows: number) => Promise<{ id: string; shell: ShellKind; cwd: string }>,
    show: boolean,
  ): Promise<string | null> {
    let info: { id: string; shell: ShellKind; cwd: string };
    try {
      info = await start(INITIAL_COLS, INITIAL_ROWS);
    } catch (error) {
      this.events.emit("appError", {
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    const session: TerminalSession = {
      id: info.id,
      shell: info.shell,
      title,
      cwd: info.cwd,
      exited: false,
      exitCode: null,
    };
    this.update({ sessions: [...this.state.sessions, session], activeId: session.id });
    this.log(`Started ${title} in ${session.cwd}`);
    if (show) await this.panel.show("terminal");
    return session.id;
  }

  /** Listens to a session's raw output. */
  onOutput(id: string, listener: (data: Uint8Array) => void): () => void {
    const set = this.taps.get(id) ?? new Set<(data: Uint8Array) => void>();
    set.add(listener);
    this.taps.set(id, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.taps.delete(id);
    };
  }

  /** Resolves with the exit code when the session ends (or null when it is closed or unknown). */
  waitForExit(id: string): Promise<number | null> {
    const session = this.state.sessions.find((candidate) => candidate.id === id);
    if (!session) return Promise.resolve(null);
    if (session.exited) return Promise.resolve(session.exitCode);
    return new Promise((resolve) => {
      this.exitWaiters.set(id, [...(this.exitWaiters.get(id) ?? []), resolve]);
    });
  }

  private settle(id: string, code: number | null): void {
    const waiters = this.exitWaiters.get(id) ?? [];
    this.exitWaiters.delete(id);
    for (const resolve of waiters) resolve(code);
  }

  /** Kills that terminal's process tree and removes it; closing the last one hides the panel. */
  async closeTerminal(id: string): Promise<void> {
    const index = this.state.sessions.findIndex((session) => session.id === id);
    if (index === -1) {
      return;
    }
    const sessions = this.state.sessions.filter((session) => session.id !== id);
    const activeId =
      this.state.activeId === id
        ? (sessions[index]?.id ?? sessions[index - 1]?.id ?? null)
        : this.state.activeId;
    this.log(`Closed ${this.state.sessions[index]?.title ?? "terminal"}`);
    this.sinks.delete(id);
    this.pending.delete(id);
    this.taps.delete(id);
    this.closedIds.add(id);
    this.settle(id, null);
    this.update({ sessions, activeId });
    await safely(this.events, () => this.ipc.terminalClose(id), "close the terminal", undefined);
    if (sessions.length === 0 && this.panel.getState().activeTab === "terminal") {
      // Closing the last terminal closes the panel, like VS Code.
      await this.panel.hide();
    }
    await this.persist();
  }

  /**
   * Starts the same shell again in `cwd` in place of `id`: same tab position and title, still active if it was, and
   * `note` shown at the top of the new view (written to the screen only, never typed into the shell). The new shell
   * starts first; if it can't, the old terminal is kept. Returns the new session id.
   */
  async restartTerminal(id: string, cwd: string, note?: string): Promise<string | null> {
    const index = this.state.sessions.findIndex((session) => session.id === id);
    const old = this.state.sessions[index];
    if (old === undefined) return null;
    const info = await safely(
      this.events,
      () => this.ipc.terminalCreate(old.shell, cwd, INITIAL_COLS, INITIAL_ROWS),
      "restart the terminal",
      null,
    );
    if (info === null) return null;
    if (note !== undefined) this.pending.set(info.id, [new TextEncoder().encode(`\x1b[2m${note}\x1b[0m\r\n`)]);
    const replacement: TerminalSession = { ...old, id: info.id, cwd: info.cwd, exited: false, exitCode: null };
    const sessions = this.state.sessions.map((session) => (session.id === id ? replacement : session));
    this.sinks.delete(id);
    this.pending.delete(id);
    this.taps.delete(id);
    this.closedIds.add(id);
    this.settle(id, null);
    this.update({ sessions, activeId: this.state.activeId === id ? info.id : this.state.activeId });
    this.log(`Restarted ${old.title} in ${info.cwd}`);
    await safely(this.events, () => this.ipc.terminalClose(id), "close the old terminal", undefined);
    return info.id;
  }

  async closeActive(): Promise<void> {
    if (this.state.activeId) {
      await this.closeTerminal(this.state.activeId);
    }
  }

  /** Closes every terminal (each one's process tree is ended by the backend). */
  async closeAll(): Promise<void> {
    for (const session of [...this.state.sessions]) {
      await this.closeTerminal(session.id);
    }
  }

  setActive(id: string): void {
    if (this.state.activeId !== id && this.state.sessions.some((session) => session.id === id)) {
      this.update({ activeId: id });
    }
  }

  /** Ctrl+`: hide the panel if the terminal is showing; otherwise show the terminal, starting one only if there is none. */
  async togglePanel(): Promise<void> {
    const panel = this.panel.getState();
    if (panel.visible && panel.activeTab === "terminal") {
      await this.panel.hide();
      return;
    }
    if (this.state.sessions.length === 0) {
      await this.createTerminal();
      return;
    }
    await this.panel.show("terminal");
  }

  /** Whether the terminal tab is what the bottom panel is showing right now. */
  isShowing(): boolean {
    const panel = this.panel.getState();
    return panel.visible && panel.activeTab === "terminal";
  }

  /** Listens to what is typed or pasted into any terminal (the network card replays a failed command from it). */
  onInput(listener: (id: string, data: string) => void): () => void {
    this.inputTaps.add(listener);
    return () => {
      this.inputTaps.delete(listener);
    };
  }

  write(id: string, data: string): void {
    // An exited shell has no stdin left; typing into its tab is a quiet no-op, not an error toast.
    if (this.state.sessions.some((session) => session.id === id && session.exited)) {
      return;
    }
    for (const tap of [...this.inputTaps]) tap(id, data);
    void safely(this.events, () => this.ipc.terminalWrite(id, data), "send input", undefined);
  }

  resize(id: string, cols: number, rows: number): void {
    void safely(this.events, () => this.ipc.terminalResize(id, cols, rows), "resize", undefined);
  }

  /** Copies terminal text to the system clipboard; a failure is reported, not swallowed. */
  /** The text selected in the active terminal (empty when nothing is): the AI's "explain terminal error" reads it. */
  activeSelection(): string {
    const id = this.state.activeId;
    return (id === null ? undefined : this.sinks.get(id))?.selection?.() ?? "";
  }

  async copyToClipboard(text: string): Promise<void> {
    if (text === "") {
      return;
    }
    await safely(
      this.events,
      () => this.ipc.clipboardWriteText(text),
      "copy to the clipboard",
      undefined,
    );
  }

  /** The clipboard's text, for the view of the terminal being pasted into (never any other). */
  async readClipboard(): Promise<string> {
    return safely(this.events, () => this.ipc.clipboardReadText(), "read the clipboard", "");
  }

  clear(id: string): void {
    this.sinks.get(id)?.clear();
  }

  clearActive(): void {
    if (this.state.activeId) {
      this.clear(this.state.activeId);
    }
  }

  /** Attaches the view for `id`; anything that arrived before it existed is flushed into it first. */
  attachSink(id: string, sink: TerminalSink): () => void {
    this.sinks.set(id, sink);
    for (const chunk of this.pending.get(id) ?? []) {
      sink.write(chunk);
    }
    this.pending.delete(id);
    return () => {
      if (this.sinks.get(id) === sink) {
        this.sinks.delete(id);
      }
    };
  }

  dispose(): void {
    this.disposed = true;
    for (const off of this.unsubscribers.splice(0)) {
      off();
    }
  }

  private handleOutput(id: string, data: Uint8Array): void {
    for (const tap of this.taps.get(id) ?? []) tap(data);
    const sink = this.sinks.get(id);
    if (sink) {
      sink.write(data);
    } else if (!this.closedIds.has(id)) {
      // Output can land after `create` returns but before the view attaches (or
      // before the session is even recorded); keep it for that view.
      this.pending.set(id, [...(this.pending.get(id) ?? []), data]);
    }
  }

  private handleExit(id: string, code: number | null): void {
    if (!this.state.sessions.some((session) => session.id === id)) {
      return;
    }
    const exited = this.state.sessions.find((session) => session.id === id);
    this.log(
      `${exited?.title ?? "Terminal"} exited${code === null ? "" : ` with code ${String(code)}`}`,
    );
    this.update({
      sessions: this.state.sessions.map((session) =>
        session.id === id ? { ...session, exited: true, exitCode: code } : session,
      ),
    });
    this.settle(id, code);
  }

  private update(patch: Partial<TerminalState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) {
      listener();
    }
  }

  private async persist(): Promise<void> {
    const persisted: PersistedState = { lastShell: this.state.lastShell };
    await this.ipc.settingsSet(STATE_KEY, JSON.stringify(persisted)).catch(() => undefined);
  }
}

function parsePersisted(raw: string): PersistedState | null {
  try {
    const value = JSON.parse(raw) as Partial<PersistedState>;
    return {
      lastShell: typeof value.lastShell === "string" ? value.lastShell : null,
    };
  } catch {
    return null;
  }
}
