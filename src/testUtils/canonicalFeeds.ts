import type { RuntimeStatus } from "../services/ipc";
import type { PortsService } from "../services/portsService";
import type { ServersState } from "../services/state/canonicalIpc";
import { followServerPorts } from "../services/state/serverPorts";
import { ToolchainService } from "../services/toolchains/toolchainService";
import type { CanonicalFeed, WorkspaceFeed } from "../services/state/canonicalStateService";
import type { FakeIpc } from "./fakeIpcClient";

/**
 * A canonical feed backed by a read of the fake IPC — the test stand-in for the backend: `catchUp` reads the domain
 * the way the backend would and delivers it as a delta. `push` delivers a state directly (a change elsewhere).
 */
export function ipcFeed<T>(read: () => Promise<T>): CanonicalFeed<T> & { push: (data: T) => void } {
  let current: T | undefined;
  const listeners = new Set<(data: T) => void>();
  const push = (data: T) => {
    current = data;
    for (const listener of [...listeners]) listener(data);
  };
  const catchUp = async () => {
    try {
      push(await read());
    } catch {
      // A failing backend read leaves the last state, as the real canonical state does.
    }
  };
  return {
    current: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    catchUp,
    ready: () => (current === undefined ? catchUp() : Promise.resolve()),
    push,
  };
}

/** A per-workspace feed backed by a read of the fake IPC: `refresh` reads the folder's domain and delivers it. */
export function ipcWorkspaceFeed<T>(
  read: () => Promise<T>,
): WorkspaceFeed<T> & { push: (data: T | undefined) => void } {
  let current: T | undefined;
  const listeners = new Set<(data: T | undefined) => void>();
  const push = (data: T | undefined) => {
    current = data;
    for (const listener of [...listeners]) listener(data);
  };
  return {
    active: () => true,
    current: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh: async () => {
      push(await read());
    },
    push,
  };
}

/**
 * Feeds for every canonical domain, reading the fake backend data of `ipc` — what the real backend would deliver.
 * A test attaches the ones it needs with each store's `useCanonical`.
 */
export function backendFeeds(ipc: FakeIpc) {
  return {
    runtimes: ipcFeed(() => ipc.runtimeList()),
    tools: ipcFeed(() => ipc.toolchainsList()),
    languageServers: ipcFeed(() => ipc.lspStatus()),
    extensions: ipcFeed(() => ipc.extList()),
    servers: ipcFeed(async (): Promise<ServersState> => ({ php: await ipc.phpServerStatus(), mysql: await ipc.mysqlStatus() })),
    git: ipcWorkspaceFeed(() => ipc.gitSnapshot()),
    project: ipcWorkspaceFeed(() => ipc.languageWorkspaceStatus()),
    debug: ipcWorkspaceFeed(async () => {
      const status = await ipc.debugStatus();
      return { workspace: status.workspace, python: status.python, node: status.node, php: status.php };
    }),
  };
}

type Follows<T> = { useCanonical: (feed: T) => () => void };

/**
 * Connects the stores a test built to the fake backend, the way `state/canonicalWiring.ts` connects them to the
 * canonical state in the app (the managed servers' ports included). Returns the feeds, so a test can `push` a change.
 */
export function connectBackend(
  ipc: FakeIpc,
  stores: {
    runtime?: Follows<CanonicalFeed<RuntimeStatus[]>>;
    servers?: Follows<CanonicalFeed<ServersState>>[];
    ports?: Pick<PortsService, "register" | "unregisterSource" | "list">;
  },
): ReturnType<typeof backendFeeds> {
  const feeds = backendFeeds(ipc);
  stores.runtime?.useCanonical(feeds.runtimes);
  for (const store of stores.servers ?? []) store.useCanonical(feeds.servers);
  const ports = stores.ports;
  if (ports !== undefined) {
    feeds.servers.subscribe((servers) => {
      followServerPorts(ports, servers);
    });
  }
  return feeds;
}

/** Attaches `feed` to `store` (a store built inline in a test's object literal) and returns the store. */
export function following<F, S extends { useCanonical: (feed: F) => unknown }>(store: S, feed: F): S {
  store.useCanonical(feed);
  return store;
}

/** A ToolchainService following the fake backend's canonical tool list. */
export function toolchainsFrom(ipc: FakeIpc): ToolchainService {
  return following(new ToolchainService(ipc), ipcFeed(() => ipc.toolchainsList()));
}
