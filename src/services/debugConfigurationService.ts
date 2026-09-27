import { defaultConfigs } from "./debugModel";
import type { IpcClient, LaunchConfig } from "./ipc";
import type { DebugConfigurations, ExtensionDebugger } from "./workflowIpc";

/** One entry of the configuration picker. */
export interface DebugConfigEntry {
  /** `builtin::<name>` or `<launch.json path>::<name>`. */
  id: string;
  name: string;
  /** Where it comes from: "Built-in", ".vscode/launch.json", ... */
  sourceLabel: string;
  /** Set when it can run. */
  config: LaunchConfig | null;
  /** Why it can't run (another debugger type, attach, a compound, a missing variable ...). */
  problem: string | null;
  notes: string[];
}

export interface DebugConfigState {
  data: DebugConfigurations;
  /** Problems reading the launch files (not JSON, no configurations list). */
  fileErrors: string[];
  chosen: string | null;
  recent: string[];
}

const RECENT_KEY = "debug.recentConfigurations";
const MAX_RECENT = 5;
const EMPTY: DebugConfigurations = { files: [], extensionDebuggers: [] };

function shortSource(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts.slice(-2).join("/");
}

/**
 * Launch configurations: the built-in "Current File" ones (Python, Node.js) and the folder's own, from
 * `.openmind/launch.json` and `.vscode/launch.json` (read by the backend, variables expanded for the file in front).
 * Configurations that can't run are listed with the reason, never hidden; recently used ones come first. Reading the
 * files never starts anything.
 */
export class DebugConfigurationService {
  private state: DebugConfigState = { data: EMPTY, fileErrors: [], chosen: null, recent: [] };
  private readonly listeners = new Set<() => void>();
  private loadedRecent = false;

  constructor(
    private readonly ipc?: Pick<IpcClient, "debugConfigurations" | "settingsGet" | "settingsSet">,
  ) {}

  getState(): DebugConfigState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Re-reads the launch files (for the file in front: `${file}` depends on it). */
  async refresh(activeFile: string | null): Promise<void> {
    if (!this.ipc) return;
    if (!this.loadedRecent) {
      this.loadedRecent = true;
      try {
        const raw = await this.ipc.settingsGet(RECENT_KEY);
        const recent: unknown = raw === null ? [] : JSON.parse(raw);
        if (Array.isArray(recent)) {
          this.state = {
            ...this.state,
            recent: recent.filter((r): r is string => typeof r === "string"),
          };
        }
      } catch {
        // No saved list.
      }
    }
    try {
      const data = await this.ipc.debugConfigurations(activeFile);
      const fileErrors = data.files
        .filter((f) => f.error !== null)
        .map((f) => `${shortSource(f.path)}: ${f.error ?? ""}`);
      this.set({ data, fileErrors });
    } catch (error) {
      this.set({
        data: EMPTY,
        fileErrors: [`The launch configurations couldn't be read: ${String(error)}`],
      });
    }
  }

  /** Every configuration for the file in front: recently used first, then built-in, then the launch files'. */
  entries(path: string | null, workspace: string | null): DebugConfigEntry[] {
    const builtIn: DebugConfigEntry[] = (path === null ? [] : defaultConfigs(path, workspace)).map(
      (config) => ({
        id: `builtin::${config.name}`,
        name: config.name,
        sourceLabel: "Built-in",
        config,
        problem: null,
        notes: [],
      }),
    );
    const fromFiles: DebugConfigEntry[] = this.state.data.files.flatMap((file) => [
      ...file.configurations.map((found) => ({
        id: `${file.path}::${found.name}`,
        name: found.name,
        sourceLabel: shortSource(file.path),
        config: found.config,
        problem: found.problem,
        notes: found.notes,
      })),
      ...file.compounds.map((compound) => ({
        id: `${file.path}::compound::${compound.name}`,
        name: `${compound.name} (compound)`,
        sourceLabel: shortSource(file.path),
        config: null,
        problem: compound.problem,
        notes: [],
      })),
    ]);
    const rank = (entry: DebugConfigEntry) => {
      const index = this.state.recent.indexOf(entry.id);
      return index === -1 ? Number.MAX_SAFE_INTEGER : index;
    };
    return [...builtIn, ...fromFiles]
      .map((entry, order) => ({ entry, order }))
      .sort((a, b) => rank(a.entry) - rank(b.entry) || a.order - b.order)
      .map((item) => item.entry);
  }

  /** Debugger types extensions declare (shown as unsupported in the view). */
  extensionDebuggers(): ExtensionDebugger[] {
    return this.state.data.extensionDebuggers;
  }

  /** The chosen entry, or the first one that can run (else the first). */
  currentEntry(path: string | null, workspace: string | null): DebugConfigEntry | null {
    const entries = this.entries(path, workspace);
    return (
      entries.find((entry) => entry.id === this.state.chosen) ??
      entries.find((entry) => entry.config !== null) ??
      entries[0] ??
      null
    );
  }

  /** The configuration that starts now, if the chosen one can run. */
  current(path: string | null, workspace: string | null): LaunchConfig | null {
    return this.currentEntry(path, workspace)?.config ?? null;
  }

  choose(id: string): void {
    this.set({ chosen: id });
  }

  /** A configuration was started: it moves to the top of the list (kept for the next start of the app). */
  recordUsed(id: string): void {
    const recent = [id, ...this.state.recent.filter((r) => r !== id)].slice(0, MAX_RECENT);
    this.set({ recent });
    void this.ipc?.settingsSet(RECENT_KEY, JSON.stringify(recent)).catch(() => undefined);
  }

  private set(patch: Partial<DebugConfigState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
