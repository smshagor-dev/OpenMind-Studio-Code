import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { CommandRegistry } from "./commandRegistry";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { InstalledVersion, InstallProgress, IpcClient, RuntimeStatus } from "./ipc";
import { registerRuntimeCommands } from "./runtimeCommands";
import { describeProgress, injectionStatus, RuntimeService } from "./runtimeService";

function status(overrides: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return {
    id: "node",
    displayName: "Node.js",
    description: "JS runtime",
    notes: "",
    defaultVersion: "24.21.0",
    availableVersions: ["24.21.0", "24.20.0"],
    installed: [],
    activeVersion: null,
    globalVersion: null,
    requires: [],
    license: null,
    downloadBytes: null,
    installBytes: null,
    busy: false,
    ...overrides,
  };
}

const INSTALLED = status({
  installed: [
    { version: "24.21.0", path: "C:/rt/24.21.0", active: true, healthy: true, features: [] },
    { version: "24.20.0", path: "C:/rt/24.20.0", active: false, healthy: true, features: [] },
  ],
  activeVersion: "24.21.0",
});

function progress(overrides: Partial<InstallProgress> = {}): InstallProgress {
  return {
    kind: "node",
    version: "24.21.0",
    phase: "download",
    current: 50,
    total: 200,
    ...overrides,
  };
}

describe("describeProgress", () => {
  it("labels every phase and computes a percentage", () => {
    expect(describeProgress(progress())).toEqual({ label: "Downloading 25%", percent: 25 });
    expect(describeProgress(progress({ phase: "verify", current: 1, total: 1 }))).toEqual({
      label: "Verifying checksum 100%",
      percent: 100,
    });
    expect(describeProgress(progress({ phase: "extract", current: 3, total: 4 })).label).toBe(
      "Extracting 75%",
    );
    expect(describeProgress(progress({ phase: "finalize", current: 0, total: null }))).toEqual({
      label: "Finishing up…",
      percent: null,
    });
  });

  it("is indeterminate without a total and never exceeds 100", () => {
    expect(describeProgress(progress({ total: null })).percent).toBeNull();
    expect(describeProgress(progress({ total: 0 })).percent).toBeNull();
    expect(describeProgress(progress({ current: 900, total: 100 })).percent).toBe(100);
  });
});

describe("injectionStatus", () => {
  const entry = (overrides: Partial<InstalledVersion>): InstalledVersion => ({
    version: "3.14.7",
    path: "p",
    active: true,
    healthy: true,
    features: [],
    ...overrides,
  });

  it("only the active, healthy version is on new terminals' PATH", () => {
    expect(injectionStatus(entry({}))).toEqual({
      injected: true,
      label: "In new terminals' PATH",
    });
    expect(injectionStatus(entry({ active: false }))).toMatchObject({ injected: false });
    expect(injectionStatus(entry({ active: false })).label).toContain("not the active version");
  });

  it("a damaged install is not injected and says why", () => {
    const view = injectionStatus(entry({ healthy: false }));

    expect(view.injected).toBe(false);
    expect(view.label).toContain("needs repair");
  });
});

describe("RuntimeService", () => {
  let events: EventBus<AppEvents>;
  let ipc: IpcClient;
  let pushProgress: (p: InstallProgress) => void;

  function make(overrides: Partial<IpcClient> = {}) {
    ipc = createFakeIpc({
      runtimeList: vi.fn().mockResolvedValue([status()]),
      onRuntimeProgress: vi.fn((handler: typeof pushProgress) => {
        pushProgress = handler;
        return Promise.resolve(() => undefined);
      }),
      ...overrides,
    });
    return new RuntimeService(ipc, events);
  }

  beforeEach(() => {
    events = new EventBus<AppEvents>();
  });

  it("loads the runtime list and notifies subscribers", async () => {
    const service = make();
    const listener = vi.fn();
    service.subscribe(listener);

    await service.refresh();

    expect(service.getState().loaded).toBe(true);
    expect(service.getState().runtimes.map((r) => r.id)).toEqual(["node"]);
    expect(listener).toHaveBeenCalled();
  });

  it("a failed load surfaces as appError instead of throwing", async () => {
    const service = make({ runtimeList: vi.fn().mockRejectedValue(new Error("db locked")) });
    const errors: string[] = [];
    events.on("appError", ({ message }) => errors.push(message));

    await service.refresh();

    expect(errors).toHaveLength(1);
    expect(service.getState().loaded).toBe(true);
  });

  it("install passes the chosen version, tracks the working state, shows progress and refreshes after", async () => {
    let finish: () => void = () => undefined;
    const service = make({
      runtimeInstall: vi.fn(
        () =>
          new Promise<InstalledVersion>((resolve) => {
            finish = () => {
              resolve({ version: "24.21.0", path: "p", active: true, healthy: true, features: [] });
            };
          }),
      ),
    });
    await service.initialize();
    await service.refresh();

    const done = service.install("node", "24.21.0");
    expect(service.getState().working).toEqual({ node: "install" });
    pushProgress(progress());
    expect(service.getState().progress.node?.phase).toBe("download");
    expect(service.isBusy("node")).toBe(true);
    finish();
    await done;

    expect(ipc.runtimeInstall).toHaveBeenCalledWith("node", "24.21.0", false);
    expect(service.getState().working).toEqual({});
    expect(service.getState().progress).toEqual({});
    expect(ipc.runtimeList).toHaveBeenCalledTimes(2);
  });

  it("keeps a failure next to its runtime, with the backend's recovery advice, until dismissed", async () => {
    const service = make({
      runtimeInstall: vi
        .fn()
        .mockRejectedValue(
          "download failed: offline. Check your internet connection and try again.",
        ),
    });

    const ok = await service.install("node", null);

    expect(ok).toBe(false);
    expect(service.getState().errors.node).toContain("Check your internet connection");
    expect(service.getState().working).toEqual({});

    service.dismissError("node");
    expect(service.getState().errors).toEqual({});
  });

  it("starting a new operation clears that runtime's previous error", async () => {
    const service = make({
      runtimeInstall: vi.fn().mockRejectedValueOnce("boom").mockResolvedValue({}),
    });
    await service.install("node", null);
    expect(service.getState().errors.node).toBe("boom");

    await service.install("node", null);

    expect(service.getState().errors).toEqual({});
  });

  it("refuses to start a second operation on a runtime that is already busy", async () => {
    let finish: () => void = () => undefined;
    const service = make({
      runtimeInstall: vi.fn(
        () =>
          new Promise<InstalledVersion>((resolve) => {
            finish = () => {
              resolve({ version: "1", path: "p", active: true, healthy: true, features: [] });
            };
          }),
      ),
    });
    const first = service.install("node", "24.21.0");

    const second = await service.remove("node", "24.20.0");

    expect(second).toBe(false);
    expect(ipc.runtimeDelete).not.toHaveBeenCalled();
    finish();
    await first;
  });

  it("switching the active version, deleting and repairing call the matching backend commands", async () => {
    const service = make({ runtimeRepair: vi.fn().mockResolvedValue(true) });

    await service.setActive("node", "24.20.0");
    await service.remove("node", "24.20.0");
    const repaired = await service.repair("node", "24.21.0");

    expect(ipc.runtimeSetActive).toHaveBeenCalledWith("node", "24.20.0");
    expect(ipc.runtimeDelete).toHaveBeenCalledWith("node", "24.20.0");
    expect(ipc.runtimeRepair).toHaveBeenCalledWith("node", "24.21.0");
    expect(repaired).toBe(true);
  });

  it("subscribes to progress once, however many times it is initialized", async () => {
    const service = make();

    await service.initialize();
    await service.initialize();

    expect(ipc.onRuntimeProgress).toHaveBeenCalledTimes(1);
  });

  describe("action availability (nothing is disabled without a reason)", () => {
    it("install is enabled for an available, not-yet-installed version", () => {
      const service = make();

      expect(service.installAvailability(status(), "24.21.0")).toEqual({ enabled: true });
    });

    it("install is disabled with a reason when the version is installed, unknown, unset or unavailable", () => {
      const service = make();

      for (const [runtime, version] of [
        [INSTALLED, "24.21.0"],
        [status(), "1.2.3"],
        [status(), null],
        [status({ availableVersions: [] }), "24.21.0"],
      ] as const) {
        const result = service.installAvailability(runtime, version);
        expect(result.enabled).toBe(false);
        expect(result.reason).toBeTruthy();
      }
    });

    it("repair is only enabled for an unhealthy install", () => {
      const service = make();
      const damaged = status({
        installed: [{ version: "24.21.0", path: "p", active: true, healthy: false, features: [] }],
      });

      expect(service.repairAvailability(INSTALLED, "24.21.0").enabled).toBe(false);
      expect(service.repairAvailability(INSTALLED, "24.21.0").reason).toContain("intact");
      expect(service.repairAvailability(damaged, "24.21.0")).toEqual({ enabled: true });
    });

    it("set-active is disabled for the active version and for a damaged one", () => {
      const service = make();
      const damaged = status({
        installed: [
          { version: "1", path: "p", active: true, healthy: true, features: [] },
          { version: "2", path: "p", active: false, healthy: false, features: [] },
        ],
      });

      expect(service.activateAvailability(INSTALLED, "24.21.0").enabled).toBe(false);
      expect(service.activateAvailability(INSTALLED, "24.20.0")).toEqual({ enabled: true });
      expect(service.activateAvailability(damaged, "2").reason).toContain("Repair");
    });

    it("every action is disabled while the backend reports the runtime busy", () => {
      const service = make();
      const busy = { ...INSTALLED, busy: true };

      expect(service.installAvailability(busy, "24.19.0").enabled).toBe(false);
      expect(service.deleteAvailability(busy).enabled).toBe(false);
      expect(service.repairAvailability(busy, "24.21.0").enabled).toBe(false);
      expect(service.activateAvailability(busy, "24.20.0").enabled).toBe(false);
    });

    it("delete is enabled when idle", () => {
      expect(make().deleteAvailability(INSTALLED)).toEqual({ enabled: true });
    });
  });
});

describe("runtime.manage command", () => {
  it("asks the UI to open the Runtime Manager", async () => {
    const events = new EventBus<AppEvents>();
    const commands = new CommandRegistry();
    registerRuntimeCommands(commands, events);
    const opened = vi.fn();
    events.on("showRuntimeManager", opened);

    await commands.execute("runtime.manage");

    expect(opened).toHaveBeenCalledTimes(1);
  });
});
