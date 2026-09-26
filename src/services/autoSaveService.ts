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
 * Only files that already have a place on disk are saved (an untitled file is never saved behind your back), a file
 * that changed on disk underneath is left alone, and a save after a delay skips Format on Save so typing isn't
 * rearranged under the cursor.
 */
export class AutoSaveService {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
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
      settings.onChange(["files.autoSave", "files.autoSaveDelay"], () => {
        this.clearTimers();
        if (this.mode() === "afterDelay") {
          for (const id of this.deps.documents.fileBackedIds()) {
            if (this.deps.documents.isDirty(id)) this.schedule(id);
          }
        }
      }),
    );
  }

  stop(): void {
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
    for (const id of this.deps.documents.fileBackedIds()) void this.saveIfDirty(id, true);
  }

  private async saveIfDirty(id: string, format: boolean): Promise<void> {
    const { documents } = this.deps;
    if (!documents.fileBackedIds().includes(id)) return;
    if (!documents.isDirty(id) || documents.externalState(id) !== "none") return;
    try {
      await this.deps.save(id, format);
    } catch {
      // A failed save is reported by the save itself; the next edit tries again.
    }
  }
}
