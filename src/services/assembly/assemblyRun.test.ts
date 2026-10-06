import { describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../../testUtils/fakeIpcClient";
import { CommandRegistry } from "../commandRegistry";
import { diagnoseDependency, needsInteractiveInput } from "../deps/dependencyModel";
import { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import type { IpcClient, LspServerInfo, RunAvailability, RuntimeStatus } from "../ipc";
import { OutputService } from "../outputService";
import { PanelService } from "../panelService";
import { RunConfigurationService } from "../runConfigurationService";
import { describeRunButton, RunCodeService } from "../runCodeService";
import { registerRunCommands } from "../runCommands";
import { TerminalService } from "../terminalService";
import type { EditorTabView, WorkspaceService } from "../workspaceService";
import { runCodeFingerprint } from "../terminalRefreshWiring";
import { assemblySetup, installAssemblyToolchain, missingRuntimeHost } from "./assemblyToolchain";

const MISSING: RunAvailability = {
  runnable: false,
  kind: null,
  language: null,
  reason: "Assembly toolchain is not installed: NASM and the linker (gcc/ld) are needed to build this file.",
  previewable: false,
  runtimeMissing: true,
  runtime: null,
  command: null,
  resolved: null,
  installRuntime: "assembly",
};

const EDITOR = { tabId: "d", docId: "d", path: "C:/p/hello.asm", dirty: false };

function tab(path: string): EditorTabView {
  return {
    id: "doc-1",
    docId: "doc-1",
    kind: "text",
    preview: false,
    groupId: "group-1",
    path,
    title: path.split("/").pop() ?? "",
    dirty: false,
    encoding: "utf8",
    lineEnding: "lf",
    external: "none",
  };
}

async function service(path: string, overrides: Partial<IpcClient>) {
  const ipc = createFakeIpc({
    terminalListShells: vi.fn().mockResolvedValue([{ kind: "powerShell", label: "PowerShell", available: true }]),
    terminalCreate: vi.fn().mockResolvedValue({ id: "t1", shell: "powerShell", cwd: "C:/p", pid: 1 }),
    ...overrides,
  });
  const events = new EventBus<AppEvents>();
  const panel = new PanelService(ipc);
  const terminal = new TerminalService(ipc, events, () => "C:/p", panel);
  await terminal.initialize();
  const workspace = {
    getState: () => ({ tabs: [tab(path)], activeId: "doc-1", groups: [], activeGroupId: "group-1", weights: [1] }),
    getActiveWorkspace: () => ({ id: 1, name: "p", path: "C:/p" }),
    save: () => Promise.resolve(),
  } as unknown as WorkspaceService;
  const configs = new RunConfigurationService(ipc);
  const run = new RunCodeService(ipc, events, new OutputService(), workspace, configs, terminal, panel);
  await run.initialize();
  await run.refresh();
  return { ipc, run, configs, events };
}

describe("Run Code with a missing assembly toolchain", () => {
  it("is a clickable 'install' button only while something can offer the install", () => {
    const base = { editor: EDITOR, availability: MISSING, availabilityCurrent: true, checking: false, running: false, error: null };
    expect(describeRunButton(base)).toMatchObject({ state: "runtimeMissing", enabled: false });
    expect(describeRunButton({ ...base, canOfferInstall: true })).toMatchObject({ state: "runtimeMissing", enabled: true });
    const rust = { ...MISSING, installRuntime: null };
    expect(describeRunButton({ ...base, availability: rust, canOfferInstall: true }).enabled).toBe(false);
  });

  it("offers the install instead of running", async () => {
    const { ipc, run } = await service("C:/p/hello.asm", { runResolve: vi.fn().mockResolvedValue(MISSING) });
    const offer = vi.fn().mockResolvedValue(true);
    run.setMissingRuntimeHost({ offer });
    expect(run.canRun()).toBe(true);
    expect(await run.run()).toBe(false);
    expect(offer).toHaveBeenCalledWith("assembly", MISSING.reason);
    expect(ipc.runStart).not.toHaveBeenCalled();
  });
});

describe("the missing-toolchain prompt", () => {
  function deps(answer: string | null) {
    const state = { runtimes: [] as RuntimeStatus[] };
    const runtime = {
      getState: () => state,
      install: vi.fn().mockResolvedValue(true),
      installAddon: vi.fn().mockResolvedValue(true),
      repair: vi.fn().mockResolvedValue(true),
    };
    const server = { id: "assembly", installed: false, bundled: false, canInstall: true } as LspServerInfo;
    const lsp = { servers: () => [server], install: vi.fn().mockResolvedValue(true) };
    const settings = { bool: vi.fn().mockReturnValue(true), string: vi.fn().mockReturnValue("x86-64") };
    const confirm = vi.fn().mockResolvedValue(answer);
    const run = vi.fn();
    return { runtime, lsp, settings, confirm, run, state };
  }

  it("repairs a damaged toolchain in place instead of installing another", async () => {
    const d = deps(null);
    d.state.runtimes = [
      {
        id: "assembly",
        activeVersion: "2.15.05",
        installed: [{ version: "2.15.05", healthy: false, addons: [] }],
      } as unknown as RuntimeStatus,
    ];
    expect(await (installAssemblyToolchain as (deps: unknown) => Promise<boolean>)(d)).toBe(true);
    expect(d.runtime.repair).toHaveBeenCalledWith("assembly", "2.15.05");
    expect(d.runtime.install).not.toHaveBeenCalled();
  });

  it("adds the x86 part for an x86 architecture, once, to the installed version", async () => {
    const d = deps(null);
    d.settings.string.mockReturnValue("x86");
    const version = (addons: { id: string; installed: boolean }[]) =>
      ({ id: "assembly", activeVersion: "2.15.05", defaultVersion: "2.15.05", installed: [{ version: "2.15.05", healthy: true, addons }] }) as unknown as RuntimeStatus;
    d.state.runtimes = [version([{ id: "x86", installed: false }])];
    const run = installAssemblyToolchain as (deps: unknown) => Promise<boolean>;
    expect(await run(d)).toBe(true);
    expect(d.runtime.install).not.toHaveBeenCalled();
    expect(d.runtime.installAddon).toHaveBeenCalledWith("assembly", "2.15.05", "x86");
    d.runtime.installAddon.mockClear();
    d.state.runtimes = [version([{ id: "x86", installed: true }])];
    expect(await run(d)).toBe(true);
    expect(d.runtime.installAddon).not.toHaveBeenCalled();
    d.runtime.installAddon.mockResolvedValue(false);
    d.state.runtimes = [version([{ id: "x86", installed: false }])];
    expect(await run(d)).toBe(false);
  });

  it("Install Assembly Toolchain installs the runtime and then asm-lsp", async () => {
    const d = deps("Install Assembly Toolchain");
    const host = missingRuntimeHost(d as unknown as Parameters<typeof missingRuntimeHost>[0]);
    expect(await host.offer("assembly", "missing")).toBe(true);
    const request = d.confirm.mock.calls[0]?.[0] as { buttons: string[]; title: string };
    expect(request.buttons).toEqual(["Install Assembly Toolchain", "Open Runtime Manager"]);
    expect(d.runtime.install).toHaveBeenCalledWith("assembly", null);
    expect(d.lsp.install).toHaveBeenCalledWith("assembly");
  });

  it("Open Runtime Manager opens it and installs nothing; Cancel does nothing", async () => {
    const open = deps("Open Runtime Manager");
    const host = missingRuntimeHost(open as unknown as Parameters<typeof missingRuntimeHost>[0]);
    expect(await host.offer("assembly", "missing")).toBe(false);
    expect(open.run).toHaveBeenCalledWith("runtime.manage");
    expect(open.runtime.install).not.toHaveBeenCalled();
    const cancel = deps(null);
    expect(await missingRuntimeHost(cancel as unknown as Parameters<typeof missingRuntimeHost>[0]).offer("assembly", "x")).toBe(false);
    expect(cancel.run).not.toHaveBeenCalled();
    expect(cancel.runtime.install).not.toHaveBeenCalled();
  });

  it("skips asm-lsp when the language server is turned off, and stops when the runtime install fails", async () => {
    const off = deps(null);
    off.settings.bool.mockReturnValue(false);
    expect(await installAssemblyToolchain(off as unknown as Parameters<typeof installAssemblyToolchain>[0])).toBe(true);
    expect(off.lsp.install).not.toHaveBeenCalled();
    const failed = deps(null);
    failed.runtime.install.mockResolvedValue(false);
    expect(await installAssemblyToolchain(failed as unknown as Parameters<typeof installAssemblyToolchain>[0])).toBe(false);
    expect(failed.lsp.install).not.toHaveBeenCalled();
  });
});

describe("Debug in GDB (Terminal)", () => {
  it("asks the backend for the program under GDB, and is offered only for assembly files", async () => {
    const runnable: RunAvailability = { ...MISSING, runnable: true, runtimeMissing: false, installRuntime: null, reason: null };
    const terminalCommand = vi.fn().mockResolvedValue({
      line: "gdb --args x.exe",
      display: "gdb --args hello.exe",
      runtime: "assembly 2.15.05, x86-64",
      resolved: "C:/b/hello.exe",
      language: "Assembly",
    });
    const asm = await service("C:/p/hello.asm", { runResolve: vi.fn().mockResolvedValue(runnable), runTerminalCommand: terminalCommand });
    const commands = new CommandRegistry();
    registerRunCommands({ commands, events: asm.events, runCode: asm.run, configs: asm.configs });
    expect(commands.isEnabled("assembly.debugInGdb")).toBe(true);
    await commands.execute("assembly.debugInGdb");
    expect(terminalCommand).toHaveBeenCalledWith(expect.objectContaining({ file: "C:/p/hello.asm" }), "powerShell", true);

    const python = await service("C:/p/a.py", { runResolve: vi.fn().mockResolvedValue(runnable) });
    const other = new CommandRegistry();
    registerRunCommands({ commands: other, events: python.events, runCode: python.run, configs: python.configs });
    expect(other.isEnabled("assembly.debugInGdb")).toBe(false);
  });
});

describe("assembly and the dependency helper", () => {
  it("sees keyboard input through the C runtime or the console API", () => {
    expect(needsInteractiveInput(".asm", "        call    scanf")).toBe(true);
    expect(needsInteractiveInput("asm", "call [getchar]")).toBe(true);
    expect(needsInteractiveInput(".asm", "call _fgets")).toBe(true);
    expect(needsInteractiveInput(".s", "\tcall scanf")).toBe(true);
    expect(needsInteractiveInput(".asm", "mov ecx, -10\ncall GetStdHandle\ncall ReadConsoleA")).toBe(true);
    expect(needsInteractiveInput(".asm", "call printf\ncall GetStdHandle\ncall WriteConsoleA")).toBe(false);
  });

  it("points a missing nasm or gdb to the Assembly runtime", () => {
    expect(diagnoseDependency("nasm: command not found")).toMatchObject({ kind: "toolMissing", runtime: "assembly" });
    expect(diagnoseDependency("'gdb' is not recognized as an internal or external command,")).toMatchObject({ runtime: "assembly" });
  });
});

describe("Run Code's runtime fingerprint", () => {
  it("changes when an add-on is installed, so a 32-bit file is checked again", () => {
    const status = (installed: boolean) =>
      [
        {
          id: "assembly",
          activeVersion: "2.15.05",
          installed: [{ version: "2.15.05", healthy: true, addons: [{ id: "x86", installed }] }],
        },
      ] as unknown as RuntimeStatus[];
    expect(runCodeFingerprint(status(false))).not.toBe(runCodeFingerprint(status(true)));
    expect(runCodeFingerprint(status(true))).toBe(runCodeFingerprint(status(true)));
  });
});

describe("a changed Assembly setting", () => {
  it("makes Run Code ask the backend again for the file in front", async () => {
    const resolve = vi.fn().mockResolvedValue(MISSING);
    const { run } = await service("C:/p/hello32.asm", { runResolve: resolve });
    await run.refresh();
    expect(resolve).toHaveBeenCalledTimes(1);
    run.recheck();
    await vi.waitFor(() => {
      expect(resolve).toHaveBeenCalledTimes(2);
    });
  });
});

describe("the Assembly card's complete setup", () => {
  const status = (addons: { id: string; installed: boolean }[] | null) =>
    (addons === null
      ? { id: "assembly", activeVersion: null, installed: [] }
      : {
          id: "assembly",
          activeVersion: "2.15.05",
          installed: [{ version: "2.15.05", healthy: true, addons }],
        }) as unknown as RuntimeStatus;
  const server = (patch: Partial<LspServerInfo>) => [{ id: "assembly", installed: false, bundled: false, canInstall: true, ...patch } as LspServerInfo];

  it("lists what is missing and is complete only when nothing is", () => {
    expect(assemblySetup(status(null), server({}), "x86-64", true)).toEqual({
      toolchain: "missing",
      x86: "notNeeded",
      languageServer: "missing",
      incomplete: true,
    });
    expect(assemblySetup(status([{ id: "x86", installed: false }]), server({}), "x86", true)).toMatchObject({
      toolchain: "installed",
      x86: "missing",
      incomplete: true,
    });
    expect(
      assemblySetup(status([{ id: "x86", installed: true }]), server({ installed: true }), "x86", true),
    ).toMatchObject({ x86: "installed", languageServer: "installed", incomplete: false });
  });

  it("a damaged install needs repair (not a new install), and keeps its x86 part", () => {
    const damaged = {
      id: "assembly",
      activeVersion: "2.15.05",
      installed: [{ version: "2.15.05", healthy: false, addons: [{ id: "x86", installed: true }] }],
    } as unknown as RuntimeStatus;
    expect(assemblySetup(damaged, server({ installed: true }), "x86", true)).toEqual({
      toolchain: "needsRepair",
      x86: "installed",
      languageServer: "installed",
      incomplete: true,
    });
  });

  it("treats asm-lsp as optional: off or not installable never makes the setup incomplete", () => {
    expect(assemblySetup(status([]), server({}), "x86-64", false)).toMatchObject({ languageServer: "off", incomplete: false });
    expect(assemblySetup(status([]), server({ canInstall: false }), "x86-64", true)).toMatchObject({
      languageServer: "unavailable",
      incomplete: false,
    });
  });
});
