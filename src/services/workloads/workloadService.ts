import { t } from "../../i18n";
import type { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import { EMPTY_SELECTION, isSelected, toggleComponent, togglePack, toggleWorkload } from "./workloadModel";
import type { Pack, Plan, Selection, WorkloadCatalog, WorkloadsIpc } from "./workloadsIpc";

export type WorkloadSection =
  | "welcome"
  | "location"
  | "workloads"
  | "packs"
  | "network"
  | "offline"
  | "summary"
  | "install";

export const SECTIONS: WorkloadSection[] = [
  "welcome",
  "location",
  "workloads",
  "packs",
  "network",
  "offline",
  "summary",
  "install",
];

export interface InstallRun {
  queue: string[];
  current: string | null;
  done: string[];
  failed: { id: string; error: string }[];
  finished: boolean;
}

export interface WorkloadState {
  catalog: WorkloadCatalog | null;
  selection: Selection;
  plan: Plan | null;
  section: WorkloadSection;
  /** The first-run page is shown over the workbench. */
  firstRunOpen: boolean;
  /** Licences waiting for the user's decision before an install starts. */
  pendingLicenses: string[] | null;
  run: InstallRun | null;
  verify: Record<string, { ok: boolean; text: string }>;
  error: string | null;
}

/** What the service needs from the rest of the app. */
export interface WorkloadHost {
  ipc: WorkloadsIpc;
  events: EventBus<AppEvents>;
  /** RuntimeService.install: proxy-aware, retried, failures reach the network card. */
  install: (runtime: string, acceptLicense: boolean) => Promise<boolean>;
  /** The last install error of a runtime (RuntimeService state). */
  installError: (runtime: string) => string | null;
  refreshRuntimes: () => Promise<void>;
}

/**
 * Runtime Manager > Workloads and the first-run page: choose workloads, language packs or single components, see
 * what would be installed (sizes, dependencies, warnings), accept vendor licences, and install the selected
 * runtimes one after another. Nothing is downloaded until Install; skipping installs nothing.
 */
export class WorkloadService {
  private state: WorkloadState = {
    catalog: null,
    selection: EMPTY_SELECTION,
    plan: null,
    section: "welcome",
    firstRunOpen: false,
    pendingLicenses: null,
    run: null,
    verify: {},
    error: null,
  };
  private readonly listeners = new Set<() => void>();
  private planRequest = 0;
  private catalogRequest = 0;
  private requestedTab: string | null = null;
  /** Pages showing the catalog right now (the Workloads tab, the first-run page). */
  private viewers = 0;
  /** Install state changed since the catalog was read. */
  private stale = false;
  private reloadQueued = false;

  constructor(private readonly host: WorkloadHost) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = (): WorkloadState => this.state;

  private set(patch: Partial<WorkloadState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  /**
   * Reads the catalog (local state only: what is installed, the LSP bundle, tools on PATH) and the plan of the
   * current selection. The newest read wins; Verify results of runtimes that are no longer installed are dropped.
   */
  async load(): Promise<void> {
    const request = ++this.catalogRequest;
    this.stale = false;
    try {
      const catalog = await this.host.ipc.workloadsCatalog();
      if (request !== this.catalogRequest) return;
      this.set({ catalog, verify: keepInstalled(this.state.verify, catalog), error: null });
      await this.refreshPlan();
    } catch (error) {
      if (request === this.catalogRequest) this.set({ error: String(error) });
    }
  }

  /**
   * A page showing the catalog is on screen; call the returned function when it goes. Data that went stale while
   * nothing showed it is read again now.
   */
  attach(): () => void {
    this.viewers += 1;
    if (this.state.catalog === null || this.stale) void this.load();
    let attached = true;
    return () => {
      if (attached) this.viewers -= 1;
      attached = false;
    };
  }

  /**
   * Install state changed somewhere else (the Runtimes tab, Language Tools, another window). While a page shows the
   * catalog it is read again at once (one read for a burst of changes); otherwise on the next `attach()`, so no
   * version probe runs for a page nobody is looking at.
   */
  invalidate(): void {
    if (this.state.catalog === null) return;
    this.stale = true;
    if (this.viewers === 0 || this.reloadQueued) return;
    this.reloadQueued = true;
    queueMicrotask(() => {
      this.reloadQueued = false;
      if (this.stale && this.viewers > 0) void this.load();
    });
  }

  /**
   * Opens the first-run page on the very first launch only. It is recorded as shown the moment it opens, so closing the
   * app with the page still up doesn't bring it back (Help/`workloads.firstRun` and the Runtime Manager still reach it).
   */
  async maybeOpenFirstRun(): Promise<boolean> {
    try {
      if (!(await this.host.ipc.workloadsFirstRun())) return false;
    } catch {
      return false;
    }
    this.set({ firstRunOpen: true, section: "welcome" });
    await this.markFirstRunDone();
    await this.load();
    return true;
  }

  openFirstRun(): void {
    this.set({ firstRunOpen: true, section: "welcome" });
    void this.load();
  }

  /** Skip for now: nothing is installed and the first-run page doesn't come back. */
  async skip(): Promise<void> {
    this.set({ firstRunOpen: false, selection: EMPTY_SELECTION, plan: null, pendingLicenses: null });
    await this.markFirstRunDone();
  }

  async close(): Promise<void> {
    this.set({ firstRunOpen: false });
    await this.markFirstRunDone();
  }

  private async markFirstRunDone(): Promise<void> {
    try {
      await this.host.ipc.workloadsFirstRunDone();
    } catch {
      // Not worth a message: the page would only show once more.
    }
  }

  /** The Runtime Manager tab to show when it opens next (`workloads.open`). */
  requestTab(tab: string): void {
    this.requestedTab = tab;
  }

  /** The requested tab, without clearing it (a render may run twice before the dialog mounts). */
  peekRequestedTab(): string | null {
    return this.requestedTab;
  }

  takeRequestedTab(): string | null {
    const tab = this.requestedTab;
    this.requestedTab = null;
    return tab;
  }

  setSection(section: WorkloadSection): void {
    this.set({ section });
  }

  next(): void {
    const index = SECTIONS.indexOf(this.state.section);
    this.set({ section: SECTIONS[Math.min(index + 1, SECTIONS.length - 1)] ?? "install" });
  }

  back(): void {
    const index = SECTIONS.indexOf(this.state.section);
    this.set({ section: SECTIONS[Math.max(index - 1, 0)] ?? "welcome" });
  }

  isSelected(id: string): boolean {
    return this.state.catalog !== null && isSelected(this.state.selection, this.state.catalog, id);
  }

  toggleWorkload(id: string): void {
    this.select(toggleWorkload(this.state.selection, id));
  }

  toggleComponent(id: string): void {
    if (this.state.catalog) this.select(toggleComponent(this.state.selection, this.state.catalog, id));
  }

  togglePack(pack: Pack): void {
    if (this.state.catalog) this.select(togglePack(this.state.selection, this.state.catalog, pack));
  }

  private select(selection: Selection): void {
    this.set({ selection });
    void this.refreshPlan();
  }

  /** Asks the backend what the selection would install (the newest answer wins). */
  async refreshPlan(): Promise<void> {
    const request = ++this.planRequest;
    try {
      const plan = await this.host.ipc.workloadsPlan(this.state.selection);
      if (request === this.planRequest) this.set({ plan });
    } catch (error) {
      if (request === this.planRequest) this.set({ error: String(error) });
    }
  }

  /** Install selected: asks for the vendor licences first when the plan has any. */
  async installSelected(): Promise<void> {
    const plan = this.state.plan;
    if (plan === null || plan.install.length === 0 || this.state.run?.finished === false) return;
    if (plan.licenses.length > 0) {
      this.set({ pendingLicenses: plan.licenses });
      return;
    }
    await this.runQueue(plan.install, false);
  }

  /** The user accepted (`true`) or declined the licences; declining installs the rest without them. */
  async answerLicenses(accepted: boolean): Promise<void> {
    const plan = this.state.plan;
    const licenses = this.state.pendingLicenses ?? [];
    this.set({ pendingLicenses: null });
    if (plan === null) return;
    const queue = accepted ? plan.install : plan.install.filter((id) => !licenses.includes(id));
    if (queue.length > 0) await this.runQueue(queue, accepted);
  }

  /** Installs one runtime from its card (a licence is asked for first when it needs one). */
  async installOne(runtime: string, needsLicense: boolean): Promise<void> {
    if (needsLicense) {
      this.set({ pendingLicenses: [runtime], plan: { ...(this.state.plan ?? emptyPlan()), install: [runtime], licenses: [runtime] } });
      return;
    }
    await this.runQueue([runtime], false);
  }

  private async runQueue(queue: string[], acceptLicense: boolean): Promise<void> {
    let run: InstallRun = { queue, current: null, done: [], failed: [], finished: false };
    this.set({ run, section: this.state.firstRunOpen ? "install" : this.state.section });
    for (const id of queue) {
      run = { ...run, current: id };
      this.set({ run });
      const ok = await this.host.install(id, acceptLicense);
      run = ok
        ? { ...run, done: [...run.done, id] }
        : { ...run, failed: [...run.failed, { id, error: this.host.installError(id) ?? t("workloads.install.failed") }] };
      this.set({ run });
    }
    this.set({ run: { ...run, current: null, finished: true } });
    await this.host.refreshRuntimes();
    await this.load();
    this.host.events.emit("appNotice", {
      message: t("workloads.install.summary", { done: run.done.length, failed: run.failed.length }),
    });
  }

  /** Verify: runs the installed runtime's version command (a click only). */
  async verify(runtime: string): Promise<void> {
    try {
      const version = await this.host.ipc.runtimeVerify(runtime);
      this.set({ verify: { ...this.state.verify, [runtime]: { ok: true, text: version } } });
    } catch (error) {
      this.set({ verify: { ...this.state.verify, [runtime]: { ok: false, text: String(error) } } });
    }
  }
}

/** Verify results only for runtimes the catalog still lists as installed. */
function keepInstalled(verify: WorkloadState["verify"], catalog: WorkloadCatalog): WorkloadState["verify"] {
  const installed = new Set(
    catalog.components.filter((c) => c.state === "installed" && c.runtime !== null).map((c) => c.runtime),
  );
  return Object.fromEntries(Object.entries(verify).filter(([runtime]) => installed.has(runtime)));
}

function emptyPlan(): Plan {
  return { components: [], install: [], downloadBytes: 0, installBytes: 0, unknownSizes: 0, licenses: [], warnings: [] };
}
