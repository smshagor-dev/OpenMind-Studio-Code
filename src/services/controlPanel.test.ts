import { connectBackend } from "../testUtils/canonicalFeeds";
import { describe, expect, it, vi } from "vitest";

import { ControlPanelService, clockTime, withoutStamp, withoutTag } from "./controlPanelService";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { InstalledVersion, RuntimeStatus } from "./ipc";
import { MySqlService } from "./mySqlService";
import { OutputService } from "./outputService";
import { PanelService } from "./panelService";
import { PhpServerService } from "./phpServerService";
import { PortsService } from "./portsService";
import { RuntimeService } from "./runtimeService";
import { createFakeIpc, STOPPED_MYSQL } from "../testUtils/fakeIpcClient";

function installed(version: string): InstalledVersion {
  return { version, path: "C:/x", active: true, healthy: true, features: [] };
}

function status(id: string, versions: InstalledVersion[]): RuntimeStatus {
  return {
    id,
    displayName: id,
    description: "",
    notes: "",
    defaultVersion: "1",
    availableVersions: versions.map((v) => v.version),
    installed: versions,
    activeVersion: versions[0]?.version ?? null,
    globalVersion: null,
    requires: [],
    license: null,
    downloadBytes: null,
    installBytes: null,
    busy: false,
  };
}

async function setup(overrides: Parameters<typeof createFakeIpc>[0] = {}) {
  const ipc = createFakeIpc({
    runtimeList: vi.fn().mockResolvedValue([status("php", [installed("8.4.26")])]),
    phpWebRoot: vi.fn().mockResolvedValue("C:/My Site"),
    ...overrides,
  });
  const events = new EventBus<AppEvents>();
  const output = new OutputService();
  const ports = new PortsService(ipc, events);
  const runtime = new RuntimeService(ipc, events, () => undefined);
  const feeds = connectBackend(ipc, { runtime, ports });
  await runtime.refresh();
  const panel = new PanelService(ipc);
  const php = new PhpServerService(ipc, events, output, runtime, panel);
  php.useCanonical(feeds.servers);
  await php.initialize();
  const mySql = new MySqlService(ipc, events, output);
  mySql.useCanonical(feeds.servers);
  await mySql.initialize();
  const close = vi.fn().mockResolvedValue(undefined);
  const control = new ControlPanelService(
    ipc,
    events,
    output,
    php,
    mySql,
    close,
    () => new Date(2026, 0, 1, 10, 58, 2),
  );
  await control.initialize();
  return { control, php, mySql, output, ipc, close, events };
}

describe("ControlPanelService", () => {
  it("lists the two servers, PHP and MySQL, stopped, with no PID or port", async () => {
    const { control } = await setup();
    const rows = control.rows();
    expect(rows.map((row) => row.name)).toEqual(["PHP", "MySQL"]);
    for (const row of rows) {
      expect(row).toMatchObject({ running: false, pid: null, ports: "", status: "Stopped" });
      expect(row.toggle.label).toBe("Start");
    }
  });

  it("every disabled button carries a reason", async () => {
    const { control } = await setup({
      phpWebRoot: vi.fn().mockRejectedValue("Couldn't create the web root folder: denied"),
      mysqlStatus: vi
        .fn()
        .mockResolvedValue({ ...STOPPED_MYSQL, state: "notInstalled", missing: ["MariaDB"] }),
    });
    const rows = control.rows();
    expect(rows[0]?.toggle.availability).toEqual({
      enabled: false,
      reason: "Choose a web root folder first.",
    });
    expect(rows[0]?.admin.reason).toBe("Start the server first — there is no URL yet.");
    expect(rows[0]?.config.reason).toContain("php.ini");
    expect(rows[1]?.toggle.availability.reason).toBe(
      "Not installed yet: MariaDB. Install it with Config > Install.",
    );
    expect(rows[1]?.admin.reason).toBe(rows[1]?.toggle.availability.reason);
    expect(control.explorerState().reason).toBe("Choose a web root folder first — use Config.");
  });

  it("shows the running PHP server's PID and port, and turns Start into Stop", async () => {
    const { control, php } = await setup();
    await php.useDefaultRoot();
    php.getState();
    const startIpc = vi.spyOn(php, "start");
    await control.toggle("php");
    expect(startIpc).toHaveBeenCalled();
    expect(control.visibleLines().some((line) => line.text === "Starting…")).toBe(true);
  });

  it("config buttons enable once the backend reports a config file and open it", async () => {
    const { control, ipc } = await setup({
      panelConfigPath: vi
        .fn()
        .mockImplementation((module: string) =>
          Promise.resolve(module === "php" ? "C:/app/runtimes/php/php.ini" : null),
        ),
    });
    await control.refreshConfigPaths();
    expect(control.row("php").config).toEqual({ enabled: true });
    expect(control.row("mysql").config.enabled).toBe(false);
    // MySQL's Config is MariaDB's my.ini.
    expect(ipc.panelConfigPath).toHaveBeenCalledWith("mariadb");
    await control.config("php");
    expect(ipc.panelOpenFile).toHaveBeenCalledWith("C:/app/runtimes/php/php.ini");
  });

  it("merges the modules' output into one log with the panel's clock, without their own stamps", async () => {
    const { control, output } = await setup();
    output.append("PHP Server", "[10:00:00] php -S 127.0.0.1:8000");
    output.append("MariaDB", "ready for connections");
    output.append("Search", "not a module channel");
    const lines = control.visibleLines();
    expect(lines.map((line) => `${line.tag}|${line.text}`)).toEqual([
      "main|Control Panel Ready",
      "PHP|php -S 127.0.0.1:8000",
      "MariaDB|ready for connections",
    ]);
    expect(lines[1]?.time).toBe(clockTime(new Date(2026, 0, 1, 10, 58, 2)));
  });

  it("Logs filters the log to one module (MySQL = MariaDB + phpMyAdmin), and again shows everything", async () => {
    const { control, output } = await setup();
    output.append("PHP Server", "a");
    output.append("MariaDB", "b");
    output.append("phpMyAdmin", "c");
    output.append("MySQL", "d");
    control.toggleFilter("mysql");
    expect(control.visibleLines().map((line) => line.text)).toEqual([
      "Control Panel Ready",
      "b",
      "c",
      "d",
    ]);
    control.toggleFilter("mysql");
    expect(control.visibleLines()).toHaveLength(5);
  });

  it("MySQL's toggle starts and stops the whole stack through one backend command each", async () => {
    const running = {
      ...STOPPED_MYSQL,
      state: "running" as const,
      mariadb: { run: { runId: "m", file: "", pid: 900 }, port: 3306, url: null, ready: true, version: null, phpVersion: null },
      phpmyadmin: { run: { runId: "p", file: "", pid: 901 }, port: 8081, url: "http://127.0.0.1:8081", ready: true, version: null, phpVersion: null },
    };
    const { control, ipc } = await setup({
      mysqlStart: vi.fn().mockResolvedValue(running),
      mysqlStop: vi.fn().mockResolvedValue(STOPPED_MYSQL),
    });
    expect(await control.toggle("mysql")).toBe(true);
    expect(ipc.mysqlStart).toHaveBeenCalledTimes(1);
    expect(ipc.mariadbStart).not.toHaveBeenCalled();
    expect(ipc.pmaStart).not.toHaveBeenCalled();
    expect(control.row("mysql")).toMatchObject({ running: true, pid: 900, ports: "3306, 8081", status: "Running" });
    expect(control.ownerOf(901)).toBe("MySQL (phpMyAdmin)");
    expect(await control.toggle("mysql")).toBe(true);
    expect(ipc.mysqlStop).toHaveBeenCalledTimes(1);
    expect(control.row("mysql")).toMatchObject({ running: false, status: "Stopped" });
  });

  it("Explorer, Shell and Quit call the backend / window", async () => {
    const { control, php, ipc, close } = await setup();
    await php.useDefaultRoot();
    expect(control.explorerState()).toEqual({ enabled: true });
    await control.openExplorer();
    expect(ipc.panelOpenFolder).toHaveBeenCalledWith("C:/My Site");
    await control.openShell();
    expect(ipc.panelOpenShell).toHaveBeenCalledWith("C:/My Site");
    await control.quit();
    expect(close).toHaveBeenCalled();
  });

  it("a failing action is reported in the log and as an error, never thrown", async () => {
    const { control, events } = await setup({
      panelOpenShell: vi.fn().mockRejectedValue("no console"),
    });
    const errors: string[] = [];
    events.on("appError", (event) => errors.push(event.message));
    expect(await control.openShell()).toBe(false);
    expect(errors[0]).toContain("no console");
    expect(control.visibleLines().at(-1)?.text).toContain("no console");
  });

  it("Netstat loads listening ports and names the owner of our PIDs", async () => {
    const { control } = await setup({
      panelNetstat: vi
        .fn()
        .mockResolvedValue([
          { address: "127.0.0.1", port: 3306, pid: 4400, process: "mysqld.exe" },
        ]),
    });
    control.setPage("netstat");
    await vi.waitFor(() => {
      expect(control.getState().netstat.rows).toHaveLength(1);
    });
    expect(control.getState().netstat.loadedAt).not.toBeNull();
    expect(control.ownerOf(4400)).toBeNull();
  });

  it("drops a repeated [Tag] prefix but not other brackets", () => {
    expect(withoutTag("MariaDB", "[MariaDB] Database initialized.")).toBe("Database initialized.");
    expect(withoutTag("MariaDB", "[Note] InnoDB started")).toBe("[Note] InnoDB started");
  });

  it("strips the [HH:MM:SS] stamp only at the start", () => {
    expect(withoutStamp("[10:00:00] hello [12:00:00]")).toBe("hello [12:00:00]");
    expect(withoutStamp("plain")).toBe("plain");
  });
});
