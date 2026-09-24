import { defaultConfigs } from "./debugModel";
import type { LaunchConfig } from "./ipc";

/**
 * Launch configurations. Only generated ones exist for now — "Python: Current File" and
 * "Node.js: Current File", running the file in front in the workspace folder — so there is no
 * "add configuration" to offer: nothing here that can't really run.
 */
export class DebugConfigurationService {
  private chosen: string | null = null;
  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The configurations offered for the file in front. */
  configsFor(path: string | null, workspace: string | null): LaunchConfig[] {
    return path === null ? [] : defaultConfigs(path, workspace);
  }

  /** The chosen configuration, or the first one offered. */
  current(path: string | null, workspace: string | null): LaunchConfig | null {
    const configs = this.configsFor(path, workspace);
    return configs.find((config) => config.name === this.chosen) ?? configs[0] ?? null;
  }

  choose(name: string): void {
    this.chosen = name;
    for (const listener of this.listeners) listener();
  }
}
