import type { ConfirmPrompt } from "./extensionPromptService";
import type { TerminalService } from "./terminalService";
import { t } from "../i18n";

/** What an extension terminal needs from the app's terminals (a subset of `TerminalService`). */
export type TerminalsForExtensions = Pick<
  TerminalService,
  "createTerminal" | "closeTerminal" | "write" | "setActive" | "getState" | "subscribe" | "isShowing"
> & Partial<Pick<TerminalService, "createPseudoterminal" | "writePseudoterminal" | "exitPseudoterminal" | "onInput">>;

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
  pseudo?: boolean;
  interacted?: boolean;
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
  private activeId: string | null = null;

  constructor(private readonly deps: ExtensionTerminalDeps) {
    deps.terminals.subscribe(() => {
      this.onSessionsChanged();
    });
    deps.terminals.onInput?.((sessionId, data) => {
      if (!data) return;
      for (const [id, entry] of this.byId) {
        if (entry.sessionId !== sessionId || entry.interacted) continue;
        entry.interacted = true;
        this.deps.notifyHost("host/terminalStateChanged", { id, isInteractedWith: true });
      }
    });
  }

  /** Launch a DAP debuggee in a dedicated integrated terminal with literal arguments. */
  async runDebuggee(params: Record<string, unknown>): Promise<Record<string, never>> {
    const extension = str(params.extension), id = str(params.id);
    if (!extension || !id.startsWith(`${extension}#debug-`)) throw new Error("Invalid debug terminal owner.");
    const args = params.args;
    if (!Array.isArray(args) || !args.length || args.some(value => typeof value !== "string" || /[\0\r\n]/.test(value))) throw new Error("Invalid debugger arguments.");
    const env = params.env && typeof params.env === "object" ? params.env as Record<string, unknown> : {};
    if (Object.entries(env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || (value !== null && (typeof value !== "string" || /[\0\r\n]/.test(value))))) throw new Error("Invalid debugger environment.");
    const shells = this.deps.terminals.getState().shells;
    const shell = shells.find(value => value.kind === "powerShell")?.kind ?? shells.find(value => value.kind === "gitBash")?.kind;
    if (!shell) throw new Error("Debug terminal requires PowerShell or Git Bash for literal argument quoting.");
    const quote = (value: string) => shell === "powerShell" ? `'${value.replace(/'/g, "''")}'` : `'${value.replace(/'/g, "'\\''")}'`;
    const environment = Object.entries(env).map(([key, value]) => shell === "powerShell"
      ? value === null ? `Remove-Item Env:${key} -ErrorAction SilentlyContinue; ` : `$env:${key}=${quote(typeof value === "string" ? value : "")}; `
      : value === null ? `unset ${key}; ` : `export ${key}=${quote(typeof value === "string" ? value : "")}; `).join("");
    const line = environment + (shell === "powerShell" ? "& " : "") + (args as string[]).map(quote).join(" ");
    if (line.length > MAX_TEXT) throw new Error("Debug terminal command exceeds 16 KB.");
    const sessionId = await this.deps.terminals.createTerminal(shell, str(params.cwd) || null, { refreshable: false, title: `${str(params.name, "Debug")} (${extension})`, show: true });
    if (sessionId === null) throw new Error("Could not start the debug terminal.");
    this.byId.set(id, { extension, name: str(params.name, "Debug"), sessionId, trusted: true, typed: "" });
    this.known.set(sessionId, false);
    try { this.deps.terminals.write(sessionId, `${line}\r`); }
    catch (error) { await this.dispose({ extension, id }); throw error; }
    // DAP makes both process identifiers optional; the PTY backend does not expose them.
    return {};
  }

  /** `terminal/create`: a new terminal named after the extension's request, in the given folder. */
  async create(params: Record<string, unknown>): Promise<{ pid: number | null }> {
    const id = str(params.id);
    const extension = str(params.extension);
    if (id === "" || !id.startsWith(`${extension}#`)) throw new Error("Invalid terminal request.");
    const name = str(params.name, extension).slice(0, 80);
    const cwd = typeof params.cwd === "string" ? params.cwd : null;
    if (params.pseudo === true) {
      const terminals = this.deps.terminals;
      if (!terminals.createPseudoterminal) throw new Error("Extension pseudoterminals are unavailable.");
      const send = (event: string, fields: Record<string, unknown> = {}) => { this.deps.notifyHost("host/ptyEvent", { extension, id, event, ...fields }); };
      const sessionId = await terminals.createPseudoterminal(`${name} (${extension})`, cwd, {
        input: data => { send("input", { data }); }, resize: (columns, rows) => { send("resize", { columns, rows }); }, close: () => { send("close"); },
      });
      this.byId.set(id, { extension, name, sessionId, trusted: false, typed: "", pseudo: true }); this.known.set(sessionId, false);
      this.onSessionsChanged();
      return { pid: null };
    }
    const sessionId = await this.deps.terminals.createTerminal(undefined, cwd, {
      // The extension holds this terminal's id: it is never restarted for new runtimes.
      refreshable: false,
      title: `${name} (${extension})`,
      show: false,
    });
    if (sessionId === null) throw new Error("The terminal could not be started.");
    this.byId.set(id, { extension, name, sessionId, trusted: false, typed: "" });
    this.known.set(sessionId, false);
    this.onSessionsChanged();
    this.deps.log?.(`[${extension}] created terminal "${name}"`);
    return { pid: null };
  }

  ptyWrite(params: Record<string, unknown>): void {
    const entry = this.byId.get(str(params.id));
    if (!entry || entry.extension !== params.extension) return;
    const data = str(params.data);
    if (data.length > 1024 * 1024) throw new Error("Extension terminal output exceeds 1 MB per message.");
    this.deps.terminals.writePseudoterminal?.(entry.sessionId, data);
  }

  ptyExit(params: Record<string, unknown>): void {
    const entry = this.byId.get(str(params.id));
    if (!entry || entry.extension !== params.extension) return;
    this.deps.terminals.exitPseudoterminal?.(entry.sessionId, typeof params.code === "number" ? params.code : null);
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
    for (const entry of [...this.byId.values()]) if (entry.pseudo) this.deps.terminals.exitPseudoterminal?.(entry.sessionId, null);
    this.byId.clear();
    this.known.clear();
    this.activeId = null;
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
    const selected = this.deps.terminals.getState().activeId;
    const activeId = [...this.byId].find(([, entry]) => entry.sessionId === selected)?.[0] ?? null;
    if (this.activeId !== activeId) {
      this.activeId = activeId;
      this.deps.notifyHost("host/activeTerminalChanged", { id: activeId });
    }
  }
}

