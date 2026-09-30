import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import { CATALOG, comp } from "./workloadModel.test";
import type { WorkloadCatalog } from "./workloadsIpc";
import type { Plan, WorkloadsIpc } from "./workloadsIpc";
import { WorkloadService } from "./workloadService";

function plan(patch: Partial<Plan> = {}): Plan {
  return { components: [], install: [], downloadBytes: 0, installBytes: 0, unknownSizes: 0, licenses: [], warnings: [], ...patch };
}

function rig(ipc: Partial<WorkloadsIpc> = {}, installOk = true) {
  const events = new EventBus<AppEvents>();
  const notices: string[] = [];
  events.on("appNotice", ({ message }) => notices.push(message));
  const full: WorkloadsIpc = {
    workloadsCatalog: vi.fn().mockResolvedValue(CATALOG),
    workloadsPlan: vi.fn().mockResolvedValue(plan()),
    workloadsFirstRun: vi.fn().mockResolvedValue(true),
    workloadsFirstRunDone: vi.fn().mockResolvedValue(undefined),
    runtimeVerify: vi.fn().mockResolvedValue("21.0.12.1"),
    ...ipc,
  };
  const install = vi.fn().mockResolvedValue(installOk);
  const service = new WorkloadService({
    ipc: full,
    events,
    install,
    installError: () => "download failed (proxy authentication required)",
    refreshRuntimes: vi.fn().mockResolvedValue(undefined),
  });
  return { service, ipc: full, install, notices };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("WorkloadService", () => {
  it("the first-run page opens once; Skip installs nothing and marks it done", async () => {
    const r = rig();
    expect(await r.service.maybeOpenFirstRun()).toBe(true);
    expect(r.service.getState()).toMatchObject({ firstRunOpen: true, section: "welcome" });
    // Recorded as shown at once: quitting with the page still open doesn't bring it back next launch.
    expect(r.ipc.workloadsFirstRunDone).toHaveBeenCalledTimes(1);
    await r.service.skip();
    expect(r.service.getState().firstRunOpen).toBe(false);
    expect(r.ipc.workloadsFirstRunDone).toHaveBeenCalled();
    expect(r.install).not.toHaveBeenCalled();
    const again = rig({ workloadsFirstRun: vi.fn().mockResolvedValue(false) });
    expect(await again.service.maybeOpenFirstRun()).toBe(false);
    expect(again.ipc.workloadsCatalog).not.toHaveBeenCalled();
  });

  it("every change of the selection asks for a new plan; an older answer never overwrites a newer one", async () => {
    let resolveFirst: (p: Plan) => void = () => undefined;
    const workloadsPlan = vi
      .fn()
      .mockResolvedValueOnce(plan())
      .mockImplementationOnce(() => new Promise<Plan>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(plan({ install: ["jdk", "maven"] }));
    const r = rig({ workloadsPlan });
    await r.service.load();
    r.service.toggleWorkload("java");
    r.service.toggleComponent("cmake");
    await flush();
    resolveFirst(plan({ install: ["stale"] }));
    await flush();
    expect(workloadsPlan).toHaveBeenLastCalledWith({ workloads: ["java"], add: ["cmake"], remove: [] });
    expect(r.service.getState().plan?.install).toEqual(["jdk", "maven"]);
  });

  it("Minimal means an empty plan: Install does nothing", async () => {
    const r = rig();
    await r.service.load();
    r.service.toggleWorkload("minimal");
    await flush();
    await r.service.installSelected();
    expect(r.install).not.toHaveBeenCalled();
  });

  it("installs in the plan's order, asks for licences first, and a declined licence skips only those runtimes", async () => {
    const r = rig({ workloadsPlan: vi.fn().mockResolvedValue(plan({ install: ["jdk", "android-cmdline-tools", "flutter"], licenses: ["android-cmdline-tools"] })) });
    await r.service.load();
    await r.service.installSelected();
    expect(r.install).not.toHaveBeenCalled();
    expect(r.service.getState().pendingLicenses).toEqual(["android-cmdline-tools"]);
    await r.service.answerLicenses(false);
    expect(r.install.mock.calls).toEqual([["jdk", false], ["flutter", false]]);
    r.install.mockClear();
    await r.service.installSelected();
    await r.service.answerLicenses(true);
    expect(r.install.mock.calls).toEqual([["jdk", true], ["android-cmdline-tools", true], ["flutter", true]]);
    expect(r.notices.at(-1)).toBe("Workloads: 3 installed, 0 failed.");
  });

  it("a failed install is recorded with the runtime's error and the queue goes on", async () => {
    const r = rig({ workloadsPlan: vi.fn().mockResolvedValue(plan({ install: ["jdk", "maven"] })) }, false);
    await r.service.load();
    await r.service.installSelected();
    const run = r.service.getState().run;
    expect(run?.finished).toBe(true);
    expect(run?.failed.map((f) => f.id)).toEqual(["jdk", "maven"]);
    expect(run?.failed[0]?.error).toMatch(/proxy authentication required/);
  });

  it("Verify runs only on request and shows the version or the error", async () => {
    const r = rig({ runtimeVerify: vi.fn().mockResolvedValueOnce("21.0.12.1").mockRejectedValueOnce("Maven did not answer within 30 seconds.") });
    await r.service.verify("jdk");
    await r.service.verify("maven");
    expect(r.service.getState().verify).toEqual({
      jdk: { ok: true, text: "21.0.12.1" },
      maven: { ok: false, text: "Maven did not answer within 30 seconds." },
    });
  });

  it("the Workloads tab can be requested once", () => {
    const r = rig();
    r.service.requestTab("workloads");
    expect(r.service.takeRequestedTab()).toBe("workloads");
    expect(r.service.takeRequestedTab()).toBeNull();
  });
});

/** The catalog with one component's state changed (what the backend reports after an install or delete). */
function withState(id: string, state: "installed" | "available"): WorkloadCatalog {
  return { ...CATALOG, components: CATALOG.components.map((c) => (c.id === id ? { ...c, state } : c)) };
}

describe("WorkloadService follows install changes made elsewhere", () => {
  it("while a page shows it, a change re-reads the catalog and the plan; old Verify results of a removed runtime go", async () => {
    const workloadsCatalog = vi.fn().mockResolvedValueOnce(CATALOG).mockResolvedValueOnce(withState("jdk", "available"));
    const workloadsPlan = vi
      .fn()
      .mockResolvedValueOnce(plan({ install: ["maven"] }))
      .mockResolvedValue(plan({ install: ["jdk", "maven"], warnings: [{ kind: "dependencyAdded", component: "jdk", neededBy: "maven" }] }));
    const r = rig({ workloadsCatalog, workloadsPlan });
    const detach = r.service.attach();
    await flush();
    await r.service.verify("jdk");
    expect(r.service.getState().verify.jdk?.ok).toBe(true);
    r.service.invalidate();
    await flush();
    expect(workloadsCatalog).toHaveBeenCalledTimes(2);
    expect(r.service.getState().catalog?.components.find((c) => c.id === "jdk")?.state).toBe("available");
    expect(r.service.getState().plan?.install).toEqual(["jdk", "maven"]);
    expect(r.service.getState().plan?.warnings).toHaveLength(1);
    expect(r.service.getState().verify.jdk).toBeUndefined();
    detach();
  });

  it("while nothing shows it, a change only marks it stale: the next attach reads it again", async () => {
    const workloadsCatalog = vi.fn().mockResolvedValueOnce(CATALOG).mockResolvedValue(withState("maven", "installed"));
    const r = rig({ workloadsCatalog });
    const detach = r.service.attach();
    await flush();
    detach();
    detach(); // a second call is harmless
    r.service.invalidate();
    await flush();
    expect(workloadsCatalog).toHaveBeenCalledTimes(1);
    r.service.attach();
    await flush();
    expect(workloadsCatalog).toHaveBeenCalledTimes(2);
    expect(r.service.getState().catalog?.components.find((c) => c.id === "maven")?.state).toBe("installed");
    // Attaching again with nothing changed doesn't read it again.
    r.service.attach();
    await flush();
    expect(workloadsCatalog).toHaveBeenCalledTimes(2);
  });

  it("before anything was loaded a change is ignored; a burst of changes is one read", async () => {
    const r = rig();
    r.service.invalidate();
    await flush();
    expect(r.ipc.workloadsCatalog).not.toHaveBeenCalled();
    r.service.attach();
    await flush();
    r.service.invalidate();
    r.service.invalidate();
    r.service.invalidate();
    await flush();
    expect(r.ipc.workloadsCatalog).toHaveBeenCalledTimes(2);
  });

  it("an older catalog answer never overwrites a newer one", async () => {
    let resolveOld: (c: WorkloadCatalog) => void = () => undefined;
    const workloadsCatalog = vi
      .fn()
      .mockImplementationOnce(() => new Promise<WorkloadCatalog>((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce(withState("cmake", "installed"));
    const r = rig({ workloadsCatalog });
    const first = r.service.load();
    await r.service.load();
    resolveOld({ ...CATALOG, components: [...CATALOG.components, comp("stale")] });
    await first;
    const components = r.service.getState().catalog?.components ?? [];
    expect(components.find((c) => c.id === "cmake")?.state).toBe("installed");
    expect(components.some((c) => c.id === "stale")).toBe(false);
  });
});
