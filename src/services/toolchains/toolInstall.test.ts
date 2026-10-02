import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import type { LspServerInfo, RuntimeStatus } from "../ipc";
import { routeState, TOOL_ROUTES } from "./toolInstallRoutes";
import { ToolInstallService } from "./toolInstallService";

function runtime(id: string, version: string | null, licence = false): RuntimeStatus {
  return {
    id,
    displayName: id,
    description: "",
    notes: "",
    defaultVersion: "1",
    availableVersions: ["1"],
    installed: version === null ? [] : [{ version, path: "C:/x", active: true, healthy: true, features: [] }],
    activeVersion: version,
    globalVersion: null,
    requires: [],
    license: licence ? { name: "Android SDK License", url: "https://developer.android.com/studio/terms", acceptanceRequired: true } : null,
    downloadBytes: null,
    installBytes: null,
    busy: false,
  };
}

/** The tool ids of the Rust catalog (`crates/toolchains/src/catalog.rs`), read from its source. */
const KNOWN_TOOL_IDS = [
  ...readFileSync(join(process.cwd(), "crates/toolchains/src/catalog.rs"), "utf8").matchAll(/^\s*(?:tool|external)\("([a-z0-9-]+)"/gm),
].map((match) => match[1] ?? "");

describe("tool install routes", () => {
  it("every tool of the catalog has a route: nothing on the page is left without a way to install it or a reason", () => {
    expect(KNOWN_TOOL_IDS.length).toBeGreaterThan(25);
    for (const id of KNOWN_TOOL_IDS) expect(TOOL_ROUTES[id], id).toBeDefined();
    expect(TOOL_ROUTES.docker?.kind).toBe("external");
    expect(TOOL_ROUTES.xcode?.kind).toBe("external");
  });

  it("a runtime-backed tool is installed when every runtime it needs is", () => {
    const route = TOOL_ROUTES["cpp-toolchain"];
    if (route === undefined) throw new Error("route");
    const some = [runtime("llvm-mingw", "20260922"), runtime("cmake", null), runtime("ninja", "1.13.2")];
    expect(routeState(route, some, [], false)).toEqual({
      state: "missing",
      detail: "Installs cmake with the Runtime Manager (into the app folder).",
    });
    const all = [runtime("llvm-mingw", "20260922"), runtime("cmake", "4.4.0"), runtime("ninja", "1.13.2")];
    expect(routeState(route, all, [], false)).toEqual({
      state: "installed",
      detail: "llvm-mingw 20260922, cmake 4.4.0, ninja 1.13.2",
    });
    expect(routeState(route, all, [], true)).toEqual({ state: "installing" });
  });

  it("Intelephense follows its language server", () => {
    const route = TOOL_ROUTES.intelephense;
    if (route === undefined) throw new Error("route");
    const server = { id: "php", contents: "intelephense 1.18.5", installed: false, state: "stopped", canInstall: true, installBlocked: null } as LspServerInfo;
    expect(routeState(route, [], [server], false)?.state).toBe("missing");
    expect(routeState(route, [], [{ ...server, installed: true }], false)?.state).toBe("installed");
    expect(routeState(route, [], [{ ...server, canInstall: false, installBlocked: "npm missing" }], false)).toEqual({
      state: "unavailable",
      reason: "npm missing",
    });
  });
});

function service(runtimes: RuntimeStatus[], accept = true) {
  const deps = {
    events: new EventBus<AppEvents>(),
    runtime: { getState: () => ({ runtimes }) as never, install: vi.fn().mockResolvedValue(true) },
    lsp: { install: vi.fn().mockResolvedValue(true) },
    installPackage: vi.fn().mockResolvedValue(undefined),
    removePackage: vi.fn().mockResolvedValue(undefined),
    refreshTools: vi.fn().mockResolvedValue(undefined),
    acceptLicence: vi.fn().mockResolvedValue(accept),
  };
  return { deps, install: new ToolInstallService(deps) };
}

describe("ToolInstallService", () => {
  it("installs only the runtimes a tool still lacks, in order", async () => {
    const { deps, install } = service([runtime("llvm-mingw", null), runtime("cmake", "4.4.0"), runtime("ninja", null)]);
    expect(await install.install("cpp-toolchain", "C/C++ toolchain")).toBe(true);
    expect(deps.runtime.install.mock.calls).toEqual([
      ["llvm-mingw", null, false],
      ["ninja", null, false],
    ]);
    expect(deps.refreshTools).toHaveBeenCalled();
  });

  it("asks for a vendor licence first; declining installs nothing", async () => {
    const declined = service([runtime("android-cmdline-tools", null, true), runtime("android-platform-tools", null)], false);
    expect(await declined.install.install("android-sdk", "Android SDK")).toBe(false);
    expect(declined.deps.runtime.install).not.toHaveBeenCalled();
    const accepted = service([runtime("android-cmdline-tools", null, true), runtime("android-platform-tools", null)], true);
    expect(await accepted.install.install("android-sdk", "Android SDK")).toBe(true);
    expect(accepted.deps.runtime.install).toHaveBeenCalledWith("android-cmdline-tools", null, true);
  });

  it("packages go to the backend installer; servers to Language Tools; externals do nothing", async () => {
    const { deps, install } = service([]);
    expect(await install.install("prettier", "Prettier")).toBe(true);
    expect(deps.installPackage).toHaveBeenCalledWith("prettier");
    expect(await install.install("intelephense", "Intelephense")).toBe(true);
    expect(deps.lsp.install).toHaveBeenCalledWith("php");
    expect(await install.install("docker", "Docker")).toBe(false);
    expect(await install.remove("prettier", "Prettier")).toBe(true);
    expect(deps.removePackage).toHaveBeenCalledWith("prettier");
    expect(await install.remove("git", "Git")).toBe(false);
  });

  it("a failure is reported and the tool is no longer busy; a second click while busy starts nothing", async () => {
    const { deps, install } = service([]);
    const errors: string[] = [];
    deps.events.on("appError", ({ message }) => errors.push(message));
    let finish: () => void = () => undefined;
    deps.installPackage.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
    const first = install.install("ruff", "Ruff");
    expect(install.isBusy("ruff")).toBe(true);
    expect(await install.install("ruff", "Ruff")).toBe(false);
    finish();
    expect(await first).toBe(true);
    deps.installPackage.mockRejectedValueOnce("pip exited with code 1");
    expect(await install.install("ruff", "Ruff")).toBe(false);
    expect(errors).toEqual(["Installing Ruff failed: pip exited with code 1"]);
    expect(install.isBusy("ruff")).toBe(false);
  });
});
