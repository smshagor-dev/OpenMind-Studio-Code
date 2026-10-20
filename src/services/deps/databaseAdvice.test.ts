import { describe, expect, it, vi } from "vitest";

import type { MySqlStatus } from "../ipc";
import type { MySqlServiceState } from "../mySqlService";
import { databaseAdvice } from "./databaseAdvice";
import { databaseHost } from "./databaseHost";

const issue = (problem: "unknownDatabase" | "accessDenied" | "refused", database: string | null, port: number | null) =>
  ({ kind: "databaseConnection", problem, database, port }) as const;
const running = (port: number) => ({ state: "running", port }) as const;

describe("databaseAdvice", () => {
  it("OpenMind's MySQL on 3307 and a message without a port: both servers are named, since either may have answered", () => {
    const advice = databaseAdvice(issue("unknownDatabase", "school", null), running(3307));
    expect(advice.title).toEqual({ key: "deps.db.unknownDatabase", params: { database: "school" } });
    expect(advice.hint).toEqual({
      key: "deps.db.hint.otherServerOrNoDatabase",
      params: { database: "school", port: 3307, usual: 3306 },
    });
    // The database may really be missing on OpenMind's server: phpMyAdmin is offered too.
    expect(advice.actions).toEqual(["copy", "admin", "panel"]);
    expect(databaseAdvice(issue("accessDenied", null, null), running(3307))).toMatchObject({
      hint: { key: "deps.db.hint.otherServerOrPassword", params: { port: 3307, usual: 3306 } },
      actions: ["copy", "panel"],
    });
  });

  it("a refusal on another port names both ports; without a port it says which one to set", () => {
    expect(databaseAdvice(issue("refused", null, 3306), running(3307)).hint).toEqual({
      key: "deps.db.hint.wrongPort",
      params: { database: "", used: 3306, port: 3307 },
    });
    expect(databaseAdvice(issue("refused", null, null), running(3307)).hint.key).toBe("deps.db.hint.setPort");
  });

  it("on the right server the problem itself is explained", () => {
    expect(databaseAdvice(issue("unknownDatabase", "shop", null), running(3306))).toMatchObject({
      hint: { key: "deps.db.hint.noDatabase", params: { database: "shop", port: 3306 } },
      actions: ["admin", "copy"],
    });
    expect(databaseAdvice(issue("unknownDatabase", "shop", 3307), running(3307)).hint.key).toBe("deps.db.hint.noDatabase");
    expect(databaseAdvice(issue("accessDenied", null, null), running(3306)).hint.key).toBe("deps.db.hint.credentials");
    expect(databaseAdvice(issue("refused", null, 3306), running(3306)).hint.key).toBe("deps.db.hint.running");
  });

  it("a stopped, missing or busy server comes first", () => {
    expect(databaseAdvice(issue("refused", null, 3306), { state: "stopped", port: null })).toMatchObject({
      hint: { key: "deps.db.hint.stopped" },
      actions: ["start", "panel"],
    });
    expect(databaseAdvice(issue("refused", null, null), { state: "notInstalled", port: null }).actions).toEqual(["panel"]);
    expect(databaseAdvice(issue("refused", null, null), { state: "busy", port: 3307 }).hint.key).toBe("deps.db.hint.busy");
  });
});

function mySql(status: MySqlStatus | null) {
  const state: MySqlServiceState = { status, busy: null };
  return {
    getState: () => state,
    subscribe: () => () => undefined,
    start: vi.fn(() => Promise.resolve(true)),
    openAdmin: vi.fn(() => Promise.resolve(true)),
  };
}

function status(state: MySqlStatus["state"], port: number | null, missing: string[] = []): MySqlStatus {
  const mariadb = port === null ? null : { port, url: null, ready: state === "running", version: "11.8.9", phpVersion: null };
  return {
    state,
    missing,
    initialized: true,
    error: null,
    mariadb,
    phpmyadmin: null,
    mariadbVersion: "11.8.9",
    phpmyadminVersion: null,
    autoLogin: true,
  } as unknown as MySqlStatus;
}

describe("databaseHost", () => {
  const ipc = (password: string | null) => ({
    mariadbCredentials: vi.fn(() => Promise.resolve({ username: "root", password })),
    clipboardWriteText: vi.fn(() => Promise.resolve()),
  });

  it("opens the PHP Server window through its command", () => {
    const run = vi.fn();
    databaseHost(mySql(null), ipc("root"), run).openPanel();
    expect(run).toHaveBeenCalledWith("php.openWindow");
  });

  it("reports MariaDB's state and port", () => {
    const panel = vi.fn();
    expect(databaseHost(mySql(status("running", 3307)), ipc("root"), panel).status()).toEqual(running(3307));
    expect(databaseHost(mySql(status("stopped", null)), ipc("root"), panel).status()).toEqual({ state: "stopped", port: null });
    expect(databaseHost(mySql(status("notInstalled", null, ["MariaDB"])), ipc("root"), panel).status().state).toBe(
      "notInstalled",
    );
    expect(databaseHost(mySql(status("starting", 3307)), ipc("root"), panel).status()).toEqual({ state: "busy", port: 3307 });
    expect(databaseHost(mySql(null), ipc("root"), panel).status().state).toBe("busy");
  });

  it("copies every setting a program needs, the password read only on that click", async () => {
    const client = ipc("root");
    const host = databaseHost(mySql(status("running", 3307)), client, vi.fn());
    expect(client.mariadbCredentials).not.toHaveBeenCalled();
    await host.copySettings("school");
    expect(client.clipboardWriteText).toHaveBeenCalledWith(
      "host=127.0.0.1\nport=3307\nuser=root\npassword=root\ndatabase=school",
    );
  });

  it("leaves a password it can't read empty, and refuses while MySQL isn't running", async () => {
    const client = ipc(null);
    await databaseHost(mySql(status("running", 3306)), client, vi.fn()).copySettings(null);
    expect(client.clipboardWriteText).toHaveBeenCalledWith("host=127.0.0.1\nport=3306\nuser=root\npassword=");
    await expect(databaseHost(mySql(status("stopped", null)), client, vi.fn()).copySettings(null)).rejects.toThrow();
  });
});
