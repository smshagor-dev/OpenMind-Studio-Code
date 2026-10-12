import { describe, expect, it, vi } from "vitest";

import { interruptions, mandatoryBlocks, percent, restartBlocker, statusText } from "./updateModel";
import type { UpdateInfo, UpdateIpc, UpdateProgress } from "./updateIpc";
import { UpdateService, type UpdateHost } from "./updateService";

function info(overrides: Partial<UpdateInfo> = {}): UpdateInfo {
  return {
    current: "1.0.2",
    available: false,
    version: null,
    notes: null,
    date: null,
    install: "nsis",
    mode: { kind: "installer" },
    phase: "upToDate",
    mandatory: false,
    ready: false,
    installOnExit: false,
    automatic: true,
    downloaded: 0,
    total: null,
    failure: null,
    lastChecked: null,
    releasesPage: "https://github.com/smshagor-dev/OpenMind-Studio/releases/latest",
    activity: { unsaved: 0, terminals: 0, busyTerminals: 0, runs: 0 },
    ...overrides,
  };
}

const ready = (overrides: Partial<UpdateInfo> = {}) =>
  info({ available: true, version: "1.1.0", phase: "ready", ready: true, installOnExit: true, ...overrides });

function rig(start: UpdateInfo, host: Partial<UpdateHost> = {}) {
  let current = start;
  let stateListener: ((next: UpdateInfo) => void) | null = null;
  let progressListener: ((next: UpdateProgress) => void) | null = null;
  const ipc = {
    status: vi.fn(() => Promise.resolve(current)),
    check: vi.fn(() => Promise.resolve(current)),
    download: vi.fn(() => {
      current = { ...current, phase: "ready", ready: true };
      return Promise.resolve(current);
    }),
    installNow: vi.fn(() => Promise.resolve()),
    setInstallOnExit: vi.fn(() => Promise.resolve()),
    reportUnsaved: vi.fn(() => Promise.resolve()),
    onState: vi.fn((listener: (next: UpdateInfo) => void) => {
      stateListener = listener;
      return Promise.resolve(() => undefined);
    }),
    onProgress: vi.fn((listener: (next: UpdateProgress) => void) => {
      progressListener = listener;
      return Promise.resolve(() => undefined);
    }),
  } satisfies UpdateIpc;
  let unsaved = 0;
  let dirtyListener: (() => void) | null = null;
  const fullHost: UpdateHost = {
    unsavedCount: () => unsaved,
    onUnsavedChange: (listener) => {
      dirtyListener = listener;
      return () => undefined;
    },
    saveAll: vi.fn(() => {
      unsaved = 0;
      return Promise.resolve();
    }),
    confirm: vi.fn(() => Promise.resolve(true)),
    notify: vi.fn(),
    text: (key, params) => `${key}${params ? JSON.stringify(params) : ""}`,
    openExternal: vi.fn(() => Promise.resolve()),
    ...host,
  };
  const service = new UpdateService(ipc, fullHost);
  return {
    ipc,
    host: fullHost,
    service,
    setUnsaved: (count: number) => {
      unsaved = count;
      dirtyListener?.();
    },
    setInfo: (next: UpdateInfo) => {
      current = next;
    },
    emit: (next: UpdateInfo) => stateListener?.(next),
    progress: (next: UpdateProgress) => progressListener?.(next),
  };
}

describe("the update status in the status bar", () => {
  it("is silent while up to date and while a network problem is retried", () => {
    expect(statusText(null)).toBeNull();
    expect(statusText(info())).toBeNull();
    expect(statusText(info({ phase: "failed", failure: { kind: "network", message: "dns" } }))).toBeNull();
  });

  it("shows downloading, ready, a managed update and a real problem", () => {
    const downloading = statusText(info({ phase: "downloading", version: "1.1.0", downloaded: 50, total: 200 }));
    expect(downloading).toEqual({
      key: "update.status.downloadingPercent",
      params: { version: "1.1.0", percent: 25 },
      prominent: false,
    });
    expect(statusText(ready())?.key).toBe("update.status.ready");
    expect(
      statusText(info({ phase: "available", version: "1.1.0", mode: { kind: "managed", reason: "admin" } }))?.key,
    ).toBe("update.status.managed");
    expect(statusText(info({ phase: "failed", failure: { kind: "signature", message: "x" } }))?.prominent).toBe(true);
    expect(percent({ downloaded: 5, total: null })).toBeNull();
  });
});

describe("a mandatory update", () => {
  it("blocks only once it is downloaded, verified and installable here", () => {
    expect(mandatoryBlocks(ready({ mandatory: true }), false)).toBe(true);
    // Not downloaded yet (offline, server down): no lockout.
    expect(mandatoryBlocks(info({ mandatory: true, available: true, phase: "available" }), false)).toBe(false);
    // A shared installation can't be updated from here: no lockout.
    expect(mandatoryBlocks(ready({ mandatory: true, mode: { kind: "managed", reason: "admin" } }), false)).toBe(false);
    // The install failed and the user chose to continue: no lockout.
    expect(mandatoryBlocks(ready({ mandatory: true }), true)).toBe(false);
    // An ordinary new version never blocks.
    expect(mandatoryBlocks(ready(), false)).toBe(false);
  });
});

describe("UpdateService", () => {
  it("follows the backend and tells it how many editors are unsaved", async () => {
    const r = rig(info());
    r.setUnsaved(2);
    await r.service.start();
    expect(r.ipc.reportUnsaved).toHaveBeenCalledWith(2);
    r.setUnsaved(0);
    expect(r.ipc.reportUnsaved).toHaveBeenLastCalledWith(0);
    r.emit(info({ phase: "downloading", version: "1.1.0", available: true }));
    r.progress({ version: "1.1.0", downloaded: 10, total: 100 });
    expect(r.service.getState().info?.downloaded).toBe(10);
    // Starting checks nothing and downloads nothing: the backend's schedule does.
    expect(r.ipc.check).not.toHaveBeenCalled();
    expect(r.ipc.download).not.toHaveBeenCalled();
  });

  it("Check for Updates downloads a found update when updates are automatic, and never for a shared installation", async () => {
    const r = rig(info({ available: true, version: "1.1.0", phase: "available" }));
    await r.service.checkNow();
    expect(r.ipc.download).toHaveBeenCalledTimes(1);
    expect(r.service.getState().info?.ready).toBe(true);

    const managed = rig(info({ available: true, phase: "available", mode: { kind: "managed", reason: "admin" } }));
    await managed.service.checkNow();
    expect(managed.ipc.download).not.toHaveBeenCalled();

    const manual = rig(info({ available: true, phase: "available", automatic: false }));
    await manual.service.checkNow();
    expect(manual.ipc.download).not.toHaveBeenCalled();
  });

  it("Restart to Update never runs while an editor is unsaved, in any window", async () => {
    const r = rig(ready({ activity: { unsaved: 1, terminals: 0, busyTerminals: 0, runs: 0 } }));
    await r.service.start();
    await r.service.restartToUpdate();
    expect(r.ipc.installNow).not.toHaveBeenCalled();
    expect(r.service.getState().error).toContain("update.blocked.unsaved");
    expect(restartBlocker(ready({ activity: { unsaved: 2, terminals: 0, busyTerminals: 0, runs: 0 } }))?.params).toEqual({
      count: 2,
    });
  });

  it("asks before stopping running programs, and does nothing when the user says no", async () => {
    const busy = ready({ activity: { unsaved: 0, terminals: 2, busyTerminals: 1, runs: 1 } });
    expect(interruptions(busy)).toBe(2);
    const declined = rig(busy, { confirm: vi.fn(() => Promise.resolve(false)) });
    await declined.service.restartToUpdate();
    expect(declined.host.confirm).toHaveBeenCalled();
    expect(declined.ipc.installNow).not.toHaveBeenCalled();
    const agreed = rig(busy);
    await agreed.service.restartToUpdate();
    expect(agreed.ipc.installNow).toHaveBeenCalledWith(true);
  });

  it("restarts at once when nothing would be interrupted (idle terminals just close)", async () => {
    const r = rig(ready({ activity: { unsaved: 0, terminals: 3, busyTerminals: 0, runs: 0 } }));
    await r.service.restartToUpdate();
    expect(r.host.confirm).not.toHaveBeenCalled();
    expect(r.ipc.installNow).toHaveBeenCalledWith(false);
  });

  it("an install that fails is reported, and a mandatory update then lets the user continue", async () => {
    const r = rig(ready({ mandatory: true }));
    r.ipc.installNow.mockImplementation(() => Promise.reject(new Error("Access is denied. (os error 5)")));
    await r.service.restartToUpdate();
    expect(r.service.getState().error).toContain("Access is denied");
    r.service.continueAfterFailure();
    expect(mandatoryBlocks(r.service.getState().info, r.service.getState().continuedAfterFailure)).toBe(false);
  });

  it("Save All saves, reports the new count and refreshes", async () => {
    const r = rig(ready());
    r.setUnsaved(3);
    await r.service.saveAll();
    expect(r.host.saveAll).toHaveBeenCalled();
    expect(r.ipc.reportUnsaved).toHaveBeenLastCalledWith(0);
  });
});
