import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import type { LspSnapshot } from "../ipc";
import type { CanonicalIpc, StateDelta, StateSnapshot } from "../state/canonicalIpc";
import { CanonicalStateService } from "../state/canonicalStateService";
import type { ToolEntry, ToolchainPacks } from "../toolchains/toolchainIpc";
import { describeToolChange, followToolChanges, wireLiveSync } from "./liveSyncWiring";

function packs(tools: [string, string, string | null][]): ToolchainPacks {
  return {
    toolsDir: "C:/app/tools",
    platform: "windows-x64",
    manifestFound: true,
    manifestError: null,
    warnings: [],
    tools: tools.map(([id, name, activeVersion]) => ({ id, name, activeVersion, status: "active" }) as ToolEntry),
  };
}

const removed = (name: string): string => `${name} removed`;

describe("describeToolChange", () => {
  it("names installed, switched and removed tools, and nothing when nothing changed", () => {
    const before = packs([
      ["ruff", "Ruff", "0.6.0"],
      ["black", "Black", "24.1.0"],
    ]);
    const after = packs([
      ["ruff", "Ruff", null],
      ["black", "Black", "24.2.0"],
      ["prettier", "Prettier", "3.6.2"],
    ]);
    expect(describeToolChange(before, after, removed)).toBe("Black 24.2.0, Prettier 3.6.2, Ruff removed");
    expect(describeToolChange(after, after, removed)).toBe("");
    expect(describeToolChange(null, packs([["ruff", "Ruff", "0.6.0"]]), removed)).toBe("Ruff 0.6.0");
  });
});

describe("followToolChanges", () => {
  it("refreshes terminals when a tool changes, not for the first list or a list that changed nothing", () => {
    let state: { packs: ToolchainPacks | null } = { packs: null };
    const listeners = new Set<() => void>();
    const tools = {
      getState: () => state,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const set = (next: ToolchainPacks) => {
      state = { packs: next };
      for (const listener of listeners) listener();
    };
    const toolsOnPath = vi.fn();
    followToolChanges(tools, toolsOnPath, removed);
    set(packs([["ruff", "Ruff", "0.6.0"]])); // start-up
    set(packs([["ruff", "Ruff", "0.6.0"]])); // the same tools again
    expect(toolsOnPath).not.toHaveBeenCalled();
    set(packs([["ruff", "Ruff", "0.7.0"]]));
    expect(toolsOnPath).toHaveBeenCalledWith("Ruff 0.7.0");
    set(packs([]));
    expect(toolsOnPath).toHaveBeenLastCalledWith("Ruff removed");
  });
});

function servers(installed: boolean, state: string): LspSnapshot {
  return { servers: [{ id: "pyright", installed, bundled: true, state }] } as unknown as LspSnapshot;
}

async function rig() {
  let deliver: (delta: StateDelta) => void = () => undefined;
  const ipc = {
    onDelta: vi.fn((handler: (delta: StateDelta) => void) => {
      deliver = handler;
      return Promise.resolve(() => undefined);
    }),
    snapshot: vi.fn(() => Promise.resolve({ revision: 0, workspace: "c:/a", domains: [] } as StateSnapshot)),
    revision: vi.fn(() => Promise.resolve(0)),
    attach: vi.fn(() => Promise.resolve("c:/a")),
    refresh: vi.fn(() => Promise.resolve()),
  } satisfies CanonicalIpc;
  const canonical = new CanonicalStateService(ipc);
  await canonical.start();
  let revision = 0;
  const push = (delta: Omit<StateDelta, "revision">) => {
    revision += 1;
    deliver({ ...delta, revision } as StateDelta);
  };
  const follower = () => ({ useCanonical: vi.fn(() => () => undefined) });
  let packageOperation: () => void = () => undefined;
  const deps = {
    canonical,
    events: new EventBus<AppEvents>(),
    runtime: { subscribe: vi.fn(() => () => undefined), getState: vi.fn() },
    toolchains: { ...follower(), getState: () => ({ packs: null }), subscribe: () => () => undefined },
    lsp: follower(),
    extensions: follower(),
    php: follower(),
    mySql: follower(),
    mariaDb: follower(),
    phpMyAdmin: follower(),
    ports: { register: vi.fn(() => ""), unregisterSource: vi.fn(), list: vi.fn(() => []) },
    sourceControl: follower(),
    dependencies: follower(),
    language: follower(),
    debug: follower(),
    workloads: { invalidate: vi.fn() },
    formatterStatus: vi.fn(),
    runCodeStatus: vi.fn(),
    retryLanguageServers: vi.fn(),
    retryExtensions: vi.fn(),
    onPackageOperation: (listener: () => void) => {
      packageOperation = listener;
      return () => undefined;
    },
    toolsOnPath: vi.fn(),
    removedText: removed,
  };
  wireLiveSync(deps);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { ipc, deps, push, settle, packageOperation: () => { packageOperation(); } };
}

describe("wireLiveSync: reactions to canonical changes", () => {
  it("a tool installed or switched asks the per-file questions again and invalidates the workloads; the start-up list doesn't", async () => {
    const r = await rig();
    r.push({ domain: "tools", data: packs([["ruff", "Ruff", "0.6.0"]]) });
    await r.settle();
    expect(r.deps.formatterStatus).not.toHaveBeenCalled();
    r.push({ domain: "tools", data: packs([["ruff", "Ruff", "0.7.0"]]) });
    await r.settle();
    expect(r.deps.workloads.invalidate).toHaveBeenCalledTimes(1);
    expect(r.deps.formatterStatus).toHaveBeenCalledTimes(1);
    expect(r.deps.runCodeStatus).toHaveBeenCalledTimes(1);
    expect(r.deps.retryLanguageServers).toHaveBeenCalledTimes(1);
  });

  it("a language server's life cycle (running, failed) asks nothing again; an install does", async () => {
    const r = await rig();
    r.push({ domain: "languageServers", data: servers(false, "stopped") });
    r.push({ domain: "languageServers", data: servers(false, "error") });
    r.push({ domain: "languageServers", data: servers(false, "stopped") });
    await r.settle();
    expect(r.deps.retryLanguageServers).not.toHaveBeenCalled();
    r.push({ domain: "languageServers", data: servers(true, "stopped") });
    await r.settle();
    expect(r.deps.retryLanguageServers).toHaveBeenCalledTimes(1);
  });

  it("a folder's project or dependency change asks the open file's Run Code and formatter questions again", async () => {
    const r = await rig();
    r.push({ domain: "dependencies", scope: "c:/a", data: { projects: [] } } as unknown as StateDelta);
    await r.settle();
    expect(r.deps.runCodeStatus).toHaveBeenCalledTimes(1);
    expect(r.deps.formatterStatus).toHaveBeenCalledTimes(1);
  });

  it("a package install the page ran asks the backend to read this folder's dependencies once more", async () => {
    const r = await rig();
    r.packageOperation();
    await vi.waitFor(() => {
      expect(r.ipc.refresh).toHaveBeenCalledWith(["dependencies", "project", "git"]);
    });
  });
});
