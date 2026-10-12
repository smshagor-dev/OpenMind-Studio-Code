// The update UI's state, outside React. The backend decides and schedules (src-tauri/src/updates): this follows its
// `update:state` events, reports this window's unsaved editors, and runs what the user asks — never anything on its own.
import { interruptions, restartBlocker } from "./updateModel";
import type { UpdateInfo, UpdateIpc } from "./updateIpc";

/** What the service needs from the rest of the app. */
export interface UpdateHost {
  /** Editors with unsaved changes in this window. */
  unsavedCount: () => number;
  /** Calls `listener` whenever an editor's unsaved state changes; returns the unsubscribe. */
  onUnsavedChange: (listener: () => void) => () => void;
  saveAll: () => Promise<void>;
  /** A yes/no question; `true` when the user agreed. */
  confirm: (message: string, okLabel: string) => Promise<boolean>;
  notify: (message: string) => void;
  /** Translates an i18n key. */
  text: (key: string, params?: Record<string, string | number>) => string;
  openExternal: (url: string) => Promise<void>;
}

export interface UpdateUiState {
  info: UpdateInfo | null;
  dialogOpen: boolean;
  /** An install attempt failed and the user chose to keep working: a mandatory update no longer blocks this run. */
  continuedAfterFailure: boolean;
  busy: boolean;
  /** The last action's problem, shown in the dialog. */
  error: string | null;
}

export class UpdateService {
  private state: UpdateUiState = {
    info: null,
    dialogOpen: false,
    continuedAfterFailure: false,
    busy: false,
    error: null,
  };
  private readonly listeners = new Set<() => void>();
  private stops: (() => void)[] = [];

  constructor(
    private readonly ipc: UpdateIpc,
    private readonly host: UpdateHost,
  ) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getState = (): UpdateUiState => this.state;

  /** Only a real status object is kept (an older backend or a failed call answers nothing usable). */
  private static valid(info: unknown): UpdateInfo | null {
    return typeof info === "object" && info !== null && "phase" in info && "activity" in info
      ? (info as UpdateInfo)
      : null;
  }

  private set(patch: Partial<UpdateUiState>): void {
    if ("info" in patch) patch = { ...patch, info: UpdateService.valid(patch.info) };
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Follows the backend and reports this window's unsaved editors (nothing is checked or downloaded here). */
  async start(): Promise<void> {
    this.stops.push(
      await this.ipc.onState((info) => {
        this.set({ info });
      }),
    );
    this.stops.push(
      await this.ipc.onProgress((progress) => {
        const info = this.state.info;
        if (info !== null) this.set({ info: { ...info, downloaded: progress.downloaded, total: progress.total } });
      }),
    );
    const report = () => {
      void this.ipc.reportUnsaved(this.host.unsavedCount()).catch(() => undefined);
    };
    report();
    this.stops.push(this.host.onUnsavedChange(report));
    try {
      this.set({ info: await this.ipc.status() });
    } catch {
      // The status comes with the next event.
    }
  }

  stop(): void {
    for (const stop of this.stops) stop();
    this.stops = [];
  }

  openDialog(): void {
    this.set({ dialogOpen: true, error: null });
  }

  closeDialog(): void {
    this.set({ dialogOpen: false });
  }

  private async run(action: () => Promise<UpdateInfo | null>): Promise<void> {
    this.set({ busy: true, error: null });
    try {
      const info = await action();
      this.set(info ? { info, busy: false } : { busy: false });
    } catch (error) {
      this.set({ busy: false, error: String(error) });
    }
  }

  /** Help > Check for Updates: asks now; with automatic updates on, a found update is downloaded and verified too. */
  async checkNow(): Promise<void> {
    this.openDialog();
    await this.run(async () => {
      const info = await this.ipc.check();
      if (info.available && info.automatic && info.mode.kind !== "managed" && !info.ready) {
        return this.ipc.download();
      }
      return info;
    });
  }

  async download(): Promise<void> {
    await this.run(() => this.ipc.download());
  }

  /** Install at the next close (on, the default once downloaded) or not (off). */
  async setInstallOnExit(enabled: boolean): Promise<void> {
    await this.run(async () => {
      await this.ipc.setInstallOnExit(enabled);
      return this.ipc.status();
    });
  }

  async saveAll(): Promise<void> {
    await this.run(async () => {
      await this.host.saveAll();
      await this.ipc.reportUnsaved(this.host.unsavedCount());
      return this.ipc.status();
    });
  }

  /**
   * Restart to Update. Refused (with the reason) while editors are unsaved; asks before stopping running terminals or
   * programs; then the backend stops everything, installs and starts the new version.
   */
  async restartToUpdate(): Promise<void> {
    await this.ipc.reportUnsaved(this.host.unsavedCount()).catch(() => undefined);
    const info = await this.ipc.status().catch(() => this.state.info);
    this.set({ info });
    const blocker = restartBlocker(info);
    if (blocker !== null) {
      this.set({ error: this.host.text(blocker.key, blocker.params) });
      return;
    }
    let confirmed = false;
    const running = info === null ? 0 : interruptions(info);
    if (running > 0) {
      confirmed = await this.host.confirm(
        this.host.text("update.confirm.stop", { count: running }),
        this.host.text("update.action.restart"),
      );
      if (!confirmed) return;
    }
    await this.run(async () => {
      await this.ipc.installNow(confirmed);
      return null;
    });
  }

  /** After a failed install of a mandatory update: keep working for now (no lockout); it is offered again later. */
  continueAfterFailure(): void {
    this.set({ continuedAfterFailure: true, dialogOpen: false });
  }

  async openReleasesPage(): Promise<void> {
    const page = this.state.info?.releasesPage;
    if (page) await this.host.openExternal(page);
  }
}
