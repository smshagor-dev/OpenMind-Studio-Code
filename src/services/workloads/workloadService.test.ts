import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import { CATALOG } from "./workloadModel.test";
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
