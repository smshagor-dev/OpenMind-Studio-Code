import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
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
  let changed: () => void = () => undefined;
  const host: DependenciesHost = {
    ipc: { depsScan: vi.fn().mockResolvedValue(snapshot) },
    actions: { perform: vi.fn().mockResolvedValue({ status: "done" }) },
    events,
    onChanged: (listener) => {
      changed = listener;
      return () => undefined;
    },
    settingsGet: vi.fn().mockResolvedValue(saved),
    settingsSet: vi.fn().mockResolvedValue(undefined),
  };
  return { host, events, service: new DependenciesService(host), fireChanged: () => { changed(); } };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("DependenciesService", () => {
  it("reads the folder at start, again after a manifest is saved or an operation ended, never for other files", async () => {
    const r = rig({ projects: [project()] });
    await r.service.initialize();
    expect(r.host.ipc.depsScan).toHaveBeenCalledOnce();
    r.events.emit("documentSaved", { id: "d", path: "E:\\My Work\\py app\\main.py" });
    await flush();
    expect(r.host.ipc.depsScan).toHaveBeenCalledOnce();
    r.events.emit("documentSaved", { id: "d", path: "E:\\My Work\\py app\\requirements.txt" });
    r.fireChanged();
    await flush();
    expect(r.host.ipc.depsScan).toHaveBeenCalledTimes(3);
    expect(r.service.getState().snapshot?.projects[0]?.name).toBe("py app");
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

  it("a newer read wins over an older one; a failed read is shown", async () => {
    const r = rig({ projects: [] });
    let resolveOld: (value: DepsSnapshot) => void = () => undefined;
    (r.host.ipc.depsScan as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(new Promise<DepsSnapshot>((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce({ projects: [project({ name: "new" })] });
    const old = r.service.refresh();
    await r.service.refresh();
    resolveOld({ projects: [project({ name: "old" })] });
    await old;
    expect(r.service.getState().snapshot?.projects[0]?.name).toBe("new");
    (r.host.ipc.depsScan as ReturnType<typeof vi.fn>).mockRejectedValueOnce("no folder");
    await r.service.refresh();
    expect(r.service.getState().error).toBe("no folder");
  });
});
