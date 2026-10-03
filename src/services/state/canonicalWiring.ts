import type { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import type { PortsService } from "../portsService";
import type { CanonicalStateService } from "./canonicalStateService";
import type { CanonicalFeed, WorkspaceFeed } from "./canonicalStateService";
import type { DomainData, ServersState } from "./canonicalIpc";
import { followServerPorts } from "./serverPorts";

type Follower<T> = { useCanonical: (feed: T) => () => void };

export interface CanonicalWiringDeps {
  canonical: CanonicalStateService;
  events: EventBus<AppEvents>;
  /** Global domains. */
  toolchains: Follower<CanonicalFeed<DomainData["tools"]>>;
  lsp: Follower<CanonicalFeed<DomainData["languageServers"]>>;
  extensions: Follower<CanonicalFeed<DomainData["extensions"]>>;
  php: Follower<CanonicalFeed<ServersState>>;
  mySql: Follower<CanonicalFeed<ServersState>>;
  mariaDb: Follower<CanonicalFeed<ServersState>>;
  phpMyAdmin: Follower<CanonicalFeed<ServersState>>;
  ports: Pick<PortsService, "register" | "unregisterSource" | "list">;
  /** Per-workspace domains (this window's folder). */
  sourceControl: Follower<WorkspaceFeed<DomainData["git"]>>;
  dependencies: Follower<WorkspaceFeed<DomainData["dependencies"]>>;
  language: Follower<WorkspaceFeed<DomainData["project"]>>;
  debug: Follower<WorkspaceFeed<DomainData["debug"]>>;
  /**
   * Per-file answers that depend on the folder's installed tools (the formatter status, language servers for open
   * files): asked again when the folder's projects or dependencies change (a project-local Prettier, a `.venv`).
   */
  folderToolsChanged: () => void;
}

/**
 * Connects the window's stores to the canonical state (`src-tauri/src/state`). Global stores follow their domain;
 * per-workspace stores follow this window's folder, which the window attaches whenever it opens another one (the
 * backend then sends that folder's state, read once for every window on it). Returns the way to stop.
 */
export function wireCanonical(deps: CanonicalWiringDeps): () => void {
  const { canonical } = deps;
  const offs = [
    deps.toolchains.useCanonical(canonical.feed("tools")),
    deps.lsp.useCanonical(canonical.feed("languageServers")),
    deps.extensions.useCanonical(canonical.feed("extensions")),
    deps.php.useCanonical(canonical.feed("servers")),
    deps.mySql.useCanonical(canonical.feed("servers")),
    deps.mariaDb.useCanonical(canonical.feed("servers")),
    deps.phpMyAdmin.useCanonical(canonical.feed("servers")),
    deps.sourceControl.useCanonical(canonical.workspaceFeed("git")),
    deps.dependencies.useCanonical(canonical.workspaceFeed("dependencies")),
    deps.language.useCanonical(canonical.workspaceFeed("project")),
    deps.debug.useCanonical(canonical.workspaceFeed("debug")),
    // The Ports view's managed servers, in every window, from the one servers state.
    canonical.on("servers", (servers) => {
      followServerPorts(deps.ports, servers);
    }),
    canonical.onWorkspace("project", (project) => {
      if (project !== undefined) deps.folderToolsChanged();
    }),
    canonical.onWorkspace("dependencies", (dependencies) => {
      if (dependencies !== undefined) deps.folderToolsChanged();
    }),
    deps.events.on("workspaceFolderChanged", () => {
      void canonical.attachWorkspace();
    }),
  ];
  const servers = canonical.get("servers");
  if (servers !== undefined) followServerPorts(deps.ports, servers);
  return () => {
    for (const off of offs) off();
  };
}
