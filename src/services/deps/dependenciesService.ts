import type { WorkspaceFeed } from "../state/canonicalStateService";
import { t } from "../../i18n";
import type { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import type { ActionOutcome, DependencyActions } from "./dependencyActions";
import type { DepsOp, DepsSnapshot, ProjectDeps, SetupKind } from "./depsIpc";

/** Where dismissed setup hints are remembered (`editor_settings`). */
export const DISMISSED_KEY = "deps.dismissedHints";

export interface DependenciesState {
  snapshot: DepsSnapshot | null;
  loading: boolean;
  error: string | null;
  busy: boolean;
  /** Per project folder: the chosen Python environment (`openmind` or a folder name). */
  pythonEnv: Readonly<Record<string, string>>;
  /** Per project folder: the chosen package manager when its lock files disagree. */
  nodeManager: Readonly<Record<string, string>>;
  /** `<project path>|<hint kind>` of setup hints the user dismissed. */
  dismissed: readonly string[];
}

export interface DependenciesHost {
  actions: Pick<DependencyActions, "perform">;
  events: EventBus<AppEvents>;
  settingsGet: (key: string) => Promise<string | null>;
  settingsSet: (key: string, value: string) => Promise<void>;
}

/** The operation a setup hint's button runs. */
export function hintOp(kind: SetupKind): DepsOp {
  switch (kind) {
    case "pythonNoEnv":
      return { op: "pythonCreateEnv" };
    case "nodeNotInstalled":
      return { op: "nodeInstall" };
    case "composerNotInstalled":
      return { op: "composerInstall" };
  }
}

/**
 * The Dependencies view: the open folder's projects with their environments, declared/installed/missing packages,
 * scripts and build actions, read by the backend (nothing runs to read them). Every change goes through
 * `DependencyActions` — the same plan/confirm/run path as the missing-package card — and the view reads the project
 * again afterwards. Setup hints ("no environment", "dependencies not installed") are offered, never acted on alone, and
 * a dismissal is remembered.
 */
export class DependenciesService {
  private state: DependenciesState = {
    snapshot: null,
    loading: false,
    error: null,
    busy: false,
    pythonEnv: {},
    nodeManager: {},
    dismissed: [],
  };
  private readonly listeners = new Set<() => void>();
  private request = 0;
  /** The canonical dependency state of this window's folder (`src/services/state`). */
  private canonical: WorkspaceFeed<DepsSnapshot> | null = null;

  constructor(private readonly host: DependenciesHost) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = (): DependenciesState => this.state;

  private set(patch: Partial<DependenciesState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  /** Loads the remembered dismissals and follows the folder, manifest saves and finished operations. */
  async initialize(): Promise<void> {
    try {
      const saved = await this.host.settingsGet(DISMISSED_KEY);
      const parsed: unknown = saved === null ? [] : JSON.parse(saved);
      if (Array.isArray(parsed)) this.set({ dismissed: parsed.filter((item): item is string => typeof item === "string") });
    } catch {
      // A damaged value just means nothing was dismissed.
    }
  }

  /**
   * Follows the backend's canonical dependency state of this window's folder: one scan per folder and burst of
   * changes (an `npm install`, a `pip install` into `.venv`, a saved manifest), shared by every window on the folder.
   */
  useCanonical(feed: WorkspaceFeed<DepsSnapshot>): () => void {
    this.canonical = feed;
    const off = feed.subscribe((snapshot) => {
      this.request++;
      this.set({ snapshot: snapshot ?? null, loading: false, error: null });
    });
    const current = feed.current();
    if (current !== undefined) this.set({ snapshot: current, loading: false, error: null });
    return () => {
      off();
      this.canonical = null;
    };
  }

  /** Refresh: the backend scans the folder once for every window on it, and this waits until the result is here. */
  async refresh(): Promise<void> {
    const request = ++this.request;
    this.set({ loading: true });
    try {
      await this.canonical?.refresh();
      if (request === this.request) this.set({ loading: false });
    } catch (error) {
      if (request === this.request) this.set({ loading: false, error: String(error) });
    }
  }

  setPythonEnv(project: ProjectDeps, env: string): void {
    this.set({ pythonEnv: { ...this.state.pythonEnv, [project.path]: env } });
  }

  setNodeManager(project: ProjectDeps, manager: string): void {
    this.set({ nodeManager: { ...this.state.nodeManager, [project.path]: manager } });
  }

  /** Plans, confirms and runs `op` in `project` (with the project's chosen environment / package manager). */
  async run(project: ProjectDeps, op: DepsOp): Promise<ActionOutcome> {
    this.set({ busy: true });
    try {
      return await this.host.actions.perform(
        {
          base: project.path,
          op,
          pythonEnv: this.state.pythonEnv[project.path] ?? null,
          nodeManager: this.state.nodeManager[project.path] ?? null,
        },
        t("deps.view.title"),
      );
    } finally {
      this.set({ busy: false });
    }
  }

  /** The first setup hint the user hasn't dismissed. */
  pendingHint(): { project: ProjectDeps; kind: SetupKind } | null {
    for (const project of this.state.snapshot?.projects ?? []) {
      for (const hint of project.setup) {
        if (!this.state.dismissed.includes(`${project.path}|${hint.kind}`)) return { project, kind: hint.kind };
      }
    }
    return null;
  }

  /** "Not Now": this hint for this project stays quiet (remembered across restarts). */
  async dismissHint(project: ProjectDeps, kind: SetupKind): Promise<void> {
    const key = `${project.path}|${kind}`;
    if (this.state.dismissed.includes(key)) return;
    const dismissed = [...this.state.dismissed, key].slice(-200);
    this.set({ dismissed });
    await this.host.settingsSet(DISMISSED_KEY, JSON.stringify(dismissed)).catch(() => undefined);
  }

  /** Runs a hint's action (after its confirmation). */
  async acceptHint(project: ProjectDeps, kind: SetupKind): Promise<ActionOutcome> {
    return this.run(project, hintOp(kind));
  }
}
