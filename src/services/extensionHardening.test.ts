import { afterEach, describe, expect, it, vi } from "vitest";

import { command, rig, started } from "../testUtils/extensionRig";
import { emptyExtensionsSnapshot, testExtension } from "../testUtils/fakeExtensionsIpc";
import { MAX_AUTO_RESTARTS } from "./extensionHostService";
import { PERMISSION_LIMITS_NOTE, hostStateText, permissionLines } from "./extensionModel";
import type { ExtensionHostStatus, InstalledExtension } from "./extensionsIpc";

const NODE = { portable: true, system: null, allowSystem: false };

const risky = testExtension({
  permissions: {
    requested: ["network", "processExecution"],
    inferred: ["commands"],
    accepted: ["commands", "network", "processExecution"],
    highRisk: ["network", "processExecution"],
  },
});

afterEach(() => {
  vi.useRealTimers();
});

describe("permissions", () => {
  it("lists what an extension asks for or implies, dangerous ones first, with where each comes from", () => {
    const lines = permissionLines(risky);
    expect(lines.map((line) => line.name)).toEqual(["network", "processExecution", "commands"]);
    expect(lines[0]).toMatchObject({ highRisk: true, origin: "requested", accepted: true });
    expect(lines[2]).toMatchObject({ highRisk: false, origin: "inferred" });
    expect(permissionLines(testExtension({ permissions: { requested: [], inferred: [], accepted: [], highRisk: [] } }))).toEqual([]);
    expect(PERMISSION_LIMITS_NOTE).toContain("not a sandbox");
  });

  it("marks a permission that was not accepted", () => {
    const legacy: InstalledExtension = testExtension({
      permissions: { requested: ["network"], inferred: [], accepted: [], highRisk: ["network"] },
    });
    expect(permissionLines(legacy)[0]).toMatchObject({ name: "network", accepted: false });
  });
});

describe("extension host state and restarts", () => {
  const crashed: ExtensionHostStatus = { state: "crashed", pid: null, node: null, error: "It died." };

  async function running() {
    const r = await started([command], { node: NODE });
    let push: (status: ExtensionHostStatus) => void = () => undefined;
    vi.mocked(r.ipc.onExtHostState).mockImplementation((handler) => {
      push = handler;
      return Promise.resolve(() => undefined);
    });
    await r.host.initialize();
    expect(await r.host.start()).toBe(true);
    return { r, crash: () => {
      push(crashed);
    } };
  }

  it("describes every state in words", () => {
    const base = { pid: null, node: null, error: null };
    expect(hostStateText({ ...base, state: "starting" })).toBe("Starting…");
    expect(hostStateText({ ...base, state: "restarting" })).toContain("Restarting");
    expect(hostStateText({ ...base, state: "crashed", error: "x" })).toBe("Stopped unexpectedly: x");
    expect(hostStateText({ ...base, state: "stopped" })).toContain("starts when an extension needs it");
    expect(hostStateText({ ...base, state: "running", node: "OpenMind portable Node.js" })).toBe("Running (OpenMind portable Node.js)");
  });

  it("a crash is announced, logged and the host is restarted", async () => {
    const { r, crash } = await running();
    crash();
    expect(r.host.status().state).toBe("restarting");
    expect(r.errors.some((message) => message.includes("It died."))).toBe(true);
    expect(r.logs.some((line) => line.includes("Extension host crashed: It died."))).toBe(true);
    await vi.waitFor(() => {
      expect(vi.mocked(r.ipc.extHostStart)).toHaveBeenCalledTimes(2);
    });
    await vi.waitFor(() => {
      expect(r.host.status().state).toBe("running");
    });
  });

  it("does not restart forever: after the limit the user has to do it", async () => {
    const { r, crash } = await running();
    for (let attempt = 1; attempt <= MAX_AUTO_RESTARTS; attempt += 1) {
      crash();
      await vi.waitFor(() => {
        expect(vi.mocked(r.ipc.extHostStart)).toHaveBeenCalledTimes(attempt + 1);
      });
      await vi.waitFor(() => {
        expect(r.host.status().state).toBe("running");
      });
    }
    crash();
    expect(r.host.status().state).toBe("crashed");
    expect(r.logs.some((line) => line.includes("Not restarting the extension host again automatically"))).toBe(true);
    expect(vi.mocked(r.ipc.extHostStart)).toHaveBeenCalledTimes(MAX_AUTO_RESTARTS + 1);
    // Restart Extension Host is still there and works.
    await r.service.reloadHost();
    expect(r.host.status().state).toBe("running");
    expect(vi.mocked(r.ipc.extHostStart)).toHaveBeenCalledTimes(MAX_AUTO_RESTARTS + 2);
  });

  it("a host that failed to start is not restarted by itself", async () => {
    const r = await started([command], { node: NODE });
    vi.mocked(r.ipc.extHostStart).mockRejectedValue("Extension host: it never became ready");
    expect(await r.host.start()).toBe(false);
    expect(vi.mocked(r.ipc.extHostStart)).toHaveBeenCalledTimes(1);
  });

  it("a failing extension is marked errored while the others stay active", async () => {
    const other = testExtension({ manifest: { ...command.manifest, name: "other" } });
    const r = await started([command, other], {
      node: NODE,
      activity: {
        [command.id]: { active: false, lastError: "Activating a.b failed: boom", activationCount: 0, lastActivation: null },
        [other.id]: { active: true, lastError: null, activationCount: 3, lastActivation: "2026-09-25 10:00:00" },
      },
    });
    expect(r.registry.activityOf(command.id).lastError).toBe("Activating a.b failed: boom");
    expect(r.registry.activityOf(other.id)).toMatchObject({ active: true, activationCount: 3 });
    // The registry still lists both: one bad extension breaks nothing else.
    expect(r.registry.all()).toHaveLength(2);
  });
});

describe("extension logs", () => {
  it("install, enable, disable and uninstall are written to the Extensions log", async () => {
    const r = await started([]);
    r.snapshot.current = emptyExtensionsSnapshot({ extensions: [command] });
    vi.mocked(r.ipc.extPickVsix).mockResolvedValue("C:/a.vsix");
    vi.mocked(r.ipc.extInspectVsix).mockResolvedValue(command);
    vi.mocked(r.ipc.extInstall).mockResolvedValue(command);
    await r.service.chooseVsix();
    await r.service.confirmInstall();
    await r.service.setEnabled(command.id, false);
    await r.service.setEnabled(command.id, true);
    r.service.requestUninstall(command.id);
    await r.service.confirmUninstall();
    const text = r.logs.join("\n");
    expect(text).toContain(`Installed ${command.id} 1.0.0 (permissions: commands)`);
    expect(text).toContain(`${command.id} disabled.`);
    expect(text).toContain(`${command.id} enabled.`);
    expect(text).toContain(`${command.id} uninstalled.`);
  });

  it("a failed install and a failed activation are logged too", async () => {
    const r = await started([command], { node: NODE });
    vi.mocked(r.ipc.extPickVsix).mockResolvedValue("C:/a.vsix");
    vi.mocked(r.ipc.extInspectVsix).mockResolvedValue(command);
    vi.mocked(r.ipc.extInstall).mockRejectedValue(new Error("the theme file \"./x.json\" is missing from the package"));
    await r.service.chooseVsix();
    await r.service.confirmInstall();
    expect(r.logs.join("\n")).toContain("Install failed: the theme file");
    vi.mocked(r.ipc.extActivateFor).mockResolvedValue([{ id: command.id, ok: false, error: "boom" }]);
    await r.host.activateFor({ kind: "startup" });
    expect(r.logs.join("\n")).toContain(`Activation failed for ${command.id}: boom`);
  });

  it("disabling an extension with a language says the language stays until restart", async () => {
    const language = testExtension({
      manifest: {
        ...command.manifest,
        contributes: {
          ...command.manifest.contributes,
          languages: [{ id: "x", extensions: [".x"], filenames: [], aliases: [] }],
        },
      },
    });
    const r = await started([language]);
    await r.service.setEnabled(language.id, false);
    expect(r.service.getState().notice).toContain("languages stay registered until OpenMind Studio restarts");
  });
});

describe("contribution hardening", () => {
  it("two extensions contributing one command id: the first keeps it, the second doesn't replace it", async () => {
    const duplicate = testExtension({
      manifest: {
        ...command.manifest,
        name: "dup",
        contributes: { ...command.manifest.contributes, keybindings: [] },
      },
    });
    const r = await started([command, duplicate], { node: NODE });
    expect(r.commands.list().filter((id) => id === "sampleCommand.hello")).toHaveLength(1);
    expect(r.contributions.commandInfos().filter((info) => info.id === "sampleCommand.hello")).toHaveLength(2);
  });

  it("disabling an extension removes its keybindings, commands and editor actions at once", async () => {
    const r = await started([command], { node: NODE });
    expect(r.contributions.keybindings()).toHaveLength(1);
    r.snapshot.current = emptyExtensionsSnapshot({ extensions: [{ ...command, enabled: false }], node: NODE });
    await r.registry.refresh();
    expect(r.contributions.keybindings()).toEqual([]);
    expect(r.commands.has("sampleCommand.hello")).toBe(false);
    expect(r.editorActions).toEqual([]);
  });

  it("a bad snippets file is reported and offers nothing", async () => {
    const snippets = testExtension({
      runtimeRequirement: null,
      manifest: {
        ...command.manifest,
        main: null,
        contributes: {
          ...command.manifest.contributes,
          languages: [{ id: "s", extensions: [".s"], filenames: [], aliases: [] }],
          snippets: [{ language: "s", path: "./snippets.json" }],
        },
      },
    });
    const r = rig([snippets]);
    vi.mocked(r.ipc.extReadFile).mockResolvedValue("{ not json");
    await r.registry.initialize();
    r.contributions.initialize();
    await vi.waitFor(() => {
      expect(r.errors.some((message) => message.includes("couldn't load ./snippets.json"))).toBe(true);
    });
  });

  it("an invalid theme file is refused with the reason and the app keeps its theme", async () => {
    const themed = testExtension({
      manifest: {
        ...command.manifest,
        contributes: {
          ...command.manifest.contributes,
          themes: [{ label: "Broken", uiTheme: "vs-dark", path: "./t.json" }],
        },
      },
    });
    const r = await started([themed]);
    vi.mocked(r.ipc.extReadFile).mockResolvedValue("[1, 2]");
    await expect(r.contributions.load(`extension:${themed.id}/Broken`)).rejects.toThrow("JSON object");
  });
});

describe("theme fallback", () => {
  it("disabling or uninstalling the extension of the active colour theme resets the setting to the default", async () => {
    const themed = testExtension({
      manifest: {
        ...command.manifest,
        contributes: { ...command.manifest.contributes, themes: [{ label: "Night", uiTheme: "vs-dark", path: "./t.json" }] },
      },
    });
    const r = await started([themed]);
    const settings = (r.service as unknown as { settings: { string: (id: string, d: string) => string; reset: (s: string, id: string) => Promise<unknown> } }).settings;
    vi.spyOn(settings, "string").mockReturnValue(`extension:${themed.id}/Night`);
    const reset = vi.spyOn(settings, "reset").mockResolvedValue({ ok: true });
    await r.service.setEnabled(themed.id, false);
    expect(reset).toHaveBeenCalledWith("user", "workbench.colorTheme");
    expect(r.logs.join("\n")).toContain("back to the default theme");
    reset.mockClear();
    r.service.requestUninstall(themed.id);
    await r.service.confirmUninstall();
    expect(reset).toHaveBeenCalledTimes(1);
    reset.mockClear();
    vi.spyOn(settings, "string").mockReturnValue("dark");
    await r.service.setEnabled(themed.id, false);
    expect(reset).not.toHaveBeenCalled();
  });
});
