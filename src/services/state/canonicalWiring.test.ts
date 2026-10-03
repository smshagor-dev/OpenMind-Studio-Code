import { describe, expect, it, vi } from "vitest";

import { STOPPED_MYSQL } from "../../testUtils/fakeIpcClient";
import { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import type { CanonicalIpc, StateDelta, StateSnapshot } from "./canonicalIpc";
import { CanonicalStateService } from "./canonicalStateService";
import { wireCanonical } from "./canonicalWiring";

function follower() {
  return { useCanonical: vi.fn(() => () => undefined) };
}

async function rig() {
  let deliver: (delta: StateDelta) => void = () => undefined;
  let folder: string | null = "c:/a";
  const ipc = {
    onDelta: vi.fn((handler: (delta: StateDelta) => void) => {
      deliver = handler;
      return Promise.resolve(() => undefined);
    }),
    snapshot: vi.fn(() => Promise.resolve({ revision: 0, workspace: folder ?? undefined, domains: [] } as StateSnapshot)),
    revision: vi.fn(() => Promise.resolve(0)),
    attach: vi.fn(() => Promise.resolve(folder)),
    refresh: vi.fn(() => Promise.resolve()),
  } satisfies CanonicalIpc;
  const canonical = new CanonicalStateService(ipc);
  await canonical.start();
  const events = new EventBus<AppEvents>();
  const ports = { register: vi.fn(() => ""), unregisterSource: vi.fn(), list: vi.fn(() => []) };
  const folderToolsChanged = vi.fn();
  const followers = {
    toolchains: follower(),
    lsp: follower(),
    extensions: follower(),
    php: follower(),
    mySql: follower(),
    mariaDb: follower(),
    phpMyAdmin: follower(),
    sourceControl: follower(),
    dependencies: follower(),
    language: follower(),
    debug: follower(),
  };
  wireCanonical({ canonical, events, ports, folderToolsChanged, ...followers });
  return {
    ipc,
    canonical,
    events,
    ports,
    folderToolsChanged,
    followers,
    deliver: (delta: StateDelta) => {
      deliver(delta);
    },
    openFolder: (key: string | null) => {
      folder = key;
    },
  };
}

describe("wireCanonical", () => {
  it("connects every migrated store to its feed", async () => {
    const r = await rig();
    for (const store of Object.values(r.followers)) expect(store.useCanonical).toHaveBeenCalledTimes(1);
  });

  it("a folder's project or dependency change asks the per-file questions again; another folder's doesn't", async () => {
    const r = await rig();
    r.deliver({ revision: 1, domain: "dependencies", scope: "c:/a", data: { projects: [] } } as unknown as StateDelta);
    expect(r.folderToolsChanged).toHaveBeenCalledTimes(1);
    r.deliver({ revision: 2, domain: "project", scope: "c:/b", data: null, tick: true });
    expect(r.folderToolsChanged).toHaveBeenCalledTimes(1);
    r.deliver({ revision: 3, domain: "project", scope: "c:/a", data: { projects: [] } } as unknown as StateDelta);
    expect(r.folderToolsChanged).toHaveBeenCalledTimes(2);
  });

  it("the managed servers' ports follow the servers state", async () => {
    const r = await rig();
    r.deliver({
      revision: 1,
      domain: "servers",
      data: {
        php: { run: { runId: "x", file: "", pid: 1 }, url: "http://127.0.0.1:8000", port: 8000, phpVersion: null },
        mysql: STOPPED_MYSQL,
      },
    });
    expect(r.ports.register).toHaveBeenCalledWith(expect.objectContaining({ port: 8000, source: "php-server" }));
  });

  it("opening another folder attaches it and reads that folder's state", async () => {
    const r = await rig();
    r.openFolder("c:/b");
    r.events.emit("workspaceFolderChanged", undefined as never);
    await vi.waitFor(() => {
      expect(r.canonical.currentWorkspace()).toBe("c:/b");
    });
    expect(r.ipc.attach).toHaveBeenCalledTimes(2);
    expect(r.ipc.snapshot).toHaveBeenCalledTimes(2);
  });
});
