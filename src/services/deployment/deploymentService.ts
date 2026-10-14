// Help > Network Deployment: this computer's facts, offering it on the local network, searching, the Network
// Deployment Test and provisioning this computer from a found deployment. UI-free; the dialog renders its state.
// Nothing here reaches the network unless the user clicks: opening the dialog only reads this computer's facts.
import type {
  DeployIpc,
  DeployStatus,
  DeploymentView,
  ProvisionKind,
  ProvisionOutcome,
  SearchView,
  TestReport,
} from "./deployIpc";

export type DeployBusy = "status" | "search" | "test" | "provision" | null;

export interface DeploymentState {
  open: boolean;
  status: DeployStatus | null;
  search: SearchView | null;
  report: TestReport | null;
  outcome: ProvisionOutcome | null;
  busy: DeployBusy;
  error: string | null;
  /** Extra addresses to ask (a source on another subnet), as typed. */
  targets: string;
  /** Verify the package by downloading it during the test. */
  downloadPackage: boolean;
}

/** One way to provision this computer from a deployment, or why it isn't offered. */
export interface ProvisionOption {
  kind: ProvisionKind;
  available: boolean;
  /** A text key when unavailable. */
  reason: string | null;
  needsFolder: boolean;
}

const EMPTY: DeploymentState = {
  open: false,
  status: null,
  search: null,
  report: null,
  outcome: null,
  busy: null,
  error: null,
  targets: "",
  downloadPackage: true,
};

/** Typed addresses: separated by commas, semicolons or spaces. */
export function targetsOf(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** What this computer can do with `deployment` (pure, so the dialog's buttons and their reasons are tested). */
export function provisionOptions(deployment: DeploymentView): ProvisionOption[] {
  const blocked = deployment.incompatible !== null;
  const has = (kind: "installer" | "portable") => deployment.manifest.packages.some((p) => p.kind === kind);
  const option = (kind: ProvisionKind, present: boolean, missing: string): ProvisionOption => ({
    kind,
    available: !blocked && present,
    reason: blocked ? "deploy.reason.incompatible" : present ? null : missing,
    needsFolder: kind !== "share",
  });
  return [
    option("share", deployment.manifest.kind === "networkShare", "deploy.reason.notShare"),
    option("setup", has("installer"), "deploy.reason.noSetup"),
    option("portable", has("portable"), "deploy.reason.noPortable"),
  ];
}

export class DeploymentService {
  private state: DeploymentState = EMPTY;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly ipc: DeployIpc) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): DeploymentState => this.state;

  private set(change: Partial<DeploymentState>): void {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }

  private async run<T>(busy: Exclude<DeployBusy, null>, job: () => Promise<T>): Promise<T | null> {
    if (this.state.busy !== null) return null;
    this.set({ busy, error: null });
    try {
      return await job();
    } catch (err) {
      this.set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    } finally {
      this.set({ busy: null });
    }
  }

  /** Opens the dialog and reads this computer's facts (no network). */
  async openDialog(): Promise<void> {
    this.set({ open: true, outcome: null });
    await this.refresh();
  }

  closeDialog(): void {
    this.set({ open: false });
  }

  setTargets(targets: string): void {
    this.set({ targets });
  }

  setDownloadPackage(downloadPackage: boolean): void {
    this.set({ downloadPackage });
  }

  async refresh(): Promise<void> {
    const status = await this.run("status", () => this.ipc.status());
    if (status) this.set({ status, search: status.lastSearch ?? this.state.search });
  }

  async search(): Promise<void> {
    const result = await this.run("search", () => this.ipc.search(targetsOf(this.state.targets)));
    if (!result) return;
    const status = this.state.status;
    this.set({
      search: result.search,
      status: status ? { ...status, deployments: result.deployments, lastSearch: result.search } : status,
    });
  }

  async runTest(): Promise<TestReport | null> {
    const report = await this.run("test", () =>
      this.ipc.test(targetsOf(this.state.targets), this.state.downloadPackage),
    );
    if (report) {
      this.set({ report, search: report.search });
      await this.refresh();
    }
    return report;
  }

  /** Trusts a found deployment on this computer (after the user confirmed it). */
  async trust(id: string): Promise<boolean> {
    const done = await this.run("provision", async () => {
      await this.ipc.trust(id);
      return true;
    });
    const status = this.state.status;
    if (done && status) {
      this.set({
        status: {
          ...status,
          deployments: status.deployments.map((d) => (d.id === id ? { ...d, trusted: true } : d)),
        },
      });
    }
    return done === true;
  }

  async provision(id: string, kind: ProvisionKind, destination: string | null): Promise<ProvisionOutcome | null> {
    const outcome = await this.run("provision", () => this.ipc.provision(id, kind, destination));
    if (outcome) this.set({ outcome });
    return outcome;
  }

  async launch(program: string): Promise<void> {
    try {
      await this.ipc.launch(program);
    } catch (err) {
      this.set({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** The offer setting changed: the backend applies it; the dialog shows the new state if it is open. */
  async applyOffering(): Promise<void> {
    try {
      const offer = await this.ipc.applyOffering();
      const status = this.state.status;
      if (status) this.set({ status: { ...status, offer } });
    } catch (err) {
      this.set({ error: err instanceof Error ? err.message : String(err) });
    }
  }
}

/** Where to install when the user picks `folder`: inside it, in `OpenMind Studio`, unless it already is that folder. */
export function destinationFor(folder: string): string {
  const trimmed = folder.replace(/[\\/]+$/, "");
  const name = trimmed.split(/[\\/]/).pop() ?? "";
  if (name.toLowerCase() === "openmind studio") return trimmed;
  const separator = trimmed.includes("/") && !trimmed.includes("\\") ? "/" : "\\";
  return `${trimmed}${separator}OpenMind Studio`;
}
