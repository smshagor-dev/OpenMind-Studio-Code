import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { AddonStatus, InstalledVersion, InstallProgress, IpcClient, RuntimeStatus } from "./ipc";
import { t } from "../i18n";
import type { CanonicalFeed } from "./state/canonicalStateService";

export type RuntimeOperation = "install" | "repair" | "delete" | "activate";

export interface RuntimeState {
  loaded: boolean;
  runtimes: RuntimeStatus[];
  /** Live progress of the install/repair running for each runtime id. */
  progress: Record<string, InstallProgress>;
  /** What each runtime is doing right now, from this window's point of view. */
  working: Record<string, RuntimeOperation>;
  /** The last failure per runtime: what went wrong and how to recover, from the backend. */
  errors: Record<string, string>;
}

const EMPTY: RuntimeState = { loaded: false, runtimes: [], progress: {}, working: {}, errors: {} };

const PHASE_LABELS: Record<InstallProgress["phase"], string> = {
  waiting: "runtimes.phase.waiting",
  download: "runtimes.phase.download",
  verify: "runtimes.phase.verify",
  extract: "runtimes.phase.extract",
  finalize: "runtimes.phase.finalize",
  done: "runtimes.phase.done",
};

export interface ProgressView {
  label: string;
  /** 0-100, or `null` when the total isn't known (an indeterminate bar). */
  percent: number | null;
}

/** How a backend progress event reads in the UI. Pure so it's tested without React. */
export function describeProgress(progress: InstallProgress): ProgressView {
  const percent =
    progress.total !== null && progress.total > 0
      ? Math.min(100, Math.floor((progress.current / progress.total) * 100))
      : null;
  const label = t(PHASE_LABELS[progress.phase]);
  return { label: percent === null ? `${label}…` : `${label} ${String(percent)}%`, percent };
}

export interface InjectionView {
  injected: boolean;
  label: string;
}

/**
 * Whether new terminals get this install on their PATH. Mirrors the backend
 * rule (`RuntimeManager::environment`): only the active, healthy version of a
 * runtime is injected.
 */
export function injectionStatus(entry: InstalledVersion): InjectionView {
  if (!entry.healthy) {
    return { injected: false, label: t("runtimes.injection.needsRepair") };
  }
  if (!entry.active) {
    return { injected: false, label: t("runtimes.injection.notActive") };
  }
  return { injected: true, label: t("runtimes.injection.injected") };
}

export interface Availability {
  enabled: boolean;
  /** Why it's disabled — shown as the button's tooltip, so nothing is disabled without a reason. */
  reason?: string;
}

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
}

const ENABLED: Availability = { enabled: true };

function disabled(reason: string): Availability {
  return { enabled: false, reason };
}

/**
 * Owns the Runtime Manager's UI-facing state and drives the Rust runtime
 * manager over IPC. All the actual work — downloading, checksum, extraction,
 * repair, deletion, PATH injection — happens in Rust; this class tracks what
 * the user asked for, shows progress, and keeps failures next to the runtime
 * they belong to.
 */
export class RuntimeService {
  private state: RuntimeState = EMPTY;
  private readonly listeners = new Set<() => void>();
  private unsubscribe: (() => void) | null = null;
  private failureListener: ((message: string, retry: () => void) => void) | null = null;
  /** The canonical runtime list (`src/services/state`), once the backend has it. */
  private canonical: CanonicalFeed<RuntimeStatus[]> | null = null;

  constructor(
    private readonly ipc: IpcClient,
    private readonly events: EventBus<AppEvents>,
    /** Where install/repair/delete activity is logged (the Output panel's "Runtime Manager" channel). */
    private readonly log: (line: string) => void = () => undefined,
  ) {}

  /** Told about a failed install/repair with a way to run it again (the network card's Retry). */
  setFailureListener(listener: (message: string, retry: () => void) => void): void {
    this.failureListener = listener;
  }

  getState(): RuntimeState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Starts listening for install progress. Safe to call more than once. */
  async initialize(): Promise<void> {
    if (this.unsubscribe) {
      return;
    }
    try {
      this.unsubscribe = await this.ipc.onRuntimeProgress((progress) => {
        const previous = this.state.progress[progress.kind];
        if (previous?.phase !== progress.phase) {
          this.log(`${progress.kind} ${progress.version}: ${describeProgress(progress).label}`);
        }
        this.update({ progress: { ...this.state.progress, [progress.kind]: progress } });
      });
    } catch (error) {
      this.events.emit("appError", { message: `Runtime progress unavailable: ${String(error)}` });
    }
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /**
   * The runtime list comes from the backend's canonical state: every window gets the same list, once per change (an
   * install here or in another window, a folder copied in by hand). Returns the way to stop.
   */
  useCanonical(feed: CanonicalFeed<RuntimeStatus[]>): () => void {
    this.canonical = feed;
    const off = feed.subscribe((runtimes) => {
      this.update({ loaded: true, runtimes });
    });
    const current = feed.current();
    if (current !== undefined) this.update({ loaded: true, runtimes: current });
    return () => {
      off();
      this.canonical = null;
    };
  }

  /** Waits until this window has every runtime change the backend made so far (after an operation). */
  async refresh(): Promise<void> {
    await this.canonical?.catchUp();
  }

  /** `acceptLicense`: the user accepted the vendor licence the runtime requires (the backend refuses without it). */
  install(kind: string, version: string | null, acceptLicense = false): Promise<boolean> {
    return this.run(kind, "install", () => this.ipc.runtimeInstall(kind, version, acceptLicense));
  }

  /** Repairs `version`; resolves `true` if something was actually repaired. */
  async repair(kind: string, version: string): Promise<boolean> {
    let repaired = false;
    await this.run(kind, "repair", async () => {
      repaired = await this.ipc.runtimeRepair(kind, version);
    });
    return repaired;
  }

  /** Adds an optional part (an add-on such as Tcl/Tk for Python) to an installed version. */
  installAddon(kind: string, version: string, addon: string): Promise<boolean> {
    return this.run(kind, "install", () => this.ipc.runtimeAddonInstall(kind, version, addon));
  }

  /** Removes exactly the files an add-on added. */
  removeAddon(kind: string, version: string, addon: string): Promise<boolean> {
    return this.run(kind, "delete", () => this.ipc.runtimeAddonRemove(kind, version, addon));
  }

  /** The add-on `addon` of the active version of `kind` when it can be added now (known, downloadable, not there). */
  addableAddon(kind: string, addon: string): { version: string; status: AddonStatus } | null {
    const runtime = this.state.runtimes.find((candidate) => candidate.id === kind);
    const active = runtime?.installed.find((installed) => installed.active && installed.healthy);
    const status = active?.addons?.find((candidate) => candidate.id === addon);
    return active !== undefined && status !== undefined && status.available && !status.installed
      ? { version: active.version, status }
      : null;
  }

  remove(kind: string, version: string): Promise<boolean> {
    return this.run(kind, "delete", () => this.ipc.runtimeDelete(kind, version));
  }

  setActive(kind: string, version: string): Promise<boolean> {
    return this.run(kind, "activate", () => this.ipc.runtimeSetActive(kind, version));
  }

  dismissError(kind: string): void {
    this.update({ errors: omit(this.state.errors, kind) });
  }

  private busyFor(runtime: RuntimeStatus): boolean {
    return runtime.busy || this.isBusy(runtime.id);
  }

  isBusy(kind: string): boolean {
    return kind in this.state.working || this.state.runtimes.some((r) => r.id === kind && r.busy);
  }

  installAvailability(runtime: RuntimeStatus, version: string | null): Availability {
    if (this.busyFor(runtime)) {
      return disabled(`${runtime.displayName} is being changed right now.`);
    }
    if (runtime.availableVersions.length === 0) {
      return disabled(`${runtime.displayName} has no download for this platform.`);
    }
    if (version === null || !runtime.availableVersions.includes(version)) {
      return disabled(t("runtimes.reason.chooseVersion"));
    }
    if (runtime.installed.some((installed) => installed.version === version)) {
      return disabled(`${runtime.displayName} ${version} is already installed.`);
    }
    return ENABLED;
  }

  deleteAvailability(runtime: RuntimeStatus): Availability {
    return this.busyFor(runtime)
      ? disabled(`${runtime.displayName} is being changed right now.`)
      : ENABLED;
  }

  repairAvailability(runtime: RuntimeStatus, version: string): Availability {
    if (this.busyFor(runtime)) {
      return disabled(`${runtime.displayName} is being changed right now.`);
    }
    const installed = runtime.installed.find((candidate) => candidate.version === version);
    if (installed?.healthy === true) {
      return disabled(t("runtimes.reason.intact"));
    }
    return ENABLED;
  }

  activateAvailability(runtime: RuntimeStatus, version: string): Availability {
    if (this.busyFor(runtime)) {
      return disabled(`${runtime.displayName} is being changed right now.`);
    }
    const installed = runtime.installed.find((candidate) => candidate.version === version);
    if (installed?.active === true) {
      return disabled(t("runtimes.reason.alreadyActive"));
    }
    if (installed?.healthy === false) {
      return disabled(t("runtimes.reason.repairFirst"));
    }
    return ENABLED;
  }

  private async run(
    kind: string,
    operation: RuntimeOperation,
    task: () => Promise<unknown>,
  ): Promise<boolean> {
    if (this.isBusy(kind)) {
      return false;
    }
    this.update({
      working: { ...this.state.working, [kind]: operation },
      errors: omit(this.state.errors, kind),
    });
    let ok = true;
    this.log(`${operation} ${kind}…`);
    try {
      await task();
      this.log(`${operation} ${kind}: done.`);
    } catch (error) {
      ok = false;
      this.log(`${operation} ${kind} failed: ${String(error)}`);
      this.update({ errors: { ...this.state.errors, [kind]: String(error) } });
      this.failureListener?.(String(error), () => {
        void this.run(kind, operation, task);
      });
    }
    this.update({
      working: omit(this.state.working, kind),
      progress: omit(this.state.progress, kind),
    });
    await this.refresh();
    return ok;
  }

  private update(patch: Partial<RuntimeState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) {
      listener();
    }
  }
}
