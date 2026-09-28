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
    requires: [],
    license: null,
    downloadBytes: null,
    installBytes: null,
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
}

async function rig(
  runtimes: RuntimeStatus[] = [],
  overrides: Partial<IpcClient> = {},
): Promise<Rig> {
  let handler: (event: RunEvent) => void = () => undefined;
  const ipc = createFakeIpc({
    runtimeList: vi.fn().mockResolvedValue(runtimes),
    phpWebRoot: vi.fn().mockResolvedValue("C:/My Site"),
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
  const php = new PhpServerService(ipc, events, output, runtime, ports, new PanelService(ipc));
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
    expect(startAvailability({ ...ready, phpHealthy: false }).reason).toContain(
      "Runtime Extensions",
    );
    expect(startAvailability({ ...ready, root: null }).reason).toBe(
      "Choose a web root folder first.",
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
    await empty.php.useDefaultRoot();

    expect(empty.php.component("php")).toMatchObject({ state: "notInstalled", version: null });
    expect(empty.php.startState()).toEqual({
      enabled: false,
      reason: "PHP runtime is not installed yet.",
    });
    expect(await empty.php.start()).toBe(false);
    expect(empty.ipc.phpServerStart).not.toHaveBeenCalled();
  });

  it("serves the app's htdocs by default and doesn't save that path (it follows the app folder)", () => {
    expect(r.php.getState()).toMatchObject({ root: "C:/My Site", defaultRoot: true });
    expect(r.ipc.phpWebRoot).toHaveBeenCalled();
    expect(r.php.startState()).toEqual({ enabled: true });
  });

  it("when the web root can't be created, Start is disabled with the folder reason", async () => {
    const broken = await rig(PHP_INSTALLED, {
      phpWebRoot: vi.fn().mockRejectedValue("Couldn't create the web root folder: denied"),
    });
    expect(broken.php.getState().root).toBeNull();
    expect(broken.php.getState().error).toContain("Couldn't create the web root folder");
    expect(broken.php.startState()).toEqual({
      enabled: false,
      reason: "Choose a web root folder first.",
    });
  });

  it("with PHP and a folder Start is enabled; Stop, Restart and Open Browser are not yet", async () => {
    await r.php.useDefaultRoot();

    expect(r.php.startState()).toEqual({ enabled: true });
    expect(r.php.stopState().enabled).toBe(false);
    expect(r.php.restartState().enabled).toBe(false);
    expect(r.php.browserState()).toEqual({
      enabled: false,
      reason: "Start the server first — there is no URL yet.",
    });
  });

  it("Use Default goes back to htdocs after another folder was chosen", async () => {
    await r.php.setRoot("D:/Sites");
    expect(r.php.getState()).toMatchObject({ root: "D:/Sites", defaultRoot: false });

    expect(await r.php.useDefaultRoot()).toBe(true);
    expect(r.php.getState()).toMatchObject({ root: "C:/My Site", defaultRoot: true });
    expect(r.ipc.settingsSet).toHaveBeenLastCalledWith(
      "php.server",
      JSON.stringify({ webRoot: null, port: 8000 }),
    );
  });

  it("Select Folder stores the chosen folder and remembers it with the port", async () => {
    vi.mocked(r.ipc.openFolderDialog).mockResolvedValue("D:/Sites/shop");

    expect(await r.php.selectFolder()).toBe(true);

    expect(r.php.getState().root).toBe("D:/Sites/shop");
    expect(r.ipc.settingsSet).toHaveBeenCalledWith(
      "php.server",
      JSON.stringify({ webRoot: "D:/Sites/shop", port: 8000 }),
    );
  });

  it("restores the saved folder and port on start-up", async () => {
    const saved = await rig(PHP_INSTALLED, {
      settingsGet: vi.fn().mockResolvedValue(JSON.stringify({ webRoot: "D:/kept", port: 8123 })),
    });

    expect(saved.php.getState()).toMatchObject({
      root: "D:/kept",
      defaultRoot: false,
      port: 8123,
      server: null,
    });
    expect(saved.ipc.phpServerStart).not.toHaveBeenCalled(); // never auto-starts
  });

  it("an old project folder setting is not reused: the server serves the web root", async () => {
    const old = await rig(PHP_INSTALLED, {
      settingsGet: vi
        .fn()
        .mockResolvedValue(JSON.stringify({ root: "D:/one-project", port: 8123 })),
    });

    expect(old.php.getState()).toMatchObject({ root: "C:/My Site", defaultRoot: true, port: 8123 });
  });

  it("starts the server, shows its URL, and registers the port for the Ports panel", async () => {
    await r.php.useDefaultRoot();

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
    await r.php.useDefaultRoot();
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
    await r.php.useDefaultRoot();
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
    await r.php.useDefaultRoot();
    await r.php.start();

    r.emit({ runId: "php-1", type: "exited", code: 255, durationMs: 5, stopped: false });

    expect(r.output.getLines(PHP_CHANNEL).join("\n")).toContain("Server exited with code 255.");
    expect(r.php.getState().server).toBeNull();
    expect(r.ports.list()).toEqual([]);
  });

  it("an exit that arrives before the start call returns doesn't leave a ghost server", async () => {
    await r.php.useDefaultRoot();
    vi.mocked(r.ipc.phpServerStart).mockImplementation(() => {
      r.emit({ runId: "php-1", type: "exited", code: 1, durationMs: 1, stopped: false });
      return Promise.resolve({
        run: { runId: "php-1", file: "", pid: 1 },
        url: "http://127.0.0.1:8000",
        port: 8000,
        phpVersion: null,
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
    await busy.php.useDefaultRoot();
    expect(busy.php.getState().portFree).toBe(false);
    expect(busy.php.startState().reason).toContain("Port 8000 is already in use");

    await r.php.useDefaultRoot();
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

    await r.php.useDefaultRoot();
    await r.php.start();
    expect(r.ipc.phpServerStart).toHaveBeenCalledWith({ root: "C:/My Site", port: 8081 });
    expect(r.php.getState().portFree).toBeNull(); // not re-checked while it is ours
  });

  it("Restart stops, waits for the exit, and starts again", async () => {
    await r.php.useDefaultRoot();
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
      phpVersion: null,
    });

    expect(await r.php.restart()).toBe(true);

    expect(r.ipc.phpServerStart).toHaveBeenCalledTimes(2);
    expect(r.php.getState().server?.runId).toBe("php-2");
  });

  it("Open Browser opens the running server's URL, and Open Logs shows the Output channel", async () => {
    await r.php.useDefaultRoot();
    await r.php.start();

    await r.php.openBrowser();
    await r.php.openLogs();

    expect(r.ipc.openExternalUrl).toHaveBeenCalledWith("http://127.0.0.1:8000");
    expect(r.output.getState().selected).toBe(PHP_CHANNEL);
  });

  it("shows Composer's installed version", async () => {
    const both = await rig([
      status("php", [version("8.4.26")]),
      status("composer", [version("2.10.3")]),
    ]);
    expect(both.php.component("composer")).toMatchObject({ state: "installed", version: "2.10.3" });
  });

  it("a running server pins the PHP version it started with: no delete/repair of it, and a notice after a switch", async () => {
    const both = await rig([
      status("php", [version("8.4.26"), version("8.3.35", { active: false })]),
    ]);
    vi.mocked(both.ipc.phpServerStart).mockResolvedValue({
      run: { runId: "php-1", file: "", pid: 1 },
      url: "http://127.0.0.1:8000",
      port: 8000,
      phpVersion: "8.4.26",
    });
    await both.php.useDefaultRoot();
    await both.php.start();

    expect(both.php.getState().server?.phpVersion).toBe("8.4.26");
    expect(both.php.versionInUse("php", "8.4.26")?.reason).toBe(
      "The PHP server is running on PHP 8.4.26. Stop the server first.",
    );
    expect(both.php.versionInUse("php", "8.3.35")).toBeNull();
    expect(both.php.versionInUse("composer", "8.4.26")).toBeNull();
    expect(both.php.restartNotice()).toBeNull();

    // The user makes 8.3 the active PHP while the server keeps running on 8.4.
    vi.mocked(both.ipc.runtimeList).mockResolvedValue([
      status("php", [version("8.4.26", { active: false }), version("8.3.35", { active: true })]),
    ]);
    await both.runtime.refresh();

    expect(both.php.restartNotice()).toContain(
      "Restart the PHP server to use the new PHP version.",
    );
    expect(both.php.restartNotice()).toContain("PHP 8.3.35 is now active");

    // Stopping clears both.
    both.emit({ runId: "php-1", type: "exited", code: null, durationMs: 1, stopped: true });
    expect(both.php.restartNotice()).toBeNull();
    expect(both.php.versionInUse("php", "8.4.26")).toBeNull();
  });

  it("a damaged PHP refuses Start (pointing at Runtime Extensions) and keeps the install button off", async () => {
    const damaged = await rig([status("php", [version("8.4.26", { healthy: false })])]);
    await damaged.php.useDefaultRoot();

    expect(damaged.php.component("php").state).toBe("needsRepair");
    expect(damaged.php.startState().reason).toContain("repair it");
  });

  it("adopts a server another window started, and drops it when the backend says it ended", async () => {
    const other = await rig(PHP_INSTALLED);
    vi.mocked(other.ipc.phpServerStatus).mockResolvedValue({
      run: { runId: "php-9", file: "", pid: 9 },
      url: "http://127.0.0.1:8123",
      port: 8123,
      phpVersion: "8.4.26",
    });

    await other.php.syncServer();

    expect(other.php.getState().server).toMatchObject({ runId: "php-9", port: 8123 });
    expect(other.ports.list()).toEqual([expect.objectContaining({ port: 8123 })]);
    expect(other.php.stopState()).toEqual({ enabled: true });

    vi.mocked(other.ipc.phpServerStatus).mockResolvedValue(null);
    await other.php.syncServer();

    expect(other.php.getState().server).toBeNull();
    expect(other.ports.list()).toEqual([]);
  });

  it("reads a server that is already running when the window opens", async () => {
    const opened = await rig(PHP_INSTALLED, {
      phpServerStatus: vi.fn().mockResolvedValue({
        run: { runId: "php-3", file: "", pid: 3 },
        url: "http://127.0.0.1:8000",
        port: 8000,
        phpVersion: "8.3.35",
      }),
    });

    expect(opened.php.getState().server).toMatchObject({ runId: "php-3", phpVersion: "8.3.35" });
  });

  it("the commands are enabled exactly when the panel's buttons are", async () => {
    r = await rig(PHP_INSTALLED, {
      phpWebRoot: vi
        .fn()
        .mockRejectedValueOnce("Couldn't create the web root folder: busy")
        .mockResolvedValue("C:/My Site"),
    });
    const commands = new CommandRegistry();
    registerPhpCommands(commands, r.php, r.ipc);
    expect(commands.isEnabled("php.startServer")).toBe(false);
    expect(commands.isEnabled("php.openLogs")).toBe(true);

    await r.php.useDefaultRoot();
    expect(commands.isEnabled("php.startServer")).toBe(true);
    await commands.execute("php.startServer");
    expect(commands.isEnabled("php.stopServer")).toBe(true);
    expect(commands.isEnabled("php.restartServer")).toBe(true);
    expect(commands.isEnabled("php.openBrowser")).toBe(true);
    expect(commands.isEnabled("php.startServer")).toBe(false);
  });
});
