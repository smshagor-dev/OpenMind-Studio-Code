import { describe, expect, it, vi } from "vitest";

import { CommandRegistry } from "../commandRegistry";
import { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import type { InstalledVersion, LspServerInfo, LspSnapshot, RuntimeStatus } from "../ipc";
import type { LspState } from "../lspService";
import type { RuntimeState } from "../runtimeService";
import { CATALOG } from "./workloadModel.test";
import type { WorkloadsIpc } from "./workloadsIpc";
import { wireWorkloads } from "./workloadsWiring";

/** A store standing in for RuntimeService / LspService: `set` changes the state and tells the subscribers. */
class Source<T> {
  private readonly listeners = new Set<() => void>();
  constructor(private state: T) {}
  getState = (): T => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  set(state: T): void {
    this.state = state;
    for (const listener of [...this.listeners]) listener();
  }
}

function runtimeStatus(id: string, installed: string[]): RuntimeStatus {
  const versions: InstalledVersion[] = installed.map((version) => ({ version, path: "", active: true, healthy: true, features: [] }));
  return { id, installed: versions, activeVersion: installed[0] ?? null } as unknown as RuntimeStatus;
}

function runtimeState(runtimes: RuntimeStatus[], progress: RuntimeState["progress"] = {}): RuntimeState {
  return { loaded: true, runtimes, progress, working: {}, errors: {} };
}

function lspState(installed: boolean): LspState {
  const server = { id: "intelephense", installed, bundled: false, state: "stopped" } as unknown as LspServerInfo;
  return { snapshot: { servers: [server] } as unknown as LspSnapshot };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function rig() {
  const ipc: WorkloadsIpc = {
    workloadsCatalog: vi.fn().mockResolvedValue(CATALOG),
    workloadsPlan: vi.fn().mockResolvedValue({ components: [], install: [], downloadBytes: 0, installBytes: 0, unknownSizes: 0, licenses: [], warnings: [] }),
    workloadsFirstRun: vi.fn().mockResolvedValue(false),
    workloadsFirstRunDone: vi.fn().mockResolvedValue(undefined),
    runtimeVerify: vi.fn().mockResolvedValue("1.0"),
  };
  const runtimes = new Source(runtimeState([runtimeStatus("ninja", ["1.13.2"])]));
  const lsp = new Source(lspState(false));
  const runtime = {
    getState: runtimes.getState,
    subscribe: runtimes.subscribe,
    install: vi.fn().mockResolvedValue(true),
    refresh: vi.fn().mockResolvedValue(undefined),
  };
  const workloads = wireWorkloads({ ipc, events: new EventBus<AppEvents>(), commands: new CommandRegistry(), runtime, lsp });
  return { ipc, runtimes, lsp, workloads };
}

describe("wireWorkloads", () => {
  it("a runtime deleted or installed elsewhere re-reads the shown catalog; progress and no-op refreshes don't", async () => {
    const r = rig();
    r.workloads.attach();
    await flush();
    expect(r.ipc.workloadsCatalog).toHaveBeenCalledTimes(1);
    // Download progress and a refresh that found the same list change nothing.
    r.runtimes.set(runtimeState([runtimeStatus("ninja", ["1.13.2"])], { ninja: { kind: "ninja", version: "1.13.2", phase: "downloading" } as never }));
    r.runtimes.set(runtimeState([runtimeStatus("ninja", ["1.13.2"])]));
    await flush();
    expect(r.ipc.workloadsCatalog).toHaveBeenCalledTimes(1);
    // Deleted from the Runtimes tab.
    r.runtimes.set(runtimeState([runtimeStatus("ninja", [])]));
    await flush();
    expect(r.ipc.workloadsCatalog).toHaveBeenCalledTimes(2);
    // Installed again.
    r.runtimes.set(runtimeState([runtimeStatus("ninja", ["1.13.2"])]));
    await flush();
    expect(r.ipc.workloadsCatalog).toHaveBeenCalledTimes(3);
  });

  it("a language server installed from Language Tools re-reads it too", async () => {
    const r = rig();
    r.workloads.attach();
    await flush();
    r.lsp.set(lspState(false));
    await flush();
    expect(r.ipc.workloadsCatalog).toHaveBeenCalledTimes(1);
    r.lsp.set(lspState(true));
    await flush();
    expect(r.ipc.workloadsCatalog).toHaveBeenCalledTimes(2);
  });

  it("with the page closed nothing is read until it is shown again", async () => {
    const r = rig();
    const detach = r.workloads.attach();
    await flush();
    detach();
    r.runtimes.set(runtimeState([runtimeStatus("ninja", [])]));
    await flush();
    expect(r.ipc.workloadsCatalog).toHaveBeenCalledTimes(1);
    r.workloads.attach();
    await flush();
    expect(r.ipc.workloadsCatalog).toHaveBeenCalledTimes(2);
  });
});
