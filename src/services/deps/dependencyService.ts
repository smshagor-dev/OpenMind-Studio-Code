import { t } from "../../i18n";
import type { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import type { ConfirmPrompt } from "../extensionPromptService";
import { diagnoseDependency, type DependencyIssue } from "./dependencyModel";
import type { DependencyActions } from "./dependencyActions";
import type { DepsIpc, DepsOp, InstallKind, ProjectInfo } from "./depsIpc";

export interface DependencyState {
  issue: DependencyIssue | null;
  /** The failed program's file, or the terminal's folder: the project is found from here. */
  base: string | null;
  /** "Terminal", "Python" (Run Code) ... */
  source: string;
  /** Run Code's Output reported it (Run in Terminal is offered). */
  fromRunCode: boolean;
  info: ProjectInfo | null;
  busy: boolean;
  error: string | null;
  notice: string | null;
}

export interface DependencyHost {
  ipc: Pick<DepsIpc, "depsProjectInfo">;
  events: EventBus<AppEvents>;
  confirm: (request: Omit<ConfirmPrompt, "kind" | "id">) => Promise<string | null>;
  /** The Dependencies view's runner (plan, confirmation, program in a terminal, real exit code): one path for both. */
  actions: Pick<DependencyActions, "perform">;
  openFile: (path: string) => void;
  /** Runtime Manager (on the Workloads tab). */
  openRuntimeManager: () => void;
  /** Run Code in Terminal for the active file. */
  runActiveInTerminal: () => void;
  /** Tcl/Tk GUI support for OpenMind's portable Python (a Runtime Manager add-on), when it can be added now. */
  pythonGui?: PythonGuiHost;
  now?: () => number;
}

export interface PythonGuiHost {
  /** The active portable Python's version and the add-on's details, or `null` when it can't be added. */
  addable: () => { version: string; label: string; downloadBytes: number | null; license: string | null } | null;
  /** Downloads (checksum-verified) and adds it; `null` when it worked, otherwise why not. */
  add: (version: string) => Promise<string | null>;
  /** Reloads what the Runtime Manager knows (the list may not have been loaded yet). */
  refresh: () => Promise<void>;
}

/** A dismissed issue stays quiet this long. */
const QUIET_MS = 2 * 60 * 1000;

function issueKey(issue: DependencyIssue): string {
  switch (issue.kind) {
    case "toolMissing":
      return `tool:${issue.tool}`;
    case "headerMissing":
      return `header:${issue.header}`;
    default:
      return `${issue.kind}:${issue.module}`;
  }
}

/**
 * The dependency helper: when a program fails because something is missing, a card says what and offers a safe way to
 * get it. Nothing is ever installed without a confirmation that shows the exact command, the folder and where it goes;
 * Python packages only go into the project's venv or OpenMind's portable Python (the backend refuses anything else),
 * npm packages into the project; Python's own modules (tkinter ...) and compilers are pointed to the Runtime Manager.
 */
export class DependencyService {
  private state: DependencyState = {
    issue: null,
    base: null,
    source: "",
    fromRunCode: false,
    info: null,
    busy: false,
    error: null,
    notice: null,
  };
  private readonly listeners = new Set<() => void>();
  private readonly quietUntil = new Map<string, number>();
  private infoRequest = 0;

  constructor(private readonly host: DependencyHost) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = (): DependencyState => this.state;

  private set(patch: Partial<DependencyState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  private now(): number {
    return (this.host.now ?? Date.now)();
  }

  /** Looks at a failed program's output. Shows the card when something is missing; `true` if it did. */
  report(text: string, base: string | null, source: string, fromRunCode = false): boolean {
    const issue = diagnoseDependency(text);
    if (issue === null) return false;
    const key = issueKey(issue);
    if (this.state.issue !== null && issueKey(this.state.issue) === key) return true;
    if ((this.quietUntil.get(key) ?? 0) > this.now()) return false;
    this.set({ issue, base, source, fromRunCode, info: null, error: null, notice: null });
    if (base !== null) void this.loadInfo(base);
    if (issue.kind === "pythonComponent" && issue.tk) void this.loadPythonGui();
    return true;
  }

  private async loadInfo(base: string): Promise<void> {
    const request = ++this.infoRequest;
    try {
      const info = await this.host.ipc.depsProjectInfo(base);
      if (request === this.infoRequest) this.set({ info });
    } catch {
      // Without project details the card still offers the Runtime Manager and manual guidance.
    }
  }

  /** The card asks `pythonGui()` when it draws; a fresh runtime list makes the answer current. */
  private async loadPythonGui(): Promise<void> {
    try {
      await this.host.pythonGui?.refresh();
    } catch {
      // Without the list the card still explains and offers the Runtime Manager.
    }
    this.set({});
  }

  dismiss(): void {
    const issue = this.state.issue;
    if (issue !== null) this.quietUntil.set(issueKey(issue), this.now() + QUIET_MS);
    this.set({ issue: null, info: null, error: null, notice: null });
  }

  /** The package pip / npm would install for the current issue. */
  packageName(): string | null {
    const issue = this.state.issue;
    return issue?.kind === "pythonPackage" || issue?.kind === "nodePackage" ? issue.package : null;
  }

  /** The operation for one of the card's install buttons. */
  private opFor(kind: InstallKind): DepsOp | null {
    const name = this.packageName();
    switch (kind) {
      case "pip":
      case "pipOffline":
        return name === null ? null : { op: "pythonAdd", packages: name, offline: kind === "pipOffline" };
      case "pipRequirements":
        return { op: "pythonInstallRequirements" };
      case "npm":
        return name === null ? null : { op: "nodeAdd", package: name, dev: false };
      case "npmProject":
        return { op: "nodeInstall" };
    }
  }

  /**
   * Install, through the same backend as the Dependencies view: the exact command is shown first, and after the
   * confirmation it runs in a new terminal whose exit code is the program's.
   */
  async install(kind: InstallKind): Promise<boolean> {
    const base = this.state.base;
    const op = this.opFor(kind);
    if (base === null || op === null) return false;
    this.set({ busy: true, error: null, notice: null });
    try {
      const outcome = await this.host.actions.perform({ base, op }, t("deps.title"));
      switch (outcome.status) {
        case "done":
          this.set({ issue: null, info: null, notice: t("deps.installed") });
          return true;
        case "refused":
          this.set({ error: outcome.reason });
          return false;
        case "failed":
          this.set({
            error: outcome.code === null ? t("deps.installStopped") : t("deps.installFailed", { code: outcome.code }),
          });
          return false;
        case "cancelled":
          return false;
      }
    } finally {
      this.set({ busy: false });
    }
  }

  /** The Tcl/Tk add-on for the tkinter card, when OpenMind's Python can take it. */
  pythonGui(): ReturnType<PythonGuiHost["addable"]> {
    return this.state.issue?.kind === "pythonComponent" && this.state.issue.tk
      ? (this.host.pythonGui?.addable() ?? null)
      : null;
  }

  /** Adds Tcl/Tk GUI support to OpenMind's portable Python, after a confirmation that says what and from where. */
  async addPythonGui(): Promise<boolean> {
    const gui = this.pythonGui();
    const host = this.host.pythonGui;
    if (gui === null || host === undefined) return false;
    const size = gui.downloadBytes === null ? "" : ` (${(gui.downloadBytes / 1_048_576).toFixed(1)} MB)`;
    const answer = await this.host.confirm({
      extension: t("deps.title"),
      title: t("deps.tk.confirm.title", { version: gui.version }),
      details: [
        { label: t("deps.tk.confirm.what"), value: gui.label },
        { label: t("deps.confirm.into"), value: t("deps.tk.confirm.into", { version: gui.version }) },
        { label: t("deps.tk.confirm.download"), value: `python.org tcltk.msi${size}` },
        ...(gui.license === null ? [] : [{ label: t("deps.tk.confirm.license"), value: gui.license }]),
      ],
      notes: [t("deps.tk.confirm.note")],
      buttons: [t("deps.tk.add")],
    });
    if (answer === null) return false;
    this.set({ busy: true, error: null });
    try {
      const failure = await host.add(gui.version);
      if (failure !== null) {
        this.set({ error: `${t("deps.tk.failed")} ${failure}` });
        return false;
      }
      this.set({ issue: null, info: null, notice: t("deps.tk.added") });
      this.host.events.emit("appNotice", { message: t("deps.tk.added") });
      return true;
    } finally {
      this.set({ busy: false });
    }
  }

  openRequirements(): void {
    const path = this.state.info?.requirementsTxt;
    if (path) this.host.openFile(path);
  }

  openRuntimeManager(): void {
    this.host.openRuntimeManager();
  }

  runInTerminal(): void {
    this.set({ issue: null });
    this.host.runActiveInTerminal();
  }
}
