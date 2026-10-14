import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DeployIpc, DeployStatus, TestReport } from "../../services/deployment/deployIpc";
import { DeploymentService } from "../../services/deployment/deploymentService";

const holder = vi.hoisted(
  (): { service: DeploymentService | null; folder: string | null; answer: string | null } => ({
    service: null,
    folder: null,
    answer: null,
  }),
);
vi.mock("../../services/deployment", () => ({
  get deployment() {
    return holder.service;
  },
}));
vi.mock("../../services/container", () => ({
  container: {
    ipc: { openFolderDialog: () => Promise.resolve(holder.folder) },
    extensions: { prompts: { confirm: () => Promise.resolve(holder.answer) } },
  },
}));

import { NetworkDeploymentDialog } from "./NetworkDeploymentDialog";

const setup = { name: "OpenMind-Studio_1.0.3_windows_x64_setup.exe", kind: "installer" as const, arch: "x64" as const, version: "1.0.3", size: 252413155, sha256: "x", signature: "y" };

function status(): DeployStatus {
  return {
    copy: {
      exe: "C:\\OM\\OpenMindStudio.exe", installDir: "C:\\OM", universalDir: "C:\\OM", onNetwork: false, layout: "network",
      dataScope: "perMachine", version: "1.0.3", buildArch: "x64", osArch: "x64", hostname: "UNIVERSITY-PC-02", user: "Student",
      profileId: "9babdf6d139b", dataRoot: "C:\\Users\\Student\\AppData\\Local\\OpenMind\\Studio\\Installations\\k", dbPath: "C:\\db",
      logsDir: "", tempDir: "", cacheDir: "", runtimesDir: "\\\\srv\\apps\\OpenMind Studio\\runtimes", runtimeStore: "shared", packagesDir: "",
    },
    offer: { on: false, discoveryAddress: null, packageAddress: null, kind: null, deploymentId: null, packages: [], runtimes: 0, problems: [], error: null },
    deployments: [
      {
        id: "a".repeat(32),
        manifest: { deploymentId: "a".repeat(32), appVersion: "1.0.3", platform: "windows", arch: "x64", kind: "packageSource", packages: [setup], runtimes: [] },
        sources: [{ address: "10.0.0.5", appVersion: "1.0.3", secondsAgo: 0, servesPackages: true }],
        incompatible: null,
        manifestError: null,
        trusted: true,
      },
    ],
    lastSearch: null,
  };
}

const report: TestReport = {
  checks: [
    { id: "deploymentDiscovery", status: "pass", detail: "1 deployment(s) answered" },
    { id: "shortcutValidity", status: "fail", detail: "no Desktop shortcut starts this program" },
    { id: "runtimeStore", status: "blocked", detail: "doesn't exist yet" },
  ],
  passed: 1, failed: 1, blocked: 1, notTested: 0,
  search: { outcome: "found", found: 1, targets: [], sent: 3, sendErrors: [], socketError: null, incompatible: [], malformed: 0, elapsedMs: 900 },
  deployment: "a".repeat(32),
};

function ipc(): DeployIpc {
  return {
    status: vi.fn(() => Promise.resolve(status())),
    applyOffering: vi.fn(() => Promise.resolve(status().offer)),
    search: vi.fn(() => Promise.reject(new Error("unused"))),
    test: vi.fn(() => Promise.resolve(report)),
    provision: vi.fn(() =>
      Promise.resolve({ action: "install" as const, program: "G:\\Apps\\OpenMind Studio\\OpenMindStudio.exe", version: "1.0.3", shortcut: null, dataLocation: "G:\\Apps\\OpenMind Studio\\data", steps: ["verified"] }),
    ),
    launch: vi.fn(() => Promise.resolve()),
    trust: vi.fn(() => Promise.resolve()),
  };
}

afterEach(() => {
  cleanup();
});

describe("NetworkDeploymentDialog", () => {
  it("shows this computer, the deployments, and runs the test with PASS/FAIL/BLOCKED rows", async () => {
    const fake = ipc();
    const service = new DeploymentService(fake);
    holder.service = service;
    await act(() => service.openDialog());
    render(<NetworkDeploymentDialog />);
    expect(screen.getByText(/UNIVERSITY-PC-02/)).toBeTruthy();
    expect(screen.getByText(/OpenMind-Studio_1\.0\.3_windows_x64_setup\.exe/)).toBeTruthy();
    const share = screen.getByRole("button", { name: "Use Shared Installation" });
    expect(share).toHaveProperty("disabled", true);
    expect(share.title).toBe("This deployment is not a shared installation.");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Run Test" }));
      await Promise.resolve();
    });
    expect(fake.test).toHaveBeenCalledWith([], true);
    expect(screen.getByText("PASS")).toBeTruthy();
    expect(screen.getByText("FAIL")).toBeTruthy();
    expect(screen.getByText("BLOCKED")).toBeTruthy();
  });

  it("installs into an OpenMind Studio folder inside the folder the user picked", async () => {
    const fake = ipc();
    const service = new DeploymentService(fake);
    holder.service = service;
    holder.folder = "G:\\Apps";
    await act(() => service.openDialog());
    render(<NetworkDeploymentDialog />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Install with Setup…" }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(fake.provision).toHaveBeenCalledWith("a".repeat(32), "setup", "G:\\Apps\\OpenMind Studio");
    expect(screen.getByText("Installed OpenMind Studio 1.0.3.")).toBeTruthy();
  });

  it("a cancelled folder choice provisions nothing", async () => {
    const fake = ipc();
    const service = new DeploymentService(fake);
    holder.service = service;
    holder.folder = null;
    await act(() => service.openDialog());
    render(<NetworkDeploymentDialog />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Install with Setup…" }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(fake.provision).not.toHaveBeenCalled();
  });

  it("an untrusted deployment is used only after the user trusts it", async () => {
    const untrusted = (): DeployIpc => {
      const fake = ipc();
      const base = status();
      const first = base.deployments[0];
      if (first) first.trusted = false;
      fake.status = vi.fn(() => Promise.resolve(base));
      return fake;
    };
    // Declined: nothing is trusted or provisioned.
    const declined = untrusted();
    const service = new DeploymentService(declined);
    holder.service = service;
    holder.folder = "G:\\Apps";
    holder.answer = null;
    await act(() => service.openDialog());
    const view = render(<NetworkDeploymentDialog />);
    expect(screen.getByText(/Not trusted on this computer yet/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Install with Setup…" }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(declined.trust).not.toHaveBeenCalled();
    expect(declined.provision).not.toHaveBeenCalled();
    view.unmount();
    // Accepted: trusted first, then provisioned.
    const accepted = untrusted();
    const second = new DeploymentService(accepted);
    holder.service = second;
    holder.answer = "Trust and Continue";
    await act(() => second.openDialog());
    render(<NetworkDeploymentDialog />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Install with Setup…" }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(accepted.trust).toHaveBeenCalledWith("a".repeat(32));
    expect(accepted.provision).toHaveBeenCalledWith("a".repeat(32), "setup", "G:\\Apps\\OpenMind Studio");
  });
});
