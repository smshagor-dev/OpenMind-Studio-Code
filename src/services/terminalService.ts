import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { IpcClient, ShellInfo, ShellKind } from "./ipc";
import { safely } from "./safely";

export interface TerminalSession {
  id: string;
  shell: ShellKind;
  title: string;
  cwd: string;
  /** The shell process ended (typed `exit`, crashed, ...); the tab stays until the user closes it. */
  exited: boolean;
  exitCode: number | null;
}

export interface TerminalState {
  panelVisible: boolean;
  panelHeight: number;
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
}

export const DEFAULT_PANEL_HEIGHT = 260;
export const PANEL_MIN_HEIGHT = 120;
export const PANEL_MAX_HEIGHT = 900;

const STATE_KEY = "terminal.state";
const INITIAL_COLS = 80;
const INITIAL_ROWS = 24;

interface PersistedState {
  panelVisible: boolean;
  panelHeight: number;
  lastShell: ShellKind | null;
}

const EMPTY_STATE: TerminalState = {
  panelVisible: false,
  panelHeight: DEFAULT_PANEL_HEIGHT,
  sessions: [],
  activeId: null,
  shells: [],
  lastShell: null,
};

/**
 * Owns the integrated terminal's UI-facing state — panel visibility/height, the
 * session list, the active session — and drives the Rust PTY backend over IPC.
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
    this.update({
      shells: availableShells,
      lastShell,
      panelVisible: persisted?.panelVisible ?? false,
      panelHeight: persisted?.panelHeight ?? DEFAULT_PANEL_HEIGHT,
    });

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

  /** Opens a new terminal (in the open workspace folder, if any) and shows the panel. */
  async createTerminal(shell?: ShellKind): Promise<string | null> {
    if (shell !== undefined && !this.state.shells.some((candidate) => candidate.kind === shell)) {
      // Only shells found on this machine are ever offered, so this is a stale or foreign request.
      this.events.emit("appError", {
        message: "Can't start a terminal: that shell isn't available on this machine.",
      });
      return null;
    }
    const kind = shell ?? this.state.lastShell;
    const cwd = this.getCwd();
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
      title: sameShell === 0 ? (label ?? info.shell) : `${label ?? info.shell} (${sameShell + 1})`,
      cwd: info.cwd,
      exited: false,
      exitCode: null,
    };
    this.update({
      sessions: [...this.state.sessions, session],
      activeId: session.id,
      panelVisible: true,
      lastShell: info.shell,
    });
    await this.persist();
    return session.id;
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
    this.sinks.delete(id);
    this.pending.delete(id);
    this.closedIds.add(id);
    this.update({
      sessions,
      activeId,
      panelVisible: sessions.length > 0 && this.state.panelVisible,
    });
    await safely(this.events, () => this.ipc.terminalClose(id), "close the terminal", undefined);
    await this.persist();
  }

  async closeActive(): Promise<void> {
    if (this.state.activeId) {
      await this.closeTerminal(this.state.activeId);
    }
  }

  setActive(id: string): void {
    if (this.state.activeId !== id && this.state.sessions.some((session) => session.id === id)) {
      this.update({ activeId: id });
    }
  }

  /** Ctrl+`: hide the panel if shown; otherwise show it, starting a terminal only if there is none. */
  async togglePanel(): Promise<void> {
    if (this.state.panelVisible) {
      this.update({ panelVisible: false });
      await this.persist();
      return;
    }
    if (this.state.sessions.length === 0) {
      await this.createTerminal();
      return;
    }
    this.update({ panelVisible: true });
    await this.persist();
  }

  async hidePanel(): Promise<void> {
    if (this.state.panelVisible) {
      this.update({ panelVisible: false });
      await this.persist();
    }
  }

  previewPanelHeight(height: number): void {
    this.update({ panelHeight: clampHeight(height) });
  }

  async commitPanelHeight(): Promise<void> {
    await this.persist();
  }

  write(id: string, data: string): void {
    // An exited shell has no stdin left; typing into its tab is a quiet no-op, not an error toast.
    if (this.state.sessions.some((session) => session.id === id && session.exited)) {
      return;
    }
    void safely(this.events, () => this.ipc.terminalWrite(id, data), "send input", undefined);
  }

  resize(id: string, cols: number, rows: number): void {
    void safely(this.events, () => this.ipc.terminalResize(id, cols, rows), "resize", undefined);
  }

  /** Copies terminal text to the system clipboard; a failure is reported, not swallowed. */
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
    this.update({
      sessions: this.state.sessions.map((session) =>
        session.id === id ? { ...session, exited: true, exitCode: code } : session,
      ),
    });
  }

  private update(patch: Partial<TerminalState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) {
      listener();
    }
  }

  private async persist(): Promise<void> {
    const persisted: PersistedState = {
      panelVisible: this.state.panelVisible,
      panelHeight: this.state.panelHeight,
      lastShell: this.state.lastShell,
    };
    await this.ipc.settingsSet(STATE_KEY, JSON.stringify(persisted)).catch(() => undefined);
  }
}

function clampHeight(height: number): number {
  return Math.min(PANEL_MAX_HEIGHT, Math.max(PANEL_MIN_HEIGHT, Math.round(height)));
}

function parsePersisted(raw: string): PersistedState | null {
  try {
    const value = JSON.parse(raw) as Partial<PersistedState>;
    return {
      panelVisible: value.panelVisible === true,
      panelHeight:
        typeof value.panelHeight === "number"
          ? clampHeight(value.panelHeight)
          : DEFAULT_PANEL_HEIGHT,
      lastShell: typeof value.lastShell === "string" ? value.lastShell : null,
    };
  } catch {
    return null;
  }
}
