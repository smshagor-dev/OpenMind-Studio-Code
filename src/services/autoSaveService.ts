import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";

export type AutoSaveMode = "off" | "afterDelay" | "onFocusChange" | "onWindowChange";

const MODES: readonly AutoSaveMode[] = ["off", "afterDelay", "onFocusChange", "onWindowChange"];

export interface AutoSaveDeps {
  events: EventBus<AppEvents>;
  settings: {
    string: (id: string, fallback: string) => string;
    number: (id: string, fallback: number) => number;
    set: (scope: "user", id: string, value: string) => Promise<unknown>;
    onChange: (ids: string[], handler: () => void) => () => void;
  };
  documents: {
    fileBackedIds: () => string[];
    autoSaveIds?: () => string[];
    isDirty: (id: string) => boolean;
    externalState: (id: string) => "none" | "changed" | "deleted";
  };
  /** Saves one document; `format` says whether Format on Save may run first. */
  save: (id: string, format: boolean) => Promise<void>;
  /** The text document in front, or `null`. */
  activeDocId: () => string | null;
  /** Calls the handler whenever the tab in front may have changed. */
  onActiveChanged: (handler: () => void) => () => void;
  /** Calls the handler when the window loses focus. */
  onWindowBlur: (handler: () => void) => () => void;
}

/**
 * Files > Auto Save (VS Code's `files.autoSave`): `afterDelay` saves a changed file a moment after the last edit,
 * `onFocusChange` when you switch to another editor or leave the window, `onWindowChange` when you leave the window.
 * File-backed and writable provider resources are saved; untitled and read-only resources are excluded. A file
 * that changed on disk underneath is left alone, and a save after a delay skips Format on Save so typing isn't
 * rearranged under the cursor.
 */
export class AutoSaveService {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly saving = new Set<string>();
  private readonly queued = new Set<string>();
  private running = false;
  private lastActive: string | null = null;
  private disposers: (() => void)[] = [];

  constructor(private readonly deps: AutoSaveDeps) {}

  mode(): AutoSaveMode {
    const value = this.deps.settings.string("files.autoSave", "off");
    return MODES.find((mode) => mode === value) ?? "off";
  }

  enabled(): boolean {
    return this.mode() !== "off";
  }

  private delay(): number {
    return Math.max(100, this.deps.settings.number("files.autoSaveDelay", 1000));
  }

  /** Starts following edits, tab changes and window focus. */
  start(): void {
    const { events, settings } = this.deps;
    if (this.running) return;
    this.running = true;
    this.lastActive = this.deps.activeDocId();
    this.disposers.push(
      events.on("documentDirtyChanged", ({ id, dirty }) => {
        if (dirty && this.mode() === "afterDelay") this.schedule(id);
        if (!dirty) this.cancel(id);
      }),
      this.deps.onActiveChanged(() => {
        const now = this.deps.activeDocId();
        const before = this.lastActive;
        this.lastActive = now;
        if (this.mode() === "onFocusChange" && before !== null && before !== now) {
          void this.saveIfDirty(before, true);
        }
      }),
      this.deps.onWindowBlur(() => {
        if (this.mode() === "onFocusChange" || this.mode() === "onWindowChange")
          this.saveAllDirty();
      }),
      events.on("documentExternalChanged", ({ id }) => {
        if (this.mode() === "afterDelay" && this.eligibleIds().includes(id) && this.deps.documents.isDirty(id) && this.deps.documents.externalState(id) === "none") this.schedule(id);
      }),
      events.on("extensionsChanged", () => {
        if (this.mode() === "afterDelay" && this.deps.documents.autoSaveIds) {
          for (const id of this.eligibleIds()) if (this.deps.documents.isDirty(id)) this.schedule(id);
        }
      }),
      settings.onChange(["files.autoSave", "files.autoSaveDelay"], () => {
        this.clearTimers();
        if (this.mode() === "afterDelay") {
          for (const id of this.eligibleIds()) {
            if (this.deps.documents.isDirty(id)) this.schedule(id);
          }
        }
      }),
    );
    if (this.mode() === "afterDelay" && this.deps.documents.autoSaveIds) {
      for (const id of this.eligibleIds()) if (this.deps.documents.isDirty(id)) this.schedule(id);
    }
  }

  private eligibleIds(): string[] { return this.deps.documents.autoSaveIds?.() ?? this.deps.documents.fileBackedIds(); }

  stop(): void {
    this.running = false;
    this.queued.clear();
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.clearTimers();
  }

  /** File > Auto Save: turns it on (after a delay, like VS Code) or off. */
  async toggle(): Promise<void> {
    await this.deps.settings.set("user", "files.autoSave", this.enabled() ? "off" : "afterDelay");
  }

  private schedule(id: string): void {
    this.cancel(id);
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        void this.saveIfDirty(id, false);
      }, this.delay()),
    );
  }

  private cancel(id: string): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(id);
  }

  private clearTimers(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private saveAllDirty(): void {
    for (const id of this.eligibleIds()) void this.saveIfDirty(id, true);
  }

  private async saveIfDirty(id: string, format: boolean): Promise<void> {
    const { documents } = this.deps;
    if (!this.running || !this.eligibleIds().includes(id)) return;
    if (!documents.isDirty(id) || documents.externalState(id) !== "none") return;
    if (this.saving.has(id)) { this.queued.add(id); return; }
    this.saving.add(id);
    try {
      await this.deps.save(id, format);
    } catch {
      // A failed save is reported by the save itself; the next edit tries again.
    } finally {
      this.saving.delete(id);
      if (this.queued.delete(id)) {
        if (this.mode() === "afterDelay") this.schedule(id);
        else if (this.mode() !== "off") void this.saveIfDirty(id, format);
      }
    }
  }
}

/** The workbench's Auto Save: the documents of `workspace`'s tabs, the browser window's blur. */
export function createWorkbenchAutoSave(deps: {
  events: EventBus<AppEvents>;
  settings: AutoSaveDeps["settings"];
  documents: AutoSaveDeps["documents"] & { has: (id: string) => boolean };
  workspace: {
    getState: () => { activeId: string | null };
    save: (id: string, options: { format: boolean }) => Promise<void>;
    subscribe: (handler: () => void) => () => void;
  };
}): AutoSaveService {
  const { documents, workspace } = deps;
  return new AutoSaveService({
    events: deps.events,
    settings: deps.settings,
    documents,
    save: (id, format) => workspace.save(id, { format }),
    activeDocId: () => {
      const id = workspace.getState().activeId;
      return id !== null && documents.has(id) ? id : null;
    },
    onActiveChanged: (handler) => workspace.subscribe(handler),
    onWindowBlur: (handler) => {
      window.addEventListener("blur", handler);
      return () => {
        window.removeEventListener("blur", handler);
      };
    },
  });
}

