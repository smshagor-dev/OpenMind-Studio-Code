import { describe, expect, it, vi } from "vitest";

import { createFakeIpc, idleStatus } from "../testUtils/fakeIpcClient";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { IndexStatus } from "./searchIpc";
import {
  indexSettingsFrom,
  WorkspaceIndexService,
  type IndexSettingsSource,
} from "./workspaceIndexService";

function settingsSource(
  values: Record<string, boolean | number | string> = {},
): IndexSettingsSource {
  const pick = <T extends boolean | number | string>(id: string, fallback: T): T =>
    (id in values ? values[id] : fallback) as T;
  return { bool: pick, number: pick, string: pick };
}

function rig(root: string | null = "C:/My Site", values = {}) {
  const pushed: ((status: IndexStatus) => void)[] = [];
  const ipc = createFakeIpc({
    onIndexStatus: vi.fn((listener: (status: IndexStatus) => void) => {
      pushed.push(listener);
      return Promise.resolve(() => undefined);
    }),
  });
  const events = new EventBus<AppEvents>();
  const errors: string[] = [];
  events.on("appError", ({ message }) => errors.push(message));
  const state = { root };
  const service = new WorkspaceIndexService(
    ipc,
    events,
    () => state.root,
    () => indexSettingsFrom(settingsSource(values)),
  );
  return { ipc, service, events, errors, pushed, state };
}

describe("indexSettingsFrom", () => {
  it("has safe defaults and turns the settings into the backend request", () => {
    expect(indexSettingsFrom(settingsSource())).toEqual({
      enabled: true,
      maxFileBytes: 1024 * 1024,
      maxTotalBytes: 256 * 1024 * 1024,
      useGitignore: true,
      indexHidden: false,
      exclude: [],
    });
    expect(
      indexSettingsFrom(
        settingsSource({
          "search.indexing.enabled": false,
          "search.indexing.maxFileSizeKb": 200,
          "search.indexing.exclude": " *.log , generated ,, ",
          "search.indexing.indexHiddenFiles": true,
        }),
      ),
    ).toMatchObject({
      enabled: false,
      maxFileBytes: 200 * 1024,
      exclude: ["*.log", "generated"],
      indexHidden: true,
    });
  });
});

describe("WorkspaceIndexService", () => {
  it("starts indexing when a folder opens and shows the status the backend pushes for that folder only", async () => {
    const { ipc, service, pushed } = rig();
    await service.listen();
    vi.mocked(ipc.indexStart).mockResolvedValue(idleStatus({ state: "indexing", discovered: 40 }));
    await service.onWorkspaceChanged();
    expect(ipc.indexStart).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }), false);
    expect(service.label()).toBe("Scanning 40 files…");

    pushed[0]?.(idleStatus({ state: "indexing", discovered: 40, processed: 10 }));
    expect(service.label()).toBe("Indexing 10/40");
    pushed[0]?.(idleStatus({ root: "C:/Other", state: "idle", indexed: 999 }));
    expect(service.getState().status?.processed).toBe(10); // another folder's status is ignored
    pushed[0]?.(idleStatus({ root: "c:\\my site\\", state: "idle", indexed: 12, symbols: 30 }));
    expect(service.label()).toBe("Index: 12 files");
    expect(service.isReady()).toBe(true);
    expect(service.detail()).toContain("12 files indexed");
    expect(service.detail()).toContain("30 symbols");
  });

  it("closing the folder forgets the status and shows nothing", async () => {
    const { service, state } = rig();
    await service.onWorkspaceChanged();
    state.root = null;
    await service.onWorkspaceChanged();
    expect(service.getState().status).toBeNull();
    expect(service.label()).toBe("");
    expect(service.actionReason("rebuild")).toBe("Open a folder first.");
  });

  it("ready means a finished pass with text in it; files can be searched by name while it is still building", async () => {
    const { service, pushed } = rig();
    await service.listen();
    expect(service.isReady()).toBe(false);
    expect(service.hasFiles()).toBe(false);
    pushed[0]?.(idleStatus({ state: "indexing", processed: 50, discovered: 200 }));
    expect(service.isReady()).toBe(false);
    expect(service.hasFiles()).toBe(true);
    pushed[0]?.(idleStatus({ state: "idle", indexed: 0 }));
    expect(service.isReady()).toBe(false);
    pushed[0]?.(idleStatus({ state: "error", error: "disk full" }));
    expect(service.label()).toBe("Index error");
    expect(service.detail()).toBe("disk full");
    expect(service.hasFiles()).toBe(false);
  });

  it("refresh, restart, rebuild, clear and cancel go to the backend with the current settings", async () => {
    const { ipc, service } = rig("C:/My Site", { "search.indexing.maxFileSizeKb": 500 });
    await service.refresh();
    expect(ipc.indexStart).toHaveBeenLastCalledWith(
      expect.objectContaining({ maxFileBytes: 500 * 1024 }),
      false,
    );
    await service.start(true);
    expect(ipc.indexStart).toHaveBeenLastCalledWith(expect.anything(), true);
    await service.rebuild();
    expect(ipc.indexRebuild).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
    vi.mocked(ipc.indexStatus).mockResolvedValue(idleStatus({ state: "none" }));
    await service.clear();
    expect(ipc.indexClear).toHaveBeenCalled();
    expect(service.getState().status?.state).toBe("none");
    await service.cancel();
    expect(ipc.indexCancel).toHaveBeenCalled();
  });

  it("every action says why it is off: no folder, indexing disabled, nothing to cancel or clear", async () => {
    const { service, pushed } = rig("C:/My Site", { "search.indexing.enabled": false });
    await service.listen();
    expect(service.actionReason("start")).toContain("turned off");
    expect(service.actionReason("rebuild")).toContain("turned off");
    expect(service.actionReason("cancel")).toBe("Nothing is being indexed.");
    expect(service.actionReason("clear")).toBe("The search index is empty.");
    pushed[0]?.(idleStatus({ state: "indexing" }));
    expect(service.actionReason("cancel")).toBeNull();
    pushed[0]?.(idleStatus({ state: "idle", indexed: 3 }));
    expect(service.actionReason("clear")).toBeNull();
    const enabled = rig();
    expect(enabled.service.actionReason("start")).toBeNull();
    expect(enabled.service.actionReason("rebuild")).toBeNull();
  });

  it("a failing command is an error toast and the service stays usable", async () => {
    const { ipc, service, errors } = rig();
    vi.mocked(ipc.indexRebuild).mockRejectedValue("the search index couldn't be used: locked");
    await service.rebuild();
    expect(errors[0]).toContain("locked");
    expect(service.getState()).toMatchObject({ busy: false });
    expect(service.getState().error).toContain("locked");
  });

  it("a saved file inside the folder is sent to the index; files outside it or with indexing off are not", async () => {
    const { ipc, service, pushed } = rig();
    await service.listen();
    pushed[0]?.(idleStatus({ state: "idle", indexed: 3 }));
    await service.touch("C:\\My Site\\src\\a.ts");
    expect(ipc.indexTouch).toHaveBeenCalledWith(["C:\\My Site\\src\\a.ts"]);
    await service.touch("C:/My Site Copy/a.ts");
    await service.touch("C:/Elsewhere/a.ts");
    expect(ipc.indexTouch).toHaveBeenCalledTimes(1);
    pushed[0]?.(idleStatus({ state: "disabled" }));
    await service.touch("C:/My Site/b.ts");
    expect(ipc.indexTouch).toHaveBeenCalledTimes(1);
    expect(service.label()).toBe("Index: off");
  });
});
