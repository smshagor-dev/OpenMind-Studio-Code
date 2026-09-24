import { beforeEach, describe, expect, it, vi } from "vitest";

import { CommandRegistry } from "./commandRegistry";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { InstalledVersion, IpcClient, RunEvent, RuntimeStatus } from "./ipc";
import { OutputService } from "./outputService";
import { PanelService } from "./panelService";
import { registerPhpCommands } from "./phpCommands";
import {
  PHP_CHANNEL,
  PHP_PORT_SOURCE,
  PhpServerService,
  startAvailability,
  validatePort,
} from "./phpServerService";
import { PortsService } from "./portsService";
import { RuntimeService } from "./runtimeService";
import { createFakeIpc } from "../testUtils/fakeIpcClient";

function version(v: string, over: Partial<InstalledVersion> = {}): InstalledVersion {
  return {
    version: v,
    path: `C:/app/runtimes/x/versions/${v}`,
    active: true,
    healthy: true,
    features: [],
    ...over,
  };
}

function status(id: string, installed: InstalledVersion[]): RuntimeStatus {
  return {
    id,
    displayName: id,
    description: "",
    notes: "",
    defaultVersion: installed[0]?.version ?? "1",
    availableVersions: [],
    installed,
    activeVersion: installed.find((entry) => entry.active)?.version ?? null,
    globalVersion: null,
    busy: false,
  };
}

interface Rig {
  php: PhpServerService;
  ipc: IpcClient;
  runtime: RuntimeService;
  output: OutputService;
  ports: PortsService;
  events: EventBus<AppEvents>;
  errors: string[];
  emit: (event: RunEvent) => void;
  workspace: { path: string | null };
}

async function rig(
  runtimes: RuntimeStatus[] = [],
  overrides: Partial<IpcClient> = {},
): Promise<Rig> {
  let handler: (event: RunEvent) => void = () => undefined;
  const ipc = createFakeIpc({
    runtimeList: vi.fn().mockResolvedValue(runtimes),
    onPhpEvent: vi.fn((h: typeof handler) => {
      handler = h;
      return Promise.resolve(() => undefined);
    }),
    ...overrides,
  });
  const events = new EventBus<AppEvents>();
  const errors: string[] = [];
  events.on("appError", ({ message }) => errors.push(message));
  const output = new OutputService();
  const ports = new PortsService(ipc, events);
  const runtime = new RuntimeService(ipc, events, () => undefined);
  await runtime.refresh();
  const workspace = { path: "C:/My Site" as string | null };
  const php = new PhpServerService(
    ipc,
    events,
    output,
    runtime,
    ports,
    new PanelService(ipc),
    () => workspace.path,
  );
  await php.initialize();
  return {
    php,
    ipc,
    runtime,
    output,
    ports,
    events,
    errors,
    emit: (e) => {
      handler(e);
    },
    workspace,
  };
}

const PHP_INSTALLED = [status("php", [version("8.4.26")])];

const started = (over: Record<string, unknown> = {}): RunEvent => ({
  runId: "php-1",
  type: "started",
  file: "C:/My Site",
  commandLine: 'php -S 127.0.0.1:8000 -t "C:/My Site"',
  resolved: "C:/app/runtimes/php/versions/8.4.26/php.exe",
  cwd: "C:/My Site",
  runtime: "OpenMind portable PHP 8.4.26",
  language: "PHP",
  pid: 42,
  ...over,
});

describe("startAvailability", () => {
  const ready = {
    phpInstalled: true,
    phpHealthy: true,
    root: "C:/site",
    running: false,
    busy: false,
    portFree: true,
    port: 8000,
  };

  it("is enabled only with a healthy PHP, a folder, a free port and nothing running", () => {
    expect(startAvailability(ready)).toEqual({ enabled: true });
  });

  it("says why it is disabled, in priority order", () => {
    expect(startAvailability({ ...ready, phpInstalled: false, root: null }).reason).toBe(
      "PHP runtime is not installed yet.",
    );
    expect(startAvailability({ ...ready, phpHealthy: false }).reason).toContain("Repair PHP");
    expect(startAvailability({ ...ready, root: null }).reason).toBe(
      "Select a valid project folder first.",
    );
    expect(startAvailability({ ...ready, running: true }).reason).toBe(
      "The server is already running.",
    );
    expect(startAvailability({ ...ready, portFree: false }).reason).toContain("Port 8000");
  });
});

describe("validatePort", () => {
  it("accepts 1024-65535 and explains anything else", () => {
    expect(validatePort(" 8080 ")).toEqual({ port: 8080 });
    expect(validatePort("1024")).toEqual({ port: 1024 });
    for (const bad of ["", "abc", "80", "0", "65536", "-1", "80.5"]) {
      expect(validatePort(bad), bad).toHaveProperty("error");
    }
  });
});

describe("PhpServerService", () => {
  let r: Rig;

  beforeEach(async () => {
    r = await rig(PHP_INSTALLED);
  });

  it("without PHP, Start is disabled with the reason and Install is offered", async () => {
    const empty = await rig([]);
    await empty.php.useWorkspace();

    expect(empty.php.component("php")).toMatchObject({ state: "notInstalled", version: null });
    expect(empty.php.startState()).toEqual({
      enabled: false,
      reason: "PHP runtime is not installed yet.",
    });
    expect(empty.php.installState("php")).toEqual({ enabled: true });
    expect(await empty.php.start()).toBe(false);
    expect(empty.ipc.phpServerStart).not.toHaveBeenCalled();
  });

  it("without a project folder, Start is disabled with the folder reason", () => {
    expect(r.php.startState()).toEqual({
      enabled: false,
      reason: "Select a valid project folder first.",
    });
  });

  it("with PHP and a folder Start is enabled; Stop, Restart and Open Browser are not yet", async () => {
    await r.php.useWorkspace();

    expect(r.php.startState()).toEqual({ enabled: true });
    expect(r.php.stopState().enabled).toBe(false);
    expect(r.php.restartState().enabled).toBe(false);
    expect(r.php.browserState()).toEqual({
      enabled: false,
      reason: "Start the server first — there is no URL yet.",
    });
  });

  it("Use Current Workspace needs an open folder", async () => {
    r.workspace.path = null;

    expect(await r.php.useWorkspace()).toBe(false);
    expect(r.php.getState().root).toBeNull();
    expect(r.php.getState().error).toContain("Open a folder");
  });

  it("Select Folder stores the chosen folder and remembers it with the port", async () => {
    vi.mocked(r.ipc.openFolderDialog).mockResolvedValue("D:/Sites/shop");

    expect(await r.php.selectFolder()).toBe(true);

    expect(r.php.getState().root).toBe("D:/Sites/shop");
    expect(r.ipc.settingsSet).toHaveBeenCalledWith(
      "php.server",
      JSON.stringify({ root: "D:/Sites/shop", port: 8000 }),
    );
  });

  it("restores the saved folder and port on start-up", async () => {
    const saved = await rig(PHP_INSTALLED, {
      settingsGet: vi.fn().mockResolvedValue(JSON.stringify({ root: "D:/kept", port: 8123 })),
    });

    expect(saved.php.getState()).toMatchObject({ root: "D:/kept", port: 8123, server: null });
    expect(saved.ipc.phpServerStart).not.toHaveBeenCalled(); // never auto-starts
  });

  it("starts the server, shows its URL, and registers the port for the Ports panel", async () => {
    await r.php.useWorkspace();

    expect(await r.php.start()).toBe(true);

    expect(r.ipc.phpServerStart).toHaveBeenCalledWith({ root: "C:/My Site", port: 8000 });
    expect(r.php.url()).toBe("http://127.0.0.1:8000");
    expect(r.ports.list()).toEqual([
      expect.objectContaining({
        port: 8000,
        url: "http://127.0.0.1:8000",
        source: PHP_PORT_SOURCE,
      }),
    ]);
    expect(r.php.startState().reason).toBe("The server is already running.");
    expect(r.php.stopState()).toEqual({ enabled: true });
    expect(r.php.browserState()).toEqual({ enabled: true });
  });

  it("logs the command, cwd, runtime, resolved path, port and every output line", async () => {
    await r.php.useWorkspace();
    await r.php.start();

    r.emit(started());
    r.emit({
      runId: "php-1",
      type: "output",
      stream: "stderr",
      line: "[Thu] 127.0.0.1:5 [200]: GET /",
    });

    const log = r.output.getLines(PHP_CHANNEL).join("\n");
    expect(log).toContain('[PHP Server] php -S 127.0.0.1:8000 -t "C:/My Site"');
    expect(log).toContain("cwd: C:/My Site");
    expect(log).toContain("runtime: OpenMind portable PHP 8.4.26");
    expect(log).toContain("resolved: C:/app/runtimes/php/versions/8.4.26/php.exe");
    expect(log).toContain("port: 8000 (127.0.0.1 only)");
    expect(log).toContain("GET /");
  });

  it("Stop asks the backend, and the exit event clears the server and unregisters the port", async () => {
    await r.php.useWorkspace();
    await r.php.start();

    await r.php.stop();
    expect(r.ipc.phpServerStop).toHaveBeenCalledWith("php-1");
    r.emit({ runId: "php-1", type: "exited", code: null, durationMs: 5, stopped: true });

    expect(r.php.getState().server).toBeNull();
    expect(r.ports.list()).toEqual([]);
    expect(r.output.getLines(PHP_CHANNEL).join("\n")).toContain("Server stopped.");
    expect(r.php.startState()).toEqual({ enabled: true });
  });

  it("a server that dies on its own is reported with its exit code and frees the port entry", async () => {
    await r.php.useWorkspace();
    await r.php.start();

    r.emit({ runId: "php-1", type: "exited", code: 255, durationMs: 5, stopped: false });

    expect(r.output.getLines(PHP_CHANNEL).join("\n")).toContain("Server exited with code 255.");
    expect(r.php.getState().server).toBeNull();
    expect(r.ports.list()).toEqual([]);
  });

  it("an exit that arrives before the start call returns doesn't leave a ghost server", async () => {
    await r.php.useWorkspace();
    vi.mocked(r.ipc.phpServerStart).mockImplementation(() => {
      r.emit({ runId: "php-1", type: "exited", code: 1, durationMs: 1, stopped: false });
      return Promise.resolve({
        run: { runId: "php-1", file: "", pid: 1 },
        url: "http://127.0.0.1:8000",
        port: 8000,
      });
    });

    await r.php.start();

    expect(r.php.getState().server).toBeNull();
    expect(r.ports.list()).toEqual([]);
  });

  it("a busy port disables Start with the port in the reason, and a failed start shows the backend's message", async () => {
    const busy = await rig(PHP_INSTALLED, {
      phpPortFree: vi.fn().mockResolvedValue(false),
    });
    await busy.php.useWorkspace();
    expect(busy.php.getState().portFree).toBe(false);
    expect(busy.php.startState().reason).toContain("Port 8000 is already in use");

    await r.php.useWorkspace();
    vi.mocked(r.ipc.phpServerStart).mockRejectedValue("Port 8000 is already in use.");
    expect(await r.php.start()).toBe(false);
    expect(r.php.getState().error).toBe("Port 8000 is already in use.");
    expect(r.output.getLines(PHP_CHANNEL).join("\n")).toContain("Port 8000 is already in use.");
  });

  it("changing the port validates, persists, re-checks it, and is refused while running", async () => {
    expect(await r.php.setPort("80")).toContain("1024");
    expect(await r.php.setPort("abc")).toContain("port number");
    expect(r.php.getState().port).toBe(8000);

    expect(await r.php.setPort("8081")).toBeNull();
    expect(r.php.getState().port).toBe(8081);
    expect(r.ipc.phpPortFree).toHaveBeenLastCalledWith(8081);
    expect(r.ipc.settingsSet).toHaveBeenCalledWith("php.server", expect.stringContaining("8081"));

    await r.php.useWorkspace();
    await r.php.start();
    expect(r.ipc.phpServerStart).toHaveBeenCalledWith({ root: "C:/My Site", port: 8081 });
    expect(r.php.getState().portFree).toBeNull(); // not re-checked while it is ours
  });

  it("Restart stops, waits for the exit, and starts again", async () => {
    await r.php.useWorkspace();
    await r.php.start();
    vi.mocked(r.ipc.phpServerStop).mockImplementation(() => {
      setTimeout(() => {
        r.emit({ runId: "php-1", type: "exited", code: null, durationMs: 1, stopped: true });
      }, 0);
      return Promise.resolve(true);
    });
    vi.mocked(r.ipc.phpServerStart).mockResolvedValue({
      run: { runId: "php-2", file: "", pid: 2 },
      url: "http://127.0.0.1:8000",
      port: 8000,
    });

    expect(await r.php.restart()).toBe(true);

    expect(r.ipc.phpServerStart).toHaveBeenCalledTimes(2);
    expect(r.php.getState().server?.runId).toBe("php-2");
  });

  it("Open Browser opens the running server's URL, and Open Logs shows the Output channel", async () => {
    await r.php.useWorkspace();
    await r.php.start();

    await r.php.openBrowser();
    await r.php.openLogs();

    expect(r.ipc.openExternalUrl).toHaveBeenCalledWith("http://127.0.0.1:8000");
    expect(r.output.getState().selected).toBe(PHP_CHANNEL);
  });

  it("Composer needs PHP first, shows its version, and PHP can't be deleted while serving", async () => {
    const none = await rig([]);
    expect(none.php.installState("composer")).toEqual({
      enabled: false,
      reason: "Install PHP first — Composer runs on it.",
    });

    const both = await rig([
      status("php", [version("8.4.26")]),
      status("composer", [version("2.10.3")]),
    ]);
    expect(both.php.component("composer")).toMatchObject({ state: "installed", version: "2.10.3" });
    expect(both.php.installState("composer").reason).toBe("Composer is already installed.");
    expect(both.php.deleteState("composer")).toEqual({ enabled: true });

    await both.php.useWorkspace();
    await both.php.start();
    expect(both.php.deleteState("php")).toEqual({
      enabled: false,
      reason: "Stop the server before deleting PHP.",
    });
  });

  it("a damaged PHP offers Repair, refuses Start, and keeps the install button off", async () => {
    const damaged = await rig([status("php", [version("8.4.26", { healthy: false })])]);
    await damaged.php.useWorkspace();

    expect(damaged.php.component("php").state).toBe("needsRepair");
    expect(damaged.php.repairState("php")).toEqual({ enabled: true });
    expect(damaged.php.startState().reason).toContain("Repair PHP");
    expect(damaged.php.installState("php").enabled).toBe(false);
  });

  it("install/repair/delete go through the Runtime Manager", async () => {
    const empty = await rig([]);
    vi.mocked(empty.ipc.runtimeInstall).mockResolvedValue(undefined as never);
    const install = vi.spyOn(empty.runtime, "install").mockResolvedValue(true);
    await empty.php.install("php");
    expect(install).toHaveBeenCalledWith("php", null);

    const repair = vi.spyOn(r.runtime, "repair").mockResolvedValue(true);
    const remove = vi.spyOn(r.runtime, "remove").mockResolvedValue(true);
    await r.php.repair("php");
    await r.php.remove("php");
    expect(repair).toHaveBeenCalledWith("php", "8.4.26");
    expect(remove).toHaveBeenCalledWith("php", "8.4.26");
  });

  it("the commands are enabled exactly when the panel's buttons are", async () => {
    const commands = new CommandRegistry();
    registerPhpCommands(commands, r.php);
    expect(commands.isEnabled("php.startServer")).toBe(false);
    expect(commands.isEnabled("php.openLogs")).toBe(true);

    await r.php.useWorkspace();
    expect(commands.isEnabled("php.startServer")).toBe(true);
    await commands.execute("php.startServer");
    expect(commands.isEnabled("php.stopServer")).toBe(true);
    expect(commands.isEnabled("php.restartServer")).toBe(true);
    expect(commands.isEnabled("php.openBrowser")).toBe(true);
    expect(commands.isEnabled("php.startServer")).toBe(false);
  });
});
