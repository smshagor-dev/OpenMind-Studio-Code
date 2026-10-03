import type { RuntimeService } from "../runtimeService";
import { refreshAfterInstalls } from "../languageTools/languageToolsWiring";
import type { DomainData } from "../state/canonicalIpc";
import type { CanonicalStateService } from "../state/canonicalStateService";
import { type CanonicalWiringDeps, wireCanonical } from "../state/canonicalWiring";
import type { ToolchainPacks } from "../toolchains/toolchainIpc";

type Refresh = () => Promise<void> | void;

/** What changed between two tool lists, for people: "Prettier 3.6.2", "Ruff removed". Empty when nothing did. */
export function describeToolChange(
  before: ToolchainPacks | null,
  after: ToolchainPacks | null,
  removed: (name: string) => string,
): string {
  const active = (packs: ToolchainPacks | null) =>
    new Map((packs?.tools ?? []).filter((tool) => tool.activeVersion !== null).map((tool) => [tool.id, tool]));
  const was = active(before);
  const now = active(after);
  const changes: string[] = [];
  for (const [id, tool] of now) {
    if (was.get(id)?.activeVersion !== tool.activeVersion) changes.push(`${tool.name} ${tool.activeVersion ?? ""}`.trim());
  }
  for (const [id, tool] of was) if (!now.has(id)) changes.push(removed(tool.name));
  return changes.join(", ");
}

/**
 * The tools on new processes' PATH changed (installed, removed, a version switched — by OpenMind, by hand, in another
 * window): idle terminals start again with the new PATH. Follows the tool list's state; the first list (start-up)
 * changes nothing.
 */
export function followToolChanges(
  toolchains: { getState: () => { packs: ToolchainPacks | null }; subscribe: (listener: () => void) => () => void },
  toolsOnPath: (change: string) => Promise<void> | void,
  removedText: (name: string) => string,
): () => void {
  let seen = toolchains.getState().packs;
  return toolchains.subscribe(() => {
    const packs = toolchains.getState().packs;
    if (packs === seen) return;
    const before = seen;
    seen = packs;
    if (before === null || packs === null) return;
    const change = describeToolChange(before, packs, removedText);
    if (change !== "") void Promise.resolve(toolsOnPath(change)).catch(() => undefined);
  });
}

/** Which tools are installed and active — what decides what can format, lint or start (not Verify results). */
export function toolsFingerprint(packs: ToolchainPacks): string {
  return packs.tools
    .map((tool) => `${tool.id}:${tool.status}:${tool.activeVersion ?? "-"}`)
    .sort()
    .join(",");
}

/** Which language servers are installed or bundled — not their life cycle (running, stopped, failed). */
export function serversFingerprint(snapshot: DomainData["languageServers"]): string {
  return snapshot.servers
    .map((server) => `${server.id}:${String(server.installed)}:${String(server.bundled)}`)
    .sort()
    .join(",");
}

/** Runs `then` when `domain`'s fingerprint changes (the first state, at start-up, is only remembered). */
function onDomainChange<D extends "tools" | "languageServers">(
  canonical: CanonicalStateService,
  domain: D,
  fingerprint: (data: DomainData[D]) => string,
  then: () => void,
): () => void {
  const initial = canonical.get(domain);
  let seen = initial === undefined ? null : fingerprint(initial);
  return canonical.on(domain, (data) => {
    const next = fingerprint(data);
    const changed = seen !== null && next !== seen;
    seen = next;
    if (changed) then();
  });
}

export interface LiveSyncDeps extends Omit<CanonicalWiringDeps, "folderToolsChanged" | "toolchains"> {
  canonical: CanonicalStateService;
  runtime: Pick<RuntimeService, "subscribe" | "getState">;
  toolchains: CanonicalWiringDeps["toolchains"] & {
    getState: () => { packs: ToolchainPacks | null };
    subscribe: (listener: () => void) => () => void;
  };
  workloads: { invalidate: () => void };
  /** Per-file answers that depend on installed things: the formatter status, Run Code for the open file. */
  formatterStatus: Refresh;
  runCodeStatus: Refresh;
  /** Language servers for open files that have none working yet. */
  retryLanguageServers: Refresh;
  retryExtensions: () => void;
  /** A package install the page ran ended (Dependencies view, missing-package card). */
  onPackageOperation: (listener: () => void) => () => void;
  /** Idle terminals start again with the new PATH (`change` names what changed). */
  toolsOnPath: (change: string) => Promise<void> | void;
  removedText: (name: string) => string;
}

function runAll(refreshers: readonly Refresh[]): void {
  for (const refresh of refreshers) {
    void Promise.resolve()
      .then(refresh)
      .catch(() => undefined);
  }
}

/**
 * Live sync for one window. The stores follow the canonical state (`state/canonicalWiring.ts`); here is what reacts
 * to its changes: the per-file questions asked again, workloads, terminals following the tools on PATH. Every trigger
 * is a canonical change — no event of its own, no re-read of backend state.
 */
export function wireLiveSync(deps: LiveSyncDeps): void {
  const { canonical } = deps;
  const afterInstall: Refresh[] = [
    deps.retryLanguageServers,
    deps.formatterStatus,
    deps.runCodeStatus,
    deps.retryExtensions,
  ];
  // A runtime installed, removed or switched (the canonical runtime list's fingerprint).
  refreshAfterInstalls(deps.runtime, afterInstall);
  wireCanonical({
    ...deps,
    folderToolsChanged: () => {
      runAll([deps.formatterStatus, deps.runCodeStatus, deps.retryLanguageServers]);
    },
  });
  onDomainChange(canonical, "tools", toolsFingerprint, () => {
    deps.workloads.invalidate();
    runAll(afterInstall);
  });
  onDomainChange(canonical, "languageServers", serversFingerprint, () => {
    runAll(afterInstall);
  });
  canonical.on("packages", () => {
    runAll(afterInstall);
  });
  // A package install the page ran: this folder's dependencies, projects and Git are read once more (for every window
  // on it) without waiting for the file watcher's quiet period.
  deps.onPackageOperation(() => {
    void canonical.refresh(["dependencies", "project", "git"]);
  });
  followToolChanges(deps.toolchains, deps.toolsOnPath, deps.removedText);
}
