import type { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import type { OutputService } from "../outputService";
import { pathKey } from "../textSync";
import type { BrowserIpc, LivePreviewTarget } from "./browserIpc";

/** The Output channel the page's console is copied to (the bottom panel's Output can show it too). */
export const BROWSER_CHANNEL = "Browser";
/** The console keeps at most this many entries. */
export const MAX_CONSOLE_ENTRIES = 1000;

export type ConsoleLevel = "log" | "info" | "warn" | "error" | "debug";

export interface ConsoleEntry {
  id: number;
  level: ConsoleLevel;
  text: string;
}

export interface BrowserTarget extends LivePreviewTarget {
  /** The file Run Code opened. */
  file: string;
}

export interface BrowserState {
  target: BrowserTarget | null;
  /** The page's own address and title as it reports them (they follow links clicked inside the page). */
  address: string;
  title: string;
  loading: boolean;
  /** Changes on every (re)load: the frame is created again. */
  loadToken: number;
  /** What the frame loads: the file Run Code opened, then — after a reload — the page the user had navigated to. */
  src: string;
  entries: readonly ConsoleEntry[];
  consoleOpen: boolean;
}

const INITIAL: BrowserState = {
  target: null,
  address: "",
  title: "",
  loading: false,
  loadToken: 0,
  src: "",
  entries: [],
  consoleOpen: true,
};

/** Saves and disk changes within this long reload the page once (a save is also seen by the file watcher). */
export const RELOAD_DELAY_MS = 200;

const LEVELS: readonly ConsoleLevel[] = ["log", "info", "warn", "error", "debug"];

/**
 * The built-in browser beside the editor: Run Code on an HTML file (or on a JavaScript file when Node.js is missing)
 * opens it here — served from 127.0.0.1 by the backend so relative links, `fetch` and modules work — with the page's
 * console under it. Saving a file of the served folder reloads the page. UI-free: `BrowserView` draws it and hands
 * over the page's messages after checking they came from its own frame.
 */
export class BrowserPreviewService {
  private state: BrowserState = INITIAL;
  private readonly listeners = new Set<() => void>();
  private nextId = 1;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly ipc: BrowserIpc,
    private readonly events: EventBus<AppEvents>,
    private readonly output: Pick<OutputService, "append" | "clear" | "ensureChannel">,
    /** Brings the browser up beside the editor (the secondary side bar's Browser view). */
    private readonly show: () => void,
  ) {
    this.events.on("documentSaved", ({ path }) => {
      this.noteSaved(path);
    });
  }

  getState(): BrowserState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Opens `file` in the built-in browser. Resolves `false` (with an error shown) when it can't. */
  async open(file: string): Promise<boolean> {
    let target: LivePreviewTarget;
    try {
      target = await this.ipc.livePreviewOpen(file);
    } catch (error) {
      this.events.emit("appError", {
        message: `Couldn't open the built-in browser: ${String(error)}`,
      });
      return false;
    }
    // A save just before this run (Run Code saves first) would reload the page a second time.
    this.cancelReload();
    this.output.ensureChannel(BROWSER_CHANNEL);
    this.output.clear(BROWSER_CHANNEL);
    this.output.append(BROWSER_CHANNEL, `[Browser] ${target.url}`);
    this.update({
      target: { ...target, file },
      address: target.path,
      title: "",
      loading: true,
      loadToken: this.state.loadToken + 1,
      src: target.url,
      entries: [],
    });
    this.show();
    return true;
  }

  /** Loads the page on screen again — the one the user navigated to, not only the first (the console is cleared). */
  reload(): void {
    const target = this.state.target;
    if (target === null) return;
    this.update({
      loading: true,
      loadToken: this.state.loadToken + 1,
      src: target.origin + (this.state.address || target.path),
      entries: [],
    });
  }

  /** Opens the current page in the user's own browser. */
  async openExternal(): Promise<void> {
    const target = this.state.target;
    if (target === null) return;
    const url = target.origin + (this.state.address || target.path);
    await this.ipc.openExternalUrl(url).catch((error: unknown) => {
      this.events.emit("appError", { message: `Couldn't open the browser: ${String(error)}` });
    });
  }

  toggleConsole(): void {
    this.update({ consoleOpen: !this.state.consoleOpen });
  }

  clearConsole(): void {
    this.update({ entries: [] });
  }

  /** The frame finished loading (also for pages without the bridge, such as a plain file). */
  frameLoaded(): void {
    if (this.state.loading) this.update({ loading: false });
  }

  /**
   * A message from the page's bridge. The caller has already checked it came from the browser's own frame and
   * origin; the content is still the page's, so only known shapes are taken.
   */
  receive(data: unknown): void {
    if (typeof data !== "object" || data === null) return;
    const message = data as Record<string, unknown>;
    if (message.__openmind !== "browser") return;
    switch (message.type) {
      case "console": {
        const level = LEVELS.find((candidate) => candidate === message.level) ?? "log";
        const text = typeof message.text === "string" ? message.text.slice(0, 20000) : "";
        this.addEntry(level, text);
        return;
      }
      case "clear":
        this.clearConsole();
        return;
      case "location":
      case "loaded": {
        const patch: Partial<BrowserState> = {};
        if (typeof message.href === "string") patch.address = message.href.slice(0, 2000);
        if (typeof message.title === "string") patch.title = message.title.slice(0, 200);
        if (message.type === "loaded") patch.loading = false;
        this.update(patch);
        return;
      }
      default:
    }
  }

  /** Errors and warnings counted for the console's header. */
  counts(): { errors: number; warnings: number } {
    let errors = 0;
    let warnings = 0;
    for (const entry of this.state.entries) {
      if (entry.level === "error") errors++;
      else if (entry.level === "warn") warnings++;
    }
    return { errors, warnings };
  }

  private addEntry(level: ConsoleLevel, text: string): void {
    const entry: ConsoleEntry = { id: this.nextId++, level, text };
    const entries = [...this.state.entries, entry];
    if (entries.length > MAX_CONSOLE_ENTRIES)
      entries.splice(0, entries.length - MAX_CONSOLE_ENTRIES);
    this.update({ entries });
    const prefix = level === "log" ? "" : `[${level}] `;
    this.output.append(BROWSER_CHANNEL, prefix + text);
  }

  /**
   * Files changed on disk (the workspace watcher: another editor, Git, a build tool): one inside the served folder
   * reloads the page, like a live server. `overflow` means "too many to list", so it reloads too.
   */
  noteDiskChanges(paths: readonly string[], overflow: boolean): void {
    if (this.state.target === null) return;
    if (overflow || paths.some((path) => this.serves(path))) this.scheduleReload();
  }

  /** A file saved in the editor inside the served folder reloads the page (a live preview). */
  private noteSaved(path: string): void {
    if (this.serves(path)) this.scheduleReload();
  }

  private serves(path: string): boolean {
    const target = this.state.target;
    if (target === null) return false;
    const root = pathKey(target.root).replace(/\/+$/, "");
    const file = pathKey(path);
    return file === root || file.startsWith(`${root}/`);
  }

  private cancelReload(): void {
    if (this.reloadTimer !== null) clearTimeout(this.reloadTimer);
    this.reloadTimer = null;
  }

  private scheduleReload(): void {
    this.cancelReload();
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      this.reload();
    }, RELOAD_DELAY_MS);
  }

  private update(patch: Partial<BrowserState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
