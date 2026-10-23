import type { EventBus } from "../eventBus";
import type { VsCodeExtensionSource } from "../extensionsIpc";
import type { AppEvents } from "../events";
import type { IpcClient } from "../ipc";
import type { ProfileList, ProfileSummary, VsCodeProfileSource } from "./profilesIpc";

export interface ProfileState {
  list: ProfileList | null;
  /** Something is running (the buttons wait). */
  busy: boolean;
  /** The Profiles window is open. */
  open: boolean;
  vscodeProfiles: VsCodeProfileSource[];
  vscodeExtensions: VsCodeExtensionSource[];
}

/**
 * Profiles: named sets of the settings listed in `covers` (appearance, editor, formatting, auto save, indexing, the AI
 * switch ...). Switching writes them into the user's settings and then re-reads the settings, so the theme, icons and
 * editor follow at once. Files live next to the app; nothing leaves the computer. Export/import use the native file
 * dialogs and never contain keys, passwords or local paths (the backend guarantees it).
 */
export class ProfileService {
  private state: ProfileState = { list: null, busy: false, open: false, vscodeProfiles: [], vscodeExtensions: [] };
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly ipc: IpcClient,
    private readonly events: EventBus<AppEvents>,
    /** Re-reads the settings after a switch (SettingsService.reload). */
    private readonly reloadSettings: () => Promise<void>,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = (): ProfileState => this.state;

  private set(patch: Partial<ProfileState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  active(): ProfileSummary | null {
    return this.state.list?.profiles.find((p) => p.active) ?? null;
  }

  /** Reads the profile list (a local file read; seeds Default and the ready-made profiles the first time). */
  async load(): Promise<void> {
    try {
      this.set({ list: await this.ipc.profilesList() });
    } catch (error) {
      this.fail("read the profiles", error);
    }
  }

  async openWindow(): Promise<void> {
    this.set({ open: true });
    await this.load();
    await this.detectVsCodeProfiles();
    await this.detectVsCodeExtensions();
  }

  async detectVsCodeProfiles(): Promise<void> {
    try {
      this.set({ vscodeProfiles: await this.ipc.profileDetectVscode() });
    } catch (error) {
      this.fail("detect VS Code profiles", error);
      this.set({ vscodeProfiles: [] });
    }
  }

  async importDetectedVsCode(sourceId: string): Promise<boolean> {
    return this.run("import VS Code profile", () => this.ipc.profileImportDetectedVscode(sourceId));
  }

  async detectVsCodeExtensions(): Promise<void> {
    try {
      this.set({ vscodeExtensions: await this.ipc.extDetectVscode() });
    } catch (error) {
      this.fail("detect VS Code extensions", error);
      this.set({ vscodeExtensions: [] });
    }
  }

  async importVsCodeExtension(sourceId: string): Promise<boolean> {
    this.set({ busy: true });
    try {
      const extension = await this.ipc.extImportVscode(sourceId);
      this.events.emit("appNotice", {
        message: `Imported ${extension.id} as disabled. Review its permissions before enabling it in Extensions.`,
      });
      await this.detectVsCodeExtensions();
      return true;
    } catch (error) {
      this.fail("import VS Code extension", error);
      return false;
    } finally {
      this.set({ busy: false });
    }
  }

  closeWindow(): void {
    this.set({ open: false });
  }

  private fail(what: string, error: unknown): void {
    this.events.emit("appError", { message: `Could not ${what}: ${String(error)}` });
  }

  private async run(
    what: string,
    action: () => Promise<ProfileList>,
    reload = false,
  ): Promise<boolean> {
    this.set({ busy: true });
    try {
      const list = await action();
      if (reload) await this.reloadSettings();
      this.set({ list });
      return true;
    } catch (error) {
      this.fail(what, error);
      return false;
    } finally {
      this.set({ busy: false });
    }
  }

  async create(name: string, fromCurrent: boolean): Promise<boolean> {
    return this.run("create the profile", () => this.ipc.profileCreate(name, fromCurrent));
  }

  async switchTo(id: string): Promise<boolean> {
    const done = await this.run("switch profile", () => this.ipc.profileSwitch(id), true);
    if (done) {
      const name = this.active()?.name ?? id;
      this.events.emit("appNotice", { message: `Profile: ${name}.` });
    }
    return done;
  }

  async rename(id: string, name: string): Promise<boolean> {
    return this.run("rename the profile", () => this.ipc.profileRename(id, name));
  }

  async duplicate(id: string, name: string): Promise<boolean> {
    return this.run("duplicate the profile", () => this.ipc.profileDuplicate(id, name));
  }

  async remove(id: string): Promise<boolean> {
    return this.run("delete the profile", () => this.ipc.profileDelete(id));
  }

  /** Why a profile can't be deleted right now, or `undefined`. */
  deleteBlocker(profile: ProfileSummary): string | undefined {
    if (profile.id === "default") return "The Default profile can't be deleted.";
    if (profile.active) return "This profile is in use. Switch to another profile first.";
    return undefined;
  }

  /** Export Profile: the native Save dialog, then the file (no keys, passwords or local paths in it). */
  async exportProfile(id?: string): Promise<boolean> {
    if (this.state.list === null) await this.load();
    const target = id ?? this.active()?.id;
    if (target === undefined) {
      this.events.emit("appNotice", { message: "There is no profile to export." });
      return false;
    }
    try {
      const text = await this.ipc.profileExport(target);
      const path = await this.ipc.saveDocumentDialog(`${target}.openmind-profile.json`);
      if (path === null) return false;
      await this.ipc.documentSave(path, text, "utf8");
      this.events.emit("appNotice", {
        message: "Profile exported. It holds settings only: no keys, passwords or local paths.",
      });
      return true;
    } catch (error) {
      this.fail("export the profile", error);
      return false;
    }
  }

  /** Import compatible VS Code settings and optional keybindings as an inactive profile.
   * Nothing is applied to the current workspace or existing OpenMind profile.
   */
  async importFromVsCode(): Promise<boolean> {
    try {
      const settingsPath = await this.ipc.openDocumentDialog();
      if (settingsPath === null) return false;
      const settings = await this.ipc.documentRead(settingsPath);
      if (settings.state !== "file") throw new Error("Cannot read VS Code settings.json.");
      const shortcutsPath = await this.ipc.openDocumentDialog();
      let shortcuts: string | null = null;
      if (shortcutsPath !== null) {
        const read = await this.ipc.documentRead(shortcutsPath);
        if (read.state !== "file") throw new Error("Cannot read VS Code keybindings.json.");
        shortcuts = read.content;
      }
      const done = await this.run(
        "import VS Code preferences",
        () => this.ipc.profileImportVscode("Imported VS Code", settings.content, shortcuts),
      );
      if (done) this.events.emit("appNotice", {
        message: "VS Code settings imported into a new profile. Switch to it to apply compatible preferences.",
      });
      return done;
    } catch (error) {
      this.fail("import VS Code settings", error);
      return false;
    }
  }

  /** Import Profile: adds the file as a new profile (it is not applied until you switch to it). */
  async importProfile(): Promise<boolean> {
    try {
      const path = await this.ipc.openDocumentDialog();
      if (path === null) return false;
      const read = await this.ipc.documentRead(path);
      if (read.state !== "file") {
        this.fail(
          "import the profile",
          read.state === "missing" ? "the file is gone" : read.reason,
        );
        return false;
      }
      return await this.run("import the profile", () => this.ipc.profileImport(read.content));
    } catch (error) {
      this.fail("import the profile", error);
      return false;
    }
  }
}
