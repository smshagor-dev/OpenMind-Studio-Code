import type { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import type { LspService } from "../lspService";
import type { RuntimeService } from "../runtimeService";
import { runtimeVersions, TOOL_ROUTES } from "./toolInstallRoutes";

export interface ToolInstallState {
  /** Tools whose install is running. */
  busy: readonly string[];
}

export interface ToolInstallDeps {
  events: EventBus<AppEvents>;
  runtime: Pick<RuntimeService, "getState" | "install">;
  lsp: Pick<LspService, "install">;
  /** Installs a downloadable tool package into `tools/` (backend); resolves when it is there. */
  installPackage: (toolId: string) => Promise<void>;
  /** Removes an installed tool package. */
  removePackage: (toolId: string) => Promise<void>;
  /** Re-reads the tool list after a change. */
  refreshTools: () => Promise<void>;
  /** Asks before something with terms is installed; `true` = accepted. */
  acceptLicence: (licence: { tool: string; name: string; url: string }) => Promise<boolean>;
}

/**
 * Installs the tools of Runtime Manager > Language Tools, each the way it is already installed elsewhere: runtimes
 * through the Runtime Manager (a licence that must be accepted is asked first), language servers through the Language
 * Tools installer, tool packages through the backend's tool installer. Nothing is installed without a click.
 */
export class ToolInstallService {
  private state: ToolInstallState = { busy: [] };
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: ToolInstallDeps) {}

  getState = (): ToolInstallState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  isBusy(toolId: string): boolean {
    return this.state.busy.includes(toolId);
  }

  /** Installs `toolId` (and, for a runtime-backed tool, every runtime it still lacks). `true` when it is installed. */
  async install(toolId: string, toolName = toolId): Promise<boolean> {
    const route = TOOL_ROUTES[toolId];
    if (route === undefined || route.kind === "external" || this.isBusy(toolId)) return false;
    this.setBusy(toolId, true);
    try {
      if (route.kind === "server") return await this.deps.lsp.install(route.server);
      if (route.kind === "package") {
        await this.deps.installPackage(toolId);
        this.deps.events.emit("appNotice", { message: `${toolName} installed.` });
        return true;
      }
      for (const part of runtimeVersions(route.runtimes, this.deps.runtime.getState().runtimes)) {
        if (part.version !== null) continue;
        let accept = false;
        if (part.licence?.acceptanceRequired === true) {
          accept = await this.deps.acceptLicence({ tool: part.name, name: part.licence.name, url: part.licence.url });
          if (!accept) return false;
        }
        if (!(await this.deps.runtime.install(part.id, null, accept))) return false;
      }
      return true;
    } catch (error) {
      this.deps.events.emit("appError", { message: `Installing ${toolName} failed: ${String(error)}` });
      return false;
    } finally {
      this.setBusy(toolId, false);
      await this.deps.refreshTools().catch(() => undefined);
    }
  }

  /** Removes an installed tool package (runtimes and language servers are removed where they live). */
  async remove(toolId: string, toolName = toolId): Promise<boolean> {
    if (TOOL_ROUTES[toolId]?.kind !== "package" || this.isBusy(toolId)) return false;
    this.setBusy(toolId, true);
    try {
      await this.deps.removePackage(toolId);
      this.deps.events.emit("appNotice", { message: `${toolName} removed.` });
      return true;
    } catch (error) {
      this.deps.events.emit("appError", { message: `Removing ${toolName} failed: ${String(error)}` });
      return false;
    } finally {
      this.setBusy(toolId, false);
      await this.deps.refreshTools().catch(() => undefined);
    }
  }

  private setBusy(toolId: string, busy: boolean): void {
    const rest = this.state.busy.filter((id) => id !== toolId);
    this.state = { busy: busy ? [...rest, toolId] : rest };
    for (const listener of this.listeners) listener();
  }
}
