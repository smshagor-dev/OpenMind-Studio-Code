import { describe, expect, it, vi } from "vitest";

import { createFakeIpc, STOPPED_MYSQL } from "../../testUtils/fakeIpcClient";
import { languageRig, workspaceStatus } from "../../testUtils/languageFixtures";
import { DependenciesService, type DependenciesHost } from "../deps/dependenciesService";
import type { DepsSnapshot } from "../deps/depsIpc";
import { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import type { MySqlStatus, PhpServerInfo, ServiceInfo } from "../ipc";
import type { WorkspaceStatus } from "../language/languageIpc";
import { MariaDbService } from "../mariaDbService";
import { MySqlService } from "../mySqlService";
import { OutputService } from "../outputService";
import { PanelService } from "../panelService";
import { PhpServerService } from "../phpServerService";
import { PortsService } from "../portsService";
import { RuntimeService } from "../runtimeService";
import type { ServersState } from "./canonicalIpc";
import type { CanonicalFeed, WorkspaceFeed } from "./canonicalStateService";
import { followServerPorts, portsFromServers } from "./serverPorts";

/** A per-workspace feed the test drives: `push` is a delta for this window's folder (`undefined`: folder changed). */
function workspaceFeed<T>(initial?: T) {
  let current = initial;
  const listeners = new Set<(data: T | undefined) => void>();
  const refresh = vi.fn(() => Promise.resolve());
  const source: WorkspaceFeed<T> = {
    active: () => true,
    current: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
  };
  return {
    source,
    refresh,
    push: (data: T | undefined) => {
      current = data;
      for (const listener of listeners) listener(data);
    },
  };
}

function globalFeed<T>(initial?: T) {
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

const deps = (name: string): DepsSnapshot => ({ projects: [{ name }] }) as unknown as DepsSnapshot;

function depsRig() {
  const events = new EventBus<AppEvents>();
  const host: DependenciesHost = {
    actions: { perform: vi.fn().mockResolvedValue({ status: "done" }) },
    events,
    settingsGet: vi.fn().mockResolvedValue(null),
    settingsSet: vi.fn().mockResolvedValue(undefined),
  };
  return { host, events, service: new DependenciesService(host) };
}

function info(port: number, ready = true, url: string | null = null): ServiceInfo {
  return { run: { runId: `r${String(port)}`, file: "", pid: port }, port, url, ready, version: null, phpVersion: null };
}

function servers(php: PhpServerInfo | null, mysql: Partial<MySqlStatus> = {}): ServersState {
  return { php, mysql: { ...STOPPED_MYSQL, ...mysql } };
}

const PHP: PhpServerInfo = {
  run: { runId: "php-1", file: "", pid: 4242 },
  url: "http://127.0.0.1:8000",
  port: 8000,
  phpVersion: "8.4.26",
};

describe("per-workspace stores following the canonical state", () => {
  it("Dependencies shows the folder's shared scan and never scans on its own", async () => {
    const r = depsRig();
    const feed = workspaceFeed<DepsSnapshot>(deps("from the backend"));
    r.service.useCanonical(feed.source);
    await r.service.initialize();
    expect(r.service.getState().snapshot).toEqual(deps("from the backend"));
    // A saved manifest, another folder: the backend's watcher reads the folder once for every window.
    r.events.emit("documentSaved", { id: "d", path: "C:/w/package.json" });
    r.events.emit("workspaceFolderChanged", undefined as never);
    feed.push(deps("after npm install"));
    expect(r.service.getState().snapshot).toEqual(deps("after npm install"));
    // An explicit refresh (after an operation) asks the backend's shared read.
    await r.service.refresh();
    expect(feed.refresh).toHaveBeenCalledTimes(1);
    // The window opened another folder: nothing stale is shown.
    feed.push(undefined);
    expect(r.service.getState().snapshot).toBeNull();
  });

  it("project status follows the folder's canonical state; a saved manifest doesn't scan again", async () => {
    vi.useFakeTimers();
    try {
      const rig = languageRig();
      await rig.support.initialize();
      const feed = workspaceFeed<WorkspaceStatus>(workspaceStatus());
      rig.support.useCanonical(feed.source);
      expect(rig.support.getState().workspace).toEqual(workspaceStatus());
      rig.events.emit("documentSaved", { id: "d", path: "C:/w/package.json" });
      await vi.advanceTimersByTimeAsync(1000);
      expect(rig.ipc.languageWorkspaceStatus).not.toHaveBeenCalled();
      feed.push(undefined);
      expect(rig.support.getState().workspace).toBeNull();
      await rig.support.refresh();
      expect(feed.refresh).toHaveBeenCalledTimes(1);
      expect(rig.ipc.languageWorkspaceStatus).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("managed servers and ports from the canonical servers state", () => {
  it("lists every running managed server's port, and none when they stop", () => {
    expect(portsFromServers(servers(null))).toEqual([]);
    const running = portsFromServers(
      servers(PHP, { mariadb: info(3306, false), phpmyadmin: info(8081, true, "http://127.0.0.1:8081") }),
    );
    expect(running.map((port) => `${port.source}:${String(port.port)}:${port.label}`)).toEqual([
      "php-server:8000:PHP Server",
      "mariadb:3306:MariaDB (starting)",
      "phpmyadmin:8081:phpMyAdmin",
    ]);
  });

  it("the Ports view follows a server starting, moving to another port and stopping", () => {
    const ports = new PortsService(createFakeIpc(), new EventBus<AppEvents>());
    ports.register({ port: 5173, label: "Vite", source: "task" });
    followServerPorts(ports, servers(PHP, { mariadb: info(3306) }));
    expect(ports.list().map((entry) => entry.id).sort()).toEqual(["mariadb:3306", "php-server:8000", "task:5173"]);
    followServerPorts(ports, servers({ ...PHP, port: 8001 }, { mariadb: info(3306) }));
    expect(ports.list().map((entry) => entry.id).sort()).toEqual(["mariadb:3306", "php-server:8001", "task:5173"]);
    followServerPorts(ports, servers(null));
    expect(ports.list().map((entry) => entry.id)).toEqual(["task:5173"]);
  });

  it("MariaDB's running state comes from the canonical state; its configuration details are asked for on demand", async () => {
    const ipc = createFakeIpc();
    const events = new EventBus<AppEvents>();
    const mariaDb = new MariaDbService(ipc, events, new OutputService(), new RuntimeService(ipc, events), new PanelService(ipc));
    const feed = globalFeed<ServersState>(servers(null));
    mariaDb.useCanonical(feed.source);
    await vi.waitFor(() => {
      expect(ipc.mariadbStatus).toHaveBeenCalledTimes(1); // the details, once, for what is there now
    });
    feed.push(servers(null, { initialized: true, mariadb: info(3306, false) })); // started
    expect(mariaDb.getState().server?.port).toBe(3306);
    feed.push(servers(null, { initialized: true, mariadb: info(3306, false), error: "other" })); // nothing of its own
    feed.push(servers(null, { initialized: true, mariadb: info(3306, true) })); // ready
    await vi.waitFor(() => {
      expect(ipc.mariadbStatus).toHaveBeenCalledTimes(3);
    });
    feed.push(servers(null, { initialized: true })); // stopped
    expect(mariaDb.getState().server).toBeNull();
  });

  it("the PHP server and MySQL rows follow the canonical state without asking the backend", async () => {
    const ipc = createFakeIpc();
    const events = new EventBus<AppEvents>();
    const output = new OutputService();
    const runtime = new RuntimeService(ipc, events, () => undefined);
    const php = new PhpServerService(ipc, events, output, runtime, new PanelService(ipc));
    const mySql = new MySqlService(ipc, events, output);
    const feed = globalFeed<ServersState>(servers(null));
    php.useCanonical(feed.source);
    mySql.useCanonical(feed.source);

    feed.push(servers(PHP, { state: "running", mariadb: info(3306), phpmyadmin: info(8081) }));
    expect(php.getState().server?.pid).toBe(4242);
    expect(mySql.getState().status?.state).toBe("running");

    await php.syncServer();
    await mySql.refresh();
    expect(feed.catchUp).toHaveBeenCalledTimes(2);
    expect(ipc.phpServerStatus).not.toHaveBeenCalled();
    expect(ipc.mysqlStatus).not.toHaveBeenCalled();

    feed.push(servers(null));
    expect(php.getState().server).toBeNull();
    expect(mySql.getState().status?.state).toBe("stopped");
  });
});
