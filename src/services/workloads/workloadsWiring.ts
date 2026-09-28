import type { CommandRegistry } from "../commandRegistry";
import type { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import type { RuntimeService } from "../runtimeService";
import { tauriWorkloadsIpc, type WorkloadsIpc } from "./workloadsIpc";
import { WorkloadService } from "./workloadService";

export interface WorkloadsWiringDeps {
  ipc?: WorkloadsIpc;
  events: EventBus<AppEvents>;
  commands: CommandRegistry;
  runtime: Pick<RuntimeService, "install" | "getState" | "refresh">;
}

/**
 * Runtime Manager > Workloads and the first-run page. `workloads.open` opens the Runtime Manager on the Workloads
 * tab; `workloads.firstRun` shows the first-run page again. Installs go through the RuntimeService (proxy-aware,
 * retried, failures reach the network card).
 */
export function wireWorkloads(deps: WorkloadsWiringDeps): WorkloadService {
  const { runtime } = deps;
  const workloads = new WorkloadService({
    ipc: deps.ipc ?? tauriWorkloadsIpc,
    events: deps.events,
    install: (id, acceptLicense) => runtime.install(id, null, acceptLicense),
    installError: (id) => runtime.getState().errors[id] ?? null,
    refreshRuntimes: () => runtime.refresh(),
  });
  deps.commands.register("workloads.open", () => {
    workloads.requestTab("workloads");
    deps.events.emit("showRuntimeManager", undefined);
    void workloads.load();
  });
  deps.commands.register("workloads.firstRun", () => {
    workloads.openFirstRun();
  });
  return workloads;
}
