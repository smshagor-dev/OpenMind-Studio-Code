import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import { ipcWorkspaceFeed } from "../../testUtils/canonicalFeeds";
import { DependenciesService, DISMISSED_KEY, hintOp, type DependenciesHost } from "./dependenciesService";
import type { DepsSnapshot, ProjectDeps } from "./depsIpc";

function project(patch: Partial<ProjectDeps> = {}): ProjectDeps {
  return {
    root: "py app",
    name: "py app",
    path: "E:\\My Work\\py app",
    python: null,
    node: null,
    php: null,
    rust: null,
    java: null,
    cmake: null,
    setup: [],
    ...patch,
  };
}

function rig(snapshot: DepsSnapshot, saved: string | null = null) {
  const events = new EventBus<AppEvents>();
  const host: DependenciesHost = {
    actions: { perform: vi.fn().mockResolvedValue({ status: "done" }) },
    events,
    settingsGet: vi.fn().mockResolvedValue(saved),
    settingsSet: vi.fn().mockResolvedValue(undefined),
  };
  // The backend's scan of the folder (canonical `dependencies`), already read when the window opened.
  const scan = vi.fn<() => Promise<DepsSnapshot>>().mockResolvedValue(snapshot);
  const feed = ipcWorkspaceFeed(scan);
  feed.push(snapshot);
  const service = new DependenciesService(host);
  service.useCanonical(feed);
  return { host, events, service, scan, feed };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("DependenciesService", () => {
  it("shows the folder's canonical dependencies and never scans by itself; Refresh asks the backend", async () => {
    const r = rig({ projects: [project()] });
    await r.service.initialize();
    expect(r.service.getState().snapshot?.projects[0]?.name).toBe("py app");
    // A saved manifest or another folder: the backend's watcher reads the folder once for every window.
    r.events.emit("documentSaved", { id: "d", path: "E:/My Work/py app/requirements.txt" });
    r.events.emit("workspaceFolderChanged", undefined as never);
    await flush();
    expect(r.scan).not.toHaveBeenCalled();
    r.feed.push({ projects: [project({ name: "after npm install" })] });
    expect(r.service.getState().snapshot?.projects[0]?.name).toBe("after npm install");
    await r.service.refresh();
    expect(r.scan).toHaveBeenCalledOnce();
  });

  it("runs operations in the project with its chosen environment and package manager", async () => {
    const p = project();
    const r = rig({ projects: [p] });
    r.service.setPythonEnv(p, "openmind");
    r.service.setNodeManager(p, "pnpm");
    await r.service.run(p, { op: "pythonAdd", packages: "requests", offline: false });
    expect(r.host.actions.perform).toHaveBeenCalledWith(
      { base: p.path, op: { op: "pythonAdd", packages: "requests", offline: false }, pythonEnv: "openmind", nodeManager: "pnpm" },
      "Dependencies",
    );
  });

  it("offers each setup gap once; Not Now is remembered across restarts; accepting asks through the usual confirmation", async () => {
    const p = project({ setup: [{ kind: "pythonNoEnv" }, { kind: "nodeNotInstalled" }] });
    const r = rig({ projects: [p] });
    await r.service.initialize();
    expect(r.service.pendingHint()).toEqual({ project: p, kind: "pythonNoEnv" });
    await r.service.dismissHint(p, "pythonNoEnv");
    expect(r.host.settingsSet).toHaveBeenCalledWith(DISMISSED_KEY, JSON.stringify([`${p.path}|pythonNoEnv`]));
    expect(r.service.pendingHint()?.kind).toBe("nodeNotInstalled");
    await r.service.acceptHint(p, "nodeNotInstalled");
    expect(r.host.actions.perform).toHaveBeenCalledWith(expect.objectContaining({ op: { op: "nodeInstall" } }), "Dependencies");

    const restarted = rig({ projects: [p] }, JSON.stringify([`${p.path}|pythonNoEnv`, `${p.path}|nodeNotInstalled`]));
    await restarted.service.initialize();
    expect(restarted.service.pendingHint()).toBeNull();
    // Nothing ran by itself.
    expect(restarted.host.actions.perform).not.toHaveBeenCalled();
    const damaged = rig({ projects: [p] }, "{not json");
    await damaged.service.initialize();
    expect(damaged.service.pendingHint()?.kind).toBe("pythonNoEnv");
  });

  it("maps each hint to its operation", () => {
    expect(hintOp("pythonNoEnv")).toEqual({ op: "pythonCreateEnv" });
    expect(hintOp("nodeNotInstalled")).toEqual({ op: "nodeInstall" });
    expect(hintOp("composerNotInstalled")).toEqual({ op: "composerInstall" });
  });

  it("a refresh the backend couldn't do is shown, and the last dependencies stay", async () => {
    const r = rig({ projects: [project({ name: "kept" })] });
    r.scan.mockRejectedValueOnce("no folder");
    await r.service.refresh();
    expect(r.service.getState().error).toBe("no folder");
    expect(r.service.getState().snapshot?.projects[0]?.name).toBe("kept");
  });
});
