import { describe, expect, it, vi } from "vitest";

import type { DeployIpc, DeployStatus, DeploymentView, TestReport } from "./deployIpc";
import { DeploymentService, destinationFor, provisionOptions, targetsOf } from "./deploymentService";

function deploymentView(change: Partial<DeploymentView["manifest"]> = {}, incompatible: string | null = null): DeploymentView {
  return {
    id: "a".repeat(32),
    manifest: {
      deploymentId: "a".repeat(32),
      appVersion: "1.0.3",
      platform: "windows",
      arch: "x64",
      kind: "packageSource",
      packages: [],
      runtimes: [],
      ...change,
    },
    sources: [{ address: "10.0.0.5", appVersion: "1.0.3", secondsAgo: 0, servesPackages: true }],
    incompatible,
    manifestError: null,
    trusted: true,
  };
}

const setup = { name: "OpenMind-Studio_1.0.3_windows_x64_setup.exe", kind: "installer" as const, arch: "x64" as const, version: "1.0.3", size: 1, sha256: "x", signature: "y" };

function status(): DeployStatus {
  return {
    copy: {
      exe: "C:\\OM\\OpenMindStudio.exe", installDir: "C:\\OM", universalDir: "C:\\OM", onNetwork: false, layout: "portable",
      dataScope: "personal", version: "1.0.3", buildArch: "x64", osArch: "x64", hostname: "PC-01", user: "Student",
      profileId: "abc", dataRoot: "C:\\OM\\data", dbPath: "C:\\OM\\data\\openmind-studio.db", logsDir: "", tempDir: "",
      cacheDir: "", runtimesDir: "C:\\OM\\runtimes", runtimeStore: "local", packagesDir: "",
    },
    offer: { on: false, discoveryAddress: null, packageAddress: null, kind: null, deploymentId: null, packages: [], runtimes: 0, problems: [], error: null },
    deployments: [],
    lastSearch: null,
  };
}

function fakeIpc(change: Partial<DeployIpc> = {}): DeployIpc {
  return {
    status: vi.fn(() => Promise.resolve(status())),
    applyOffering: vi.fn(() => Promise.resolve({ ...status().offer, on: true })),
    search: vi.fn(() =>
      Promise.resolve({
        search: { outcome: "found" as const, found: 1, targets: [], sent: 3, sendErrors: [], socketError: null, incompatible: [], malformed: 0, elapsedMs: 900 },
        deployments: [deploymentView({ packages: [setup] })],
      }),
    ),
    test: vi.fn(() => Promise.reject(new Error("unused"))),
    provision: vi.fn(() => Promise.reject(new Error("unused"))),
    launch: vi.fn(() => Promise.resolve()),
    trust: vi.fn(() => Promise.resolve()),
    ...change,
  };
}

describe("deployment helpers", () => {
  it("reads typed addresses in any separator", () => {
    expect(targetsOf(" 10.0.0.5, lab-server;10.0.1.9  host:5000 ")).toEqual(["10.0.0.5", "lab-server", "10.0.1.9", "host:5000"]);
    expect(targetsOf("")).toEqual([]);
  });

  it("installs into an OpenMind Studio folder inside the chosen one, on any drive", () => {
    expect(destinationFor("G:\\")).toBe("G:\\OpenMind Studio");
    expect(destinationFor("D:\\Apps With Spaces\\Программы")).toBe("D:\\Apps With Spaces\\Программы\\OpenMind Studio");
    expect(destinationFor("F:\\Apps\\OpenMind Studio\\")).toBe("F:\\Apps\\OpenMind Studio");
  });

  it("offers only what the deployment has, with a reason for the rest", () => {
    const options = provisionOptions(deploymentView({ packages: [setup] }));
    expect(options.map((o) => [o.kind, o.available, o.reason])).toEqual([
      ["share", false, "deploy.reason.notShare"],
      ["setup", true, null],
      ["portable", false, "deploy.reason.noPortable"],
    ]);
    const share = provisionOptions(deploymentView({ kind: "networkShare", sharePath: "\\\\srv\\apps" }));
    expect(share[0]).toMatchObject({ kind: "share", available: true, needsFolder: false });
    const incompatible = provisionOptions(deploymentView({ packages: [setup] }, "it is built for arm64"));
    expect(incompatible.every((o) => !o.available && o.reason === "deploy.reason.incompatible")).toBe(true);
  });
});

describe("DeploymentService", () => {
  it("opening reads this computer's facts and searches nothing", async () => {
    const ipc = fakeIpc();
    const service = new DeploymentService(ipc);
    await service.openDialog();
    expect(service.getState().open).toBe(true);
    expect(service.getState().status?.copy.hostname).toBe("PC-01");
    expect(ipc.search).not.toHaveBeenCalled();
    expect(ipc.test).not.toHaveBeenCalled();
  });

  it("a search passes the typed addresses and shows what answered", async () => {
    const ipc = fakeIpc();
    const service = new DeploymentService(ipc);
    await service.openDialog();
    service.setTargets("10.0.0.5, lab-server");
    await service.search();
    expect(ipc.search).toHaveBeenCalledWith(["10.0.0.5", "lab-server"]);
    expect(service.getState().status?.deployments).toHaveLength(1);
    expect(service.getState().search?.outcome).toBe("found");
  });

  it("the test reports and a failure is shown, never thrown", async () => {
    const report: TestReport = {
      checks: [{ id: "deploymentDiscovery", status: "fail", detail: "NO DEPLOYMENT FOUND" }],
      passed: 0, failed: 1, blocked: 0, notTested: 0,
      search: { outcome: "nothingFound", found: 0, targets: [], sent: 3, sendErrors: [], socketError: null, incompatible: [], malformed: 0, elapsedMs: 2500 },
      deployment: null,
    };
    const service = new DeploymentService(fakeIpc({ test: vi.fn(() => Promise.resolve(report)) }));
    await service.openDialog();
    service.setDownloadPackage(false);
    await service.runTest();
    expect(service.getState().report?.failed).toBe(1);
    const failing = new DeploymentService(fakeIpc({ provision: vi.fn(() => Promise.reject(new Error("refused: signature"))) }));
    expect(await failing.provision("x", "setup", "D:\\OpenMind Studio")).toBeNull();
    expect(failing.getState().error).toContain("signature");
    expect(failing.getState().busy).toBeNull();
  });

  it("does one thing at a time", async () => {
    let release: () => void = () => undefined;
    const slow = vi.fn(() => new Promise<never>((_, reject) => { release = () => { reject(new Error("done")); }; }));
    const ipc = fakeIpc({ search: slow });
    const service = new DeploymentService(ipc);
    const first = service.search();
    await service.search();
    expect(slow).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  it("a changed offer setting is applied by the backend and shown", async () => {
    const ipc = fakeIpc();
    const service = new DeploymentService(ipc);
    await service.openDialog();
    await service.applyOffering();
    expect(ipc.applyOffering).toHaveBeenCalled();
    expect(service.getState().status?.offer.on).toBe(true);
  });

  it("trusting a deployment marks it trusted", async () => {
    const ipc = fakeIpc();
    const service = new DeploymentService(ipc);
    await service.openDialog();
    await service.search();
    const id = service.getState().status?.deployments[0]?.id ?? "";
    expect(await service.trust(id)).toBe(true);
    expect(ipc.trust).toHaveBeenCalledWith(id);
    expect(service.getState().status?.deployments[0]?.trusted).toBe(true);
  });
});
