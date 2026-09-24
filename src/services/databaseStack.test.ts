import { describe, expect, it } from "vitest";

import { composerAvailability } from "./composerService";
import { databaseStatus, startDatabaseAvailability } from "./mariaDbService";
import type { DatabaseInput } from "./mariaDbService";
import { pmaStartAvailability } from "./phpMyAdminService";

const READY: DatabaseInput = {
  installed: true,
  healthy: true,
  initialized: true,
  running: false,
  busy: null,
  portFree: true,
  port: 3307,
};

describe("MariaDB availability", () => {
  it("walks Not installed → needs init → stopped → running", () => {
    const none = { error: null };
    expect(databaseStatus({ ...READY, installed: false, ...none })).toBe("notInstalled");
    expect(databaseStatus({ ...READY, initialized: false, ...none })).toBe("needsInit");
    expect(databaseStatus({ ...READY, ...none })).toBe("stopped");
    expect(databaseStatus({ ...READY, busy: "starting", ...none })).toBe("starting");
    expect(databaseStatus({ ...READY, running: true, ...none })).toBe("running");
    expect(databaseStatus({ ...READY, error: "boom" })).toBe("error");
  });

  it("every disabled Start has a reason", () => {
    expect(startDatabaseAvailability(READY)).toEqual({ enabled: true });
    expect(startDatabaseAvailability({ ...READY, installed: false }).reason).toBe(
      "MariaDB runtime is not installed yet.",
    );
    expect(startDatabaseAvailability({ ...READY, initialized: false }).reason).toBe(
      "Initialize the database first.",
    );
    expect(startDatabaseAvailability({ ...READY, running: true }).reason).toBe(
      "MariaDB is already running.",
    );
    expect(startDatabaseAvailability({ ...READY, portFree: false }).reason).toContain(
      "Port 3307 is already in use",
    );
  });
});

describe("phpMyAdmin availability", () => {
  const ready = {
    phpInstalled: true,
    pmaInstalled: true,
    pmaHealthy: true,
    mariadbInstalled: true,
    running: false,
    busy: false,
    portFree: true,
    port: 8081,
  };

  it("needs phpMyAdmin, PHP and MariaDB, and a free port", () => {
    expect(pmaStartAvailability(ready)).toEqual({ enabled: true });
    expect(pmaStartAvailability({ ...ready, pmaInstalled: false }).reason).toBe(
      "phpMyAdmin is not installed yet.",
    );
    expect(pmaStartAvailability({ ...ready, phpInstalled: false }).reason).toBe(
      "PHP runtime is not installed yet.",
    );
    expect(pmaStartAvailability({ ...ready, mariadbInstalled: false }).reason).toBe(
      "MariaDB runtime is not installed yet.",
    );
    expect(pmaStartAvailability({ ...ready, portFree: false }).reason).toContain("Port 8081");
  });
});

describe("Composer availability", () => {
  const ready = {
    composerInstalled: true,
    phpInstalled: true,
    phpActive: true,
    root: "C:/My Site",
    project: { isDir: true, hasComposerJson: true },
    running: false,
  };

  it("runs only with portable Composer, an active PHP and a composer.json", () => {
    expect(composerAvailability(ready)).toEqual({ enabled: true });
    expect(composerAvailability({ ...ready, composerInstalled: false }).reason).toBe(
      "Composer is not installed yet.",
    );
    expect(composerAvailability({ ...ready, phpActive: false }).reason).toContain(
      "No PHP is active",
    );
    expect(composerAvailability({ ...ready, root: null }).reason).toBe(
      "Select a valid project folder first.",
    );
    expect(
      composerAvailability({ ...ready, project: { isDir: true, hasComposerJson: false } }).reason,
    ).toBe("This folder has no composer.json.");
    expect(composerAvailability({ ...ready, running: true }).reason).toBe(
      "A Composer command is already running.",
    );
  });
});
