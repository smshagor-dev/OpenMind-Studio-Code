import type { CommandRegistry } from "../commandRegistry";
import type { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import type { LspService } from "../lspService";
import type { RuntimeService } from "../runtimeService";
import { tauriWorkloadsIpc, type WorkloadsIpc } from "./workloadsIpc";
import { WorkloadService } from "./workloadService";

export interface WorkloadsWiringDeps {
  ipc?: WorkloadsIpc;
  events: EventBus<AppEvents>;
  commands: CommandRegistry;
  runtime: Pick<RuntimeService, "install" | "getState" | "refresh" | "subscribe">;
  /** Language servers: installing or unpacking one changes the LSP components' state. */
  lsp?: Pick<LspService, "getState" | "subscribe">;
}

/**
 * Runtime Manager > Workloads and the first-run page. `workloads.open` opens the Runtime Manager on the Workloads
 * tab; `workloads.firstRun` shows the first-run page again. Installs go through the RuntimeService (proxy-aware,
 * retried, failures reach the network card). The backend stays the source of truth: when the runtime list or a
 * language server's install state changes anywhere (the Runtimes tab, Language Tools, another window), the catalog
 * is read again.
 */
export function wireWorkloads(deps: WorkloadsWiringDeps): WorkloadService {
  const { runtime, lsp } = deps;
  const workloads = new WorkloadService({
    ipc: deps.ipc ?? tauriWorkloadsIpc,
    events: deps.events,
    install: (id, acceptLicense) => runtime.install(id, null, acceptLicense),
    installError: (id) => runtime.getState().errors[id] ?? null,
    refreshRuntimes: () => runtime.refresh(),
  });
  followChanges(workloads, runtime, runtimeFingerprint);
  if (lsp) followChanges(workloads, lsp, lspFingerprint);
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

/** Invalidates the catalog when `fingerprint` of the source changes (progress and no-op refreshes don't count). */
function followChanges<S extends { subscribe: (listener: () => void) => () => void }>(
  workloads: WorkloadService,
  source: S,
  fingerprint: (source: S) => string,
): void {
  let last = fingerprint(source);
  source.subscribe(() => {
    const next = fingerprint(source);
    if (next === last) return;
    last = next;
    workloads.invalidate();
  });
}

/** Which runtime versions are installed, healthy and active. */
export function runtimeFingerprint(runtime: Pick<RuntimeService, "getState">): string {
  return runtime
    .getState()
    .runtimes.map(
      (r) =>
        `${r.id}=${r.activeVersion ?? ""}:${r.installed.map((v) => `${v.version}/${v.healthy ? 1 : 0}`).join(",")}`,
    )
    .join("|");
}

/** Which language servers are installed (or carried by the bundle). */
export function lspFingerprint(lsp: Pick<LspService, "getState">): string {
  const servers = lsp.getState().snapshot?.servers ?? [];
  return servers.map((s) => `${s.id}=${s.installed ? 1 : 0}${s.bundled ? 1 : 0}`).join("|");
}
