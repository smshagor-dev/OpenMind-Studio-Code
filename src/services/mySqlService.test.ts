import { describe, expect, it, vi } from "vitest";

import { createFakeIpc, STOPPED_MYSQL } from "../testUtils/fakeIpcClient";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { MySqlStatus, ServiceInfo } from "./ipc";
import { MYSQL_CHANNEL, MySqlService, mySqlHasProcesses, mySqlStartAvailability } from "./mySqlService";
import { OutputService } from "./outputService";
import { RuntimeService } from "./runtimeService";

function service(port: number, pid: number, url: string | null = null): ServiceInfo {
  return { run: { runId: String(pid), file: "", pid }, port, url, ready: true, version: null, phpVersion: null };
}

const RUNNING: MySqlStatus = {
  ...STOPPED_MYSQL,
  state: "running",
  mariadb: service(3306, 10),
  phpmyadmin: service(8081, 11, "http://127.0.0.1:8081"),
};

async function setup(overrides: Parameters<typeof createFakeIpc>[0] = {}) {
  const handlers: (() => void)[] = [];
  const ipc = createFakeIpc({
    onMysqlChanged: vi.fn((handler: () => void) => {
      handlers.push(handler);
      return Promise.resolve(() => undefined);
    }),
    ...overrides,
  });
  const events = new EventBus<AppEvents>();
  const output = new OutputService();
  const runtime = new RuntimeService(ipc, events, () => undefined);
  const mysql = new MySqlService(ipc, events, output, runtime);
  await mysql.initialize();
  const errors: string[] = [];
  events.on("appError", ({ message }) => errors.push(message));
  return { mysql, ipc, output, errors, changed: () => { handlers.forEach((h) => { h(); }); } };
}

describe("MySQL availability", () => {
  it("Start needs the runtimes, and waits while the stack is busy", () => {
    expect(mySqlStartAvailability(STOPPED_MYSQL, null)).toEqual({ enabled: true });
    expect(mySqlStartAvailability({ ...STOPPED_MYSQL, missing: ["MariaDB"] }, null).reason).toBe(
      "Not installed yet: MariaDB. Install it with Config > Install.",
    );
    for (const state of ["initializing", "starting", "stopping"] as const) {
      expect(mySqlStartAvailability({ ...STOPPED_MYSQL, state }, null).enabled).toBe(false);
    }
    expect(mySqlStartAvailability(STOPPED_MYSQL, "start").enabled).toBe(false);
    expect(mySqlStartAvailability(RUNNING, null).reason).toBe("MySQL is already running.");
    expect(mySqlStartAvailability(null, null).enabled).toBe(false);
  });

  it("Stop has work whenever any part of the stack runs (a half-started stack can be stopped)", () => {
    expect(mySqlHasProcesses(STOPPED_MYSQL)).toBe(false);
    expect(mySqlHasProcesses({ ...STOPPED_MYSQL, state: "error", mariadb: service(3306, 1) })).toBe(true);
    expect(mySqlHasProcesses({ ...STOPPED_MYSQL, state: "error", phpmyadmin: service(8081, 2) })).toBe(true);
  });
});

describe("MySqlService", () => {
  it("shows the backend's status, names the engine MariaDB and lists both ports", async () => {
    const { mysql } = await setup({ mysqlStatus: vi.fn().mockResolvedValue(RUNNING) });
    expect(mysql.label()).toBe("Running");
    expect(mysql.details()).toBe("MariaDB 11.8.9 · phpMyAdmin 5.2.3 · 127.0.0.1:3306");
    expect(mysql.details()).not.toMatch(/Oracle/);
    expect(mysql.ports()).toBe("3306, 8081");
    expect(mysql.pid()).toBe(10);
  });

  it("Start is one backend command; the result becomes the status", async () => {
    const { mysql, ipc, output } = await setup({ mysqlStart: vi.fn().mockResolvedValue(RUNNING) });
    expect(await mysql.start()).toBe(true);
    expect(ipc.mysqlStart).toHaveBeenCalledTimes(1);
    expect(mysql.isRunning()).toBe(true);
    expect(output.getLines(MYSQL_CHANNEL).join("\n")).toContain("MySQL is running: MariaDB 11.8.9");
  });

  it("a second click while busy starts nothing", async () => {
    let finish: (status: MySqlStatus) => void = () => undefined;
    const { mysql, ipc } = await setup({
      mysqlStart: vi.fn(() => new Promise<MySqlStatus>((resolve) => (finish = resolve))),
    });
    const first = mysql.start();
    expect(mysql.label()).toBe("Starting…");
    expect(await mysql.start()).toBe(false);
    expect(mysql.stopState().enabled).toBe(false);
    finish(RUNNING);
    expect(await first).toBe(true);
    expect(ipc.mysqlStart).toHaveBeenCalledTimes(1);
  });

  it("a failed start is reported with the backend's reason, and the status is read again", async () => {
    const failed: MySqlStatus = {
      ...STOPPED_MYSQL,
      state: "error",
      error: "MariaDB is running, but phpMyAdmin could not start: Port 8081 is already in use.",
      mariadb: service(3306, 10),
    };
    const { mysql, errors } = await setup({
      mysqlStart: vi.fn().mockRejectedValue("MariaDB is running, but phpMyAdmin could not start: Port 8081 is already in use."),
      mysqlStatus: vi.fn().mockResolvedValueOnce(STOPPED_MYSQL).mockResolvedValue(failed),
    });
    expect(await mysql.start()).toBe(false);
    expect(errors).toEqual(["MariaDB is running, but phpMyAdmin could not start: Port 8081 is already in use."]);
    expect(mysql.label()).toBe("Error");
    expect(mysql.error()).toContain("phpMyAdmin could not start");
    expect(mysql.stopState().enabled).toBe(true);
  });

  it("Stop and Restart are single backend commands too", async () => {
    const { mysql, ipc } = await setup({
      mysqlStatus: vi.fn().mockResolvedValue(RUNNING),
      mysqlStop: vi.fn().mockResolvedValue(STOPPED_MYSQL),
      mysqlRestart: vi.fn().mockResolvedValue(RUNNING),
    });
    expect(await mysql.restart()).toBe(true);
    expect(ipc.mysqlRestart).toHaveBeenCalledTimes(1);
    expect(await mysql.stop()).toBe(true);
    expect(ipc.mysqlStop).toHaveBeenCalledTimes(1);
    expect(mysql.label()).toBe("Stopped");
  });

  it("Open phpMyAdmin starts the stack when it is stopped, then opens the managed address", async () => {
    const { mysql, ipc } = await setup({ mysqlStart: vi.fn().mockResolvedValue(RUNNING) });
    expect(await mysql.openAdmin()).toBe(true);
    expect(ipc.mysqlStart).toHaveBeenCalledTimes(1);
    expect(ipc.openExternalUrl).toHaveBeenCalledWith("http://127.0.0.1:8081");
    // Already running: just opens.
    expect(await mysql.openAdmin()).toBe(true);
    expect(ipc.mysqlStart).toHaveBeenCalledTimes(1);
  });

  it("follows the backend's change events (e.g. MariaDB ended on its own)", async () => {
    const after: MySqlStatus = {
      ...STOPPED_MYSQL,
      state: "error",
      error: "phpMyAdmin is running, but MariaDB isn't (it stopped or never started).",
      phpmyadmin: service(8081, 11, "http://127.0.0.1:8081"),
    };
    const status = vi.fn().mockResolvedValueOnce(RUNNING).mockResolvedValue(after);
    const { mysql, changed } = await setup({ mysqlStatus: status });
    expect(mysql.label()).toBe("Running");
    changed();
    await vi.waitFor(() => {
      expect(mysql.label()).toBe("Error");
    });
    expect(mysql.error()).toContain("MariaDB isn't");
  });
});
