import type { ConfirmPrompt } from "./extensionPromptService";
import type { TerminalService } from "./terminalService";
import { t } from "../i18n";

/** What an extension terminal needs from the app's terminals (a subset of `TerminalService`). */
export type TerminalsForExtensions = Pick<
  TerminalService,
  "createTerminal" | "closeTerminal" | "write" | "setActive" | "getState" | "subscribe" | "isShowing"
>;

export interface ExtensionTerminalDeps {
  terminals: TerminalsForExtensions;
  /** Shows the bottom panel on the Terminal tab (only after the user said yes). */
  showPanel: () => Promise<void>;
  /** A modal question; resolves with the chosen button label or `null` (cancelled). */
  confirm: (request: Omit<ConfirmPrompt, "kind" | "id">) => Promise<string | null>;
  notifyHost: (method: string, params: unknown) => void;
  notice: (message: string) => void;
  log?: (line: string) => void;
}

interface Entry {
  extension: string;
  name: string;
  sessionId: string;
  /** The user chose "Always run in this terminal". */
  trusted: boolean;
  /** Text the extension typed without running it yet (shown when it later asks to run). */
  typed: string;
}

/** The confirmation's buttons in English (shown in the UI language). */
export const RUN = "Run";
export const RUN_ALWAYS = "Always Run in This Terminal";
const MAX_TEXT = 16 * 1024;

/** A string parameter from the host, or `fallback`. */
function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * Terminals extensions create (`window.createTerminal`, Milestone 18). Each is an ordinary integrated terminal with
 * the extension's name; it is created without opening the panel (the panel never opens by itself). Typing text is
 * allowed, but **text that would run a command** (a line break) is shown to the user first: Run, Always Run in This
 * Terminal, or Cancel. Only an answer opens the panel. When the user closes the terminal (or its shell exits) the
 * extension hears `onDidCloseTerminal`. UI-free.
 */
export class ExtensionTerminalService {
  private readonly byId = new Map<string, Entry>();
  private known = new Map<string, boolean>();

  constructor(private readonly deps: ExtensionTerminalDeps) {
    deps.terminals.subscribe(() => {
      this.onSessionsChanged();
    });
  }

  /** `terminal/create`: a new terminal named after the extension's request, in the given folder. */
  async create(params: Record<string, unknown>): Promise<{ pid: number | null }> {
    const id = str(params.id);
    const extension = str(params.extension);
    if (id === "" || !id.startsWith(`${extension}#`)) throw new Error("Invalid terminal request.");
    const name = str(params.name, extension).slice(0, 80);
    const cwd = typeof params.cwd === "string" ? params.cwd : null;
    const sessionId = await this.deps.terminals.createTerminal(undefined, cwd, {
      // The extension holds this terminal's id: it is never restarted for new runtimes.
      refreshable: false,
      title: `${name} (${extension})`,
      show: false,
    });
    if (sessionId === null) throw new Error("The terminal could not be started.");
    this.byId.set(id, { extension, name, sessionId, trusted: false, typed: "" });
    this.known.set(sessionId, false);
    this.deps.log?.(`[${extension}] created terminal "${name}"`);
    return { pid: null };
  }

  /**
   * `terminal/sendText`: plain text is typed; anything that would run (a line break, or `addNewLine`) is shown to the
   * user first, with everything typed before it.
   */
  async sendText(params: Record<string, unknown>): Promise<{ sent: boolean }> {
    const entry = this.byId.get(str(params.id));
    if (!entry || entry.extension !== params.extension) throw new Error("This terminal is closed.");
    const text = str(params.text);
    if (text.length > MAX_TEXT) throw new Error("The text is longer than 16 KB.");
    const runs = params.addNewLine !== false || /[\r\n]/.test(text);
    if (!runs) {
      entry.typed += text;
      this.deps.terminals.write(entry.sessionId, text);
      return { sent: true };
    }
    const line = (entry.typed + text).replace(/\r?\n$/, "");
    if (!entry.trusted) {
      const answer = await this.deps.confirm({
        extension: entry.extension,
        title: t("extTerminal.confirmTitle", { name: entry.name }),
        details: [
          { label: t("tasks.confirm.command"), value: line === "" ? "(Enter)" : line },
          { label: t("extTerminal.terminal"), value: entry.name },
        ],
        notes: [t("extTerminal.note")],
        buttons: [t("extTerminal.run"), t("extTerminal.runAlways")],
      });
      if (answer === null) {
        this.deps.log?.(`[${entry.extension}] a command for terminal "${entry.name}" was cancelled`);
        return { sent: false };
      }
      if (answer === t("extTerminal.runAlways")) entry.trusted = true;
      // The user said yes: show them what runs.
      this.deps.terminals.setActive(entry.sessionId);
      await this.deps.showPanel();
    }
    entry.typed = "";
    this.deps.terminals.write(entry.sessionId, `${text.replace(/\r?\n$/, "")}\r`);
    return { sent: true };
  }

  /** `terminal/show`: selects it; the panel itself only opens when the user opens it. */
  show(params: Record<string, unknown>): void {
    const entry = this.byId.get(str(params.id));
    if (!entry || entry.extension !== params.extension) return;
    this.deps.terminals.setActive(entry.sessionId);
    if (!this.deps.terminals.isShowing()) {
      this.deps.notice(
        t("extTerminal.opened", { extension: entry.extension, name: entry.name }),
      );
    }
  }

  /** `terminal/dispose`: the extension closes its terminal. */
  async dispose(params: Record<string, unknown>): Promise<void> {
    const id = str(params.id);
    const entry = this.byId.get(id);
    if (!entry || entry.extension !== params.extension) return;
    this.byId.delete(id);
    this.known.delete(entry.sessionId);
    await this.deps.terminals.closeTerminal(entry.sessionId);
  }

  /** Closes the terminals of extensions that are no longer enabled (disabled, uninstalled). */
  async keepOnly(enabled: ReadonlySet<string>): Promise<void> {
    for (const [id, entry] of [...this.byId]) {
      if (enabled.has(entry.extension)) continue;
      this.byId.delete(id);
      this.known.delete(entry.sessionId);
      await this.deps.terminals.closeTerminal(entry.sessionId);
    }
  }

  /** The host went away: its terminal objects are gone; the terminals stay as ordinary ones. */
  reset(): void {
    this.byId.clear();
    this.known.clear();
  }

  /** How many terminals an extension has open (its details page). */
  countFor(extension: string): number {
    return [...this.byId.values()].filter((entry) => entry.extension === extension).length;
  }

  private onSessionsChanged(): void {
    const sessions = this.deps.terminals.getState().sessions;
    for (const [id, entry] of [...this.byId]) {
      const session = sessions.find((s) => s.id === entry.sessionId);
      const wasExited = this.known.get(entry.sessionId) ?? false;
      if (!session) {
        this.byId.delete(id);
        this.known.delete(entry.sessionId);
        this.deps.notifyHost("host/terminalClosed", { id, exitCode: null });
      } else if (session.exited && !wasExited) {
        this.known.set(entry.sessionId, true);
        this.deps.notifyHost("host/terminalClosed", { id, exitCode: session.exitCode });
        this.byId.delete(id);
      }
    }
  }
}
