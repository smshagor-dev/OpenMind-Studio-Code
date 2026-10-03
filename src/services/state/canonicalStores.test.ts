import { describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../../testUtils/fakeIpcClient";
import { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import type { ExtensionsSnapshot } from "../extensionsIpc";
import { ExtensionRegistryService } from "../extensionRegistryService";
import type { RuntimeStatus } from "../ipc";
import { RuntimeService } from "../runtimeService";
import { ToolchainService } from "../toolchains/toolchainService";
import type { ToolchainPacks } from "../toolchains/toolchainIpc";
import type { CanonicalFeed } from "./canonicalStateService";

/** A feed the test drives: `push` is a delta of this domain arriving. */
function feed<T>(initial?: T) {
  let current = initial;
  const listeners = new Set<(data: T) => void>();
  const catchUp = vi.fn(() => Promise.resolve());
  const source: CanonicalFeed<T> = {
    current: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    catchUp,
    ready: () => Promise.resolve(),
  };
  return {
    source,
    catchUp,
    push: (data: T) => {
      current = data;
      for (const listener of listeners) listener(data);
    },
  };
}

function runtime(id: string, active: string | null): RuntimeStatus {
  return { id, displayName: id, activeVersion: active, installed: [], availableVersions: [], busy: false } as unknown as RuntimeStatus;
}

describe("stores following the canonical state", () => {
  it("the Runtime Manager follows installs, removals and switches without reading the list again", async () => {
    const ipc = createFakeIpc({ runtimeList: vi.fn().mockResolvedValue([]) });
    const service = new RuntimeService(ipc, new EventBus<AppEvents>());
    const runtimes = feed<RuntimeStatus[]>([runtime("node", null)]);
    service.useCanonical(runtimes.source);
    expect(service.getState().runtimes.map((r) => r.activeVersion)).toEqual([null]);

    runtimes.push([runtime("node", "24.1.0")]); // installed
    expect(service.getState().runtimes[0]?.activeVersion).toBe("24.1.0");
    runtimes.push([runtime("node", "22.0.0")]); // switched
    expect(service.getState().runtimes[0]?.activeVersion).toBe("22.0.0");
    runtimes.push([]); // removed (or deleted on disk)
    expect(service.getState().runtimes).toEqual([]);

    // An install from this window: the list arrives as a delta; the window only catches up.
    await service.install("node", "24.1.0");
    expect(ipc.runtimeInstall).toHaveBeenCalled();
    expect(runtimes.catchUp).toHaveBeenCalled();
    expect(ipc.runtimeList).not.toHaveBeenCalled();
  });

  it("before the backend has the runtimes the store shows them as not loaded yet, and reads nothing itself", async () => {
    const ipc = createFakeIpc({ runtimeList: vi.fn().mockResolvedValue([runtime("python", "3.14.7")]) });
    const service = new RuntimeService(ipc, new EventBus<AppEvents>());
    const runtimes = feed<RuntimeStatus[]>();
    service.useCanonical(runtimes.source);
    await service.refresh();
    expect(ipc.runtimeList).not.toHaveBeenCalled();
    expect(service.getState().loaded).toBe(false);
    runtimes.push([runtime("python", "3.14.7")]); // the backend's first read arrives
    expect(service.getState().loaded).toBe(true);
    expect(service.getState().runtimes[0]?.id).toBe("python");
  });

  it("Language Tools follows tool installs and removals from the canonical state", async () => {
    const ipc = createFakeIpc();
    const service = new ToolchainService(ipc);
    const tools = feed<ToolchainPacks>({ tools: [] } as unknown as ToolchainPacks);
    service.useCanonical(tools.source);
    expect(service.getState().loaded).toBe(true);
    const installed = { tools: [{ id: "ruff", activeVersion: "0.6.0" }] } as unknown as ToolchainPacks;
    tools.push(installed);
    expect(service.getState().packs).toBe(installed);
    await service.refresh();
    expect(tools.catchUp).toHaveBeenCalled();
    expect(ipc.toolchainsList).not.toHaveBeenCalled();
  });

  it("the extension list follows an extension copied in or removed by hand", async () => {
    const ipc = createFakeIpc();
    const events = new EventBus<AppEvents>();
    const changed = vi.fn();
    events.on("extensionsChanged", changed);
    const registry = new ExtensionRegistryService(events);
    const extensions = feed<ExtensionsSnapshot>();
    registry.useCanonical(extensions.source);
    const copied = { listing: { installed: [{ id: "a.b" }], broken: [] } } as unknown as ExtensionsSnapshot;
    extensions.push(copied);
    expect(registry.getState().snapshot).toBe(copied);
    expect(changed).toHaveBeenCalledTimes(1);
    await registry.refresh();
    expect(extensions.catchUp).toHaveBeenCalled();
    expect(ipc.extList).not.toHaveBeenCalled();
  });
});
