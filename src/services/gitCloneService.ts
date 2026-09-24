import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { GitService } from "./gitService";
import type { GitRuntime } from "./ipc";
import type { Availability } from "./runtimeService";

/** The folder name Git would pick for an address: its last part without `.git` ("" if there is none). */
export function deriveFolderName(url: string): string {
  const trimmed = url.trim().replace(/[\\/]+$/, "");
  const last = trimmed.split(/[\\/:]/).pop() ?? "";
  const name = last.replace(/\.git$/, "").trim();
  let hasControl = false;
  for (let index = 0; index < name.length; index++) {
    if (name.charCodeAt(index) < 32) hasControl = true;
  }
  const valid =
    name !== "" && name !== "." && name !== ".." && !hasControl && !/[\\/:*?"<>|]/.test(name);
  return valid ? name : "";
}

export interface CloneInput {
  runtime: GitRuntime | null;
  url: string;
  parent: string | null;
  name: string;
  busy: boolean;
}

/** Pure: whether Clone can run, and if not, why. */
export function cloneAvailability(input: CloneInput): Availability {
  if (input.runtime === null || !input.runtime.ready) {
    return { enabled: false, reason: input.runtime?.reason ?? "Git runtime is not installed yet." };
  }
  if (input.busy) return { enabled: false, reason: "A clone is already running." };
  if (input.url.trim() === "") {
    return { enabled: false, reason: "Enter the address of the repository to clone." };
  }
  if (input.parent === null) return { enabled: false, reason: "Choose a destination folder." };
  if (input.name.trim() === "") {
    return { enabled: false, reason: "Enter a folder name for the clone." };
  }
  return { enabled: true };
}

export interface CloneState {
  url: string;
  parent: string | null;
  /** What the user typed; `null` = follow the address. */
  customName: string | null;
  busy: boolean;
  error: string | null;
  /** The folder of the last successful clone, offered to open. */
  cloned: string | null;
  /** Whether the Clone form is showing. */
  formOpen: boolean;
}

const INITIAL: CloneState = {
  url: "",
  parent: null,
  customName: null,
  busy: false,
  error: null,
  cloned: null,
  formOpen: false,
};

/**
 * Clone Repository: the address, the destination folder and the folder name,
 * then one explicit Clone click. The destination must be new or empty — a folder
 * with anything in it is refused by the backend (nothing is ever overwritten or
 * emptied), and that message is shown as is. Credentials are never stored: a
 * remote that needs them fails with Git's own answer. Cloning never opens the
 * folder by itself; `openCloned()` is a separate click.
 */
export class GitCloneService {
  private state: CloneState = INITIAL;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly git: GitService,
    private readonly events: EventBus<AppEvents>,
    private readonly openFolder: (path: string) => Promise<unknown>,
    /** Which Git is usable (`SourceControlService.runtime`); `null` until known. */
    private readonly runtime: () => GitRuntime | null,
  ) {}

  getState(): CloneState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  name(): string {
    return this.state.customName ?? deriveFolderName(this.state.url);
  }

  cloneState(): Availability {
    return cloneAvailability({
      runtime: this.runtime(),
      url: this.state.url,
      parent: this.state.parent,
      name: this.name(),
      busy: this.state.busy,
    });
  }

  /** Why the Clone button that opens the form is disabled, or enabled. */
  entryState(): Availability {
    const runtime = this.runtime();
    return runtime !== null && !runtime.ready
      ? { enabled: false, reason: runtime.reason ?? "Git runtime is not installed yet." }
      : { enabled: true };
  }

  toggleForm(): void {
    this.update({ formOpen: !this.state.formOpen });
  }

  openForm(): void {
    if (!this.state.formOpen) this.update({ formOpen: true });
  }

  setUrl(url: string): void {
    this.update({ url, error: null, cloned: null });
  }

  setName(name: string): void {
    this.update({ customName: name, error: null });
  }

  /** Lets the user pick the folder the clone goes into. */
  async chooseFolder(): Promise<boolean> {
    const picked = await this.git.ipc.openFolderDialog();
    if (picked === null) return false;
    this.update({ parent: picked, error: null });
    return true;
  }

  async clone(): Promise<boolean> {
    if (!this.cloneState().enabled || this.state.parent === null) return false;
    const { url, parent } = this.state;
    const name = this.name();
    this.update({ busy: true, error: null, cloned: null });
    this.git.log(`Cloning into ${name}…`);
    try {
      const path = await this.git.ipc.gitClone(url.trim(), parent, name.trim());
      this.update({ busy: false, cloned: path });
      this.git.log(`Cloned to ${path}`);
      return true;
    } catch (error) {
      const message = String(error);
      this.update({ busy: false, error: message });
      this.git.log(`Error: ${message}`);
      this.events.emit("appError", { message });
      return false;
    }
  }

  /** Opens the cloned folder as the workspace (only when the user asks). */
  async openCloned(): Promise<boolean> {
    const path = this.state.cloned;
    if (path === null) return false;
    await this.openFolder(path);
    this.update({ cloned: null, url: "", customName: null });
    return true;
  }

  private update(patch: Partial<CloneState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
