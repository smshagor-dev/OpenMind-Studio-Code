import { ipcFeed } from "../../testUtils/canonicalFeeds";
import { describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../../testUtils/fakeIpcClient";
import { BufferManager } from "../bufferManager";
import { DocumentService } from "../documentService";
import { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import type { LspServerInfo, LspSnapshot, LspSyncOutcome, RuntimeStatus } from "../ipc";
import { LspService } from "../lspService";
import { installAllMissing, installableServers, serverLanguage, toolState } from "./languageToolsModel";
import { LanguageToolsPromptService } from "./languageToolsPrompt";
import { refreshAfterInstalls, runtimeInstallFingerprint } from "./languageToolsWiring";

const F90 = "C:/My Work/shapes.f90";
const F90_B = "C:/My Work/other.f90";
const PAS = "C:/My Work/hello.pas";
const PHP = "C:/My Work/index.php";

function server(patch: Partial<LspServerInfo> = {}): LspServerInfo {
  return {
    id: "fortran",
    name: "fortls",
    languages: ["fortran"],
    note: null,
    contents: "fortls 3.2.2",
    runtime: "pythonModule",
    installed: false,
    bundled: false,
    installSource: null,
    state: "stopped",
    workspace: "C:/My Work",
    node: null,
    capabilities: null,
    openDocuments: 0,
    pid: null,
    canInstall: true,
    installBlocked: null,
    logPath: "C:/app/logs/lsp/fortran.log",
    logExists: false,
    ...patch,
  };
}

const intelephense = (patch: Partial<LspServerInfo> = {}) =>
  server({ id: "php", name: "Intelephense", languages: ["php"], contents: "intelephense 1.14", runtime: "node", ...patch });

function snapshot(servers: LspServerInfo[]): LspSnapshot {
  return {
    workspace: "C:/My Work",
    node: null,
    nodeProblem: null,
    bundle: { present: false, problem: null, nodeVersion: null, packs: 0 },
    verbose: false,
    servers,
  };
}

/** A real LspService over a fake backend whose language servers can be "installed". */
async function session(servers: LspServerInfo[] = [server()], options: { enabled?: boolean } = {}) {
  const status = { current: snapshot(servers) };
  let finishInstall: () => void = () => undefined;
  const installed = (id: string) => status.current.servers.find((s) => s.id === id)?.installed === true;
  const ipc = createFakeIpc({
    lspStatus: vi.fn().mockImplementation(() => Promise.resolve(status.current)),
    lspSyncDocument: vi.fn().mockImplementation((path: string): Promise<LspSyncOutcome> => {
      const id = path.endsWith(".php") ? "php" : "fortran";
      return Promise.resolve(installed(id) ? { state: "ready", server: id } : { state: "notInstalled", server: id });
    }),
    lspInstall: vi.fn().mockImplementation(
      (id: string) =>
        new Promise<void>((resolve) => {
          finishInstall = () => {
            status.current = snapshot(
              status.current.servers.map((s) => (s.id === id ? { ...s, installed: true, installSource: "download" } : s)),
            );
            resolve();
          };
        }),
    ),
    documentOpen: vi
      .fn()
      .mockImplementation((path: string) =>
        Promise.resolve({ path, content: "program p\nend program p\n", encoding: "utf8", lineEnding: "lf" }),
      ),
  });
  const events = new EventBus<AppEvents>();
  const documents = new DocumentService(ipc, new BufferManager(), events);
  const active = { current: null as string | null };
  const lsp = new LspService(ipc, events, documents, {
    log: () => undefined,
    activeDocId: () => active.current,
    enabled: () => options.enabled ?? true,
  });
  const lspFeed = ipcFeed(() => ipc.lspStatus());
  lsp.useCanonical(lspFeed);
  await lspFeed.catchUp(); // the backend's first read
  await lsp.initialize();
  const prompt = new LanguageToolsPromptService({
    lsp,
    onActiveChange: (listener) => events.on("tabsChanged", listener),
  });
  prompt.start();
  /** Opens a file and brings its tab to the front, as the editor does. */
  const open = async (path: string) => {
    const id = await documents.openFromPath(path);
    active.current = id;
    events.emit("tabsChanged", { tabs: [], activeId: id });
    // With language servers off nothing is synced at all.
    if (options.enabled === false) return id;
    await vi.waitFor(() => {
      if (lsp.fileStatus(id).outcome === null && lsp.fileStatus(id).server !== null) throw new Error("not synced");
    });
    return id;
  };
  const focus = (id: string) => {
    active.current = id;
    events.emit("tabsChanged", { tabs: [], activeId: id });
  };
  return { ipc, lsp, prompt, open, focus, status, finish: () => { finishInstall(); } };
}

describe("language tool status", () => {
  it("says Missing only for a tool one click can download", () => {
    expect(toolState(server(), false)).toBe("missing");
    expect(toolState(server({ canInstall: false, installBlocked: "Python runtime is not installed yet." }), false)).toBe(
      "unavailable",
    );
    expect(toolState(server({ bundled: true }), false)).toBe("included");
  });

  it("reports installing (here or in the backend), installed and running", () => {
    expect(toolState(server(), true)).toBe("installing");
    expect(toolState(server({ state: "installing" }), false)).toBe("installing");
    expect(toolState(server({ installed: true }), false)).toBe("ready");
    expect(toolState(server({ installed: true, state: "running" }), false)).toBe("running");
  });

  it("names each server's language", () => {
    expect(serverLanguage(server())).toBe("Fortran");
    expect(serverLanguage(intelephense())).toBe("PHP");
    expect(serverLanguage(server({ id: "clangd", name: "clangd" }))).toBe("C/C++");
  });
});

describe("Install all missing", () => {
  const all = [
    server(),
    intelephense(),
    server({ id: "python", name: "Pyright", installed: true }),
    server({ id: "rust", name: "rust-analyzer", bundled: true }),
    server({ id: "clangd", name: "clangd", canInstall: false, installBlocked: "needs the bundle" }),
  ];

  it("takes only what is missing and can be installed now", () => {
    expect(installableServers(all, () => false).map((s) => s.name)).toEqual(["fortls", "Intelephense"]);
    expect(installableServers(all, (id) => id === "php").map((s) => s.name)).toEqual(["fortls"]);
  });

  it("installs them one after another, and one failure doesn't stop the rest", async () => {
    const order: string[] = [];
    let running = 0;
    const install = vi.fn(async (id: string) => {
      running += 1;
      expect(running).toBe(1);
      order.push(id);
      await Promise.resolve();
      running -= 1;
      return id !== "fortran";
    });
    const result = await installAllMissing({ servers: () => all, isInstalling: () => false, install });
    expect(order).toEqual(["fortran", "php"]);
    expect(result).toEqual({ installed: ["Intelephense"], failed: ["fortls"] });
  });

  it("works with a real service object whose methods use `this` (found by a physical install)", async () => {
    class Service {
      private readonly installing = new Set<string>();
      readonly done: string[] = [];
      servers() {
        return all;
      }
      isInstalling(id: string) {
        return this.installing.has(id);
      }
      async install(id: string) {
        this.installing.add(id);
        await Promise.resolve();
        this.installing.delete(id);
        this.done.push(id);
        return true;
      }
    }
    const service = new Service();
    const result = await installAllMissing(service);
    expect(service.done).toEqual(["fortran", "php"]);
    expect(result.failed).toEqual([]);
  });
});

describe("the editor's install card", () => {
  it("appears for a Fortran file whose fortls is missing", async () => {
    const s = await session();
    await s.open(F90);
    expect(s.prompt.getState()).toEqual({ serverId: "fortran", installing: false });
    expect(s.prompt.server()?.name).toBe("fortls");
  });

  it("never appears for Pascal (no language server is registered)", async () => {
    const s = await session();
    await s.open(PAS);
    expect(s.ipc.lspSyncDocument).not.toHaveBeenCalled();
    expect(s.prompt.getState().serverId).toBeNull();
  });

  it("stays away when the tool is installed, carried by the bundle, can't be installed now, or servers are off", async () => {
    for (const patch of [
      { installed: true },
      { bundled: true },
      { canInstall: false, installBlocked: "Python runtime is not installed yet." },
    ]) {
      const s = await session([server(patch)]);
      await s.open(F90);
      expect(s.prompt.getState().serverId).toBeNull();
    }
    const off = await session([server()], { enabled: false });
    await off.open(F90);
    expect(off.prompt.getState().serverId).toBeNull();
  });

  it("stays away while the tool is installing", async () => {
    const s = await session([server({ state: "installing", canInstall: false, installBlocked: "It is already installing." })]);
    await s.open(F90);
    expect(s.prompt.getState().serverId).toBeNull();
  });

  it("installs with one click, once, then starts the server and closes", async () => {
    const s = await session();
    await s.open(F90);
    const done = s.prompt.install();
    expect(s.prompt.getState().installing).toBe(true);
    expect(s.lsp.isInstalling("fortran")).toBe(true);
    // A second click (card or Runtime Manager) starts nothing more.
    expect(await s.prompt.install()).toBe(false);
    expect(await s.lsp.install("fortran")).toBe(false);
    expect(s.ipc.lspInstall).toHaveBeenCalledTimes(1);
    expect(s.ipc.lspInstall).toHaveBeenCalledWith("fortran");
    s.finish();
    expect(await done).toBe(true);
    expect(s.prompt.getState()).toEqual({ serverId: null, installing: false });
    // The status was read again and the open file was told to the new server (which starts it).
    expect(s.lsp.servers()[0]?.installed).toBe(true);
    expect(toolState(s.lsp.servers()[0] as LspServerInfo, s.lsp.isInstalling("fortran"))).toBe("ready");
    expect(s.ipc.lspSyncDocument).toHaveBeenCalledTimes(2);
    expect(s.lsp.activeFileStatus().outcome).toEqual({ state: "ready", server: "fortran" });
  });

  it("is shown once per session: Dismiss, another file of the language or a tab switch doesn't bring it back", async () => {
    const s = await session();
    const first = await s.open(F90);
    s.prompt.dismiss();
    expect(s.prompt.getState().serverId).toBeNull();
    await s.open(F90_B);
    s.focus(first);
    expect(s.prompt.getState().serverId).toBeNull();
    expect(s.ipc.lspInstall).not.toHaveBeenCalled();
  });

  it("offers another language's tool on its own, and a replaced card doesn't come back", async () => {
    const s = await session([server(), intelephense()]);
    const fortran = await s.open(F90);
    await s.open(PHP);
    expect(s.prompt.server()?.name).toBe("Intelephense");
    s.focus(fortran);
    expect(s.prompt.server()?.name).toBe("Intelephense");
  });

  it("closes when the tool gets installed elsewhere (Runtime Manager card)", async () => {
    const s = await session();
    await s.open(F90);
    const done = s.lsp.install("fortran");
    expect(s.prompt.getState().serverId).toBeNull();
    s.finish();
    await done;
    expect(s.prompt.getState().serverId).toBeNull();
  });

  it("after a restart: an installed tool is ready with no card; a still-missing one is offered again", async () => {
    const first = await session();
    await first.open(F90);
    first.prompt.dismiss();
    // The next session reads the install from disk (the backend) and keeps nothing of the dismissal.
    const installed = await session([server({ installed: true, installSource: "download" })]);
    await installed.open(F90);
    expect(installed.prompt.getState().serverId).toBeNull();
    expect(toolState(installed.lsp.servers()[0] as LspServerInfo, false)).toBe("ready");
    const missing = await session();
    await missing.open(F90);
    expect(missing.prompt.getState().serverId).toBe("fortran");
  });
});

describe("after an install, no restart", () => {
  function runtimes(list: Partial<RuntimeStatus>[], loaded = true) {
    let state = { loaded, runtimes: list as RuntimeStatus[] };
    const listeners = new Set<() => void>();
    return {
      getState: () => state as ReturnType<import("../runtimeService").RuntimeService["getState"]>,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      set(next: Partial<RuntimeStatus>[]) {
        state = { loaded: true, runtimes: next as RuntimeStatus[] };
        for (const listener of listeners) listener();
      },
    };
  }

  it("refreshes everything that depends on runtimes when one is installed, and nothing at start-up", async () => {
    const python = { id: "python", activeVersion: null, installed: [] };
    const runtime = runtimes([python]);
    const refreshers = [vi.fn(), vi.fn().mockRejectedValue(new Error("boom")), vi.fn()];
    refreshAfterInstalls(runtime, refreshers);
    runtime.set([python]);
    await Promise.resolve();
    for (const refresh of refreshers) expect(refresh).not.toHaveBeenCalled();
    const installedPython = { id: "python", activeVersion: "3.14.7", installed: [{ version: "3.14.7", healthy: true }] };
    runtime.set([installedPython] as Partial<RuntimeStatus>[]);
    await vi.waitFor(() => {
      // One failing refresher doesn't stop the others.
      for (const refresh of refreshers) expect(refresh).toHaveBeenCalledTimes(1);
    });
    expect(runtimeInstallFingerprint(runtime)).toBe("python:3.14.7:1");
  });

  it("starts the server of a file that had none once what it needed is installed", async () => {
    const s = await session();
    const id = await s.open(F90);
    expect(s.lsp.fileStatus(id).outcome?.state).toBe("notInstalled");
    // Installed outside this window's install button (the Runtime Manager, a workload, another window).
    s.status.current = snapshot([server({ installed: true })]);
    await s.lsp.retryUnready();
    expect(s.lsp.fileStatus(id).outcome).toEqual({ state: "ready", server: "fortran" });
    // A file whose server already runs isn't told again.
    const calls = vi.mocked(s.ipc.lspSyncDocument).mock.calls.length;
    await s.lsp.retryUnready();
    expect(vi.mocked(s.ipc.lspSyncDocument).mock.calls.length).toBe(calls);
  });
});
