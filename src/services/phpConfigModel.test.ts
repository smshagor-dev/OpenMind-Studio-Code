import { describe, expect, it } from "vitest";

import {
  adminAvailability,
  composerChip,
  connectionString,
  envBlock,
  laravelCommands,
  LOCAL_HOST,
  MASKED_PASSWORD,
  mariaDbChip,
  phpChip,
  phpMyAdminChip,
} from "./phpConfigModel";

describe("status chips", () => {
  it("say Not installed, Broken, Active or Installed for PHP — never more than is known", () => {
    expect(phpChip({ installed: false, active: null, healthy: true })).toEqual({
      label: "PHP: Not installed",
      tone: "warn",
    });
    expect(phpChip({ installed: true, active: "8.4.26", healthy: false }).tone).toBe("error");
    expect(phpChip({ installed: true, active: "8.4.26", healthy: true })).toEqual({
      label: "PHP: Active 8.4.26",
      tone: "ok",
    });
    expect(phpChip({ installed: true, active: null, healthy: true }).label).toBe("PHP: Installed");
  });

  it("Composer shows its active version or that it is missing", () => {
    expect(composerChip({ installed: false, active: null }).label).toBe("Composer: Not installed");
    expect(composerChip({ installed: true, active: "2.10.3" }).label).toBe("Composer: 2.10.3");
  });

  it("MariaDB has a chip for every state", () => {
    const labels = (
      ["running", "starting", "error", "notInstalled", "needsInit", "stopped"] as const
    ).map((status) => mariaDbChip(status).label);
    expect(labels).toEqual([
      "MariaDB: Running",
      "MariaDB: Starting",
      "MariaDB: Error",
      "MariaDB: Not installed",
      "MariaDB: Not initialized",
      "MariaDB: Stopped",
    ]);
    expect(mariaDbChip("error").tone).toBe("error");
  });

  it("phpMyAdmin is Not installed, Available or Running", () => {
    expect(phpMyAdminChip({ installed: false, running: false }).label).toBe(
      "phpMyAdmin: Not installed",
    );
    expect(phpMyAdminChip({ installed: true, running: false }).label).toBe("phpMyAdmin: Available");
    expect(phpMyAdminChip({ installed: true, running: true }).label).toBe("phpMyAdmin: Running");
  });
});

describe("connection helpers", () => {
  it("binds to this computer only by default", () => {
    expect(LOCAL_HOST).toBe("127.0.0.1");
    expect(connectionString(3307)).toBe("mysql://root@127.0.0.1:3307");
  });

  it("the connection string never contains a password", () => {
    expect(connectionString(3307)).not.toMatch(/:[^/@]+@/);
  });

  it("the masked password is a fixed run of dots, not the real length", () => {
    expect(MASKED_PASSWORD).toBe("••••••••");
    expect(envBlock(3307, "a-very-long-password-1234567890")).not.toContain(MASKED_PASSWORD);
  });

  it("the .env block has the DB_* lines a Laravel app needs", () => {
    expect(envBlock(3307, "s3cret")).toBe(
      [
        "DB_CONNECTION=mariadb",
        "DB_HOST=127.0.0.1",
        "DB_PORT=3307",
        "DB_DATABASE=",
        "DB_USERNAME=root",
        "DB_PASSWORD=s3cret",
      ].join("\n"),
    );
  });
});

describe("Admin availability", () => {
  const ready = {
    installed: true,
    running: true,
    dbStatus: "running" as const,
    url: "http://127.0.0.1:8081",
  };

  it("is enabled only when phpMyAdmin runs with an address and MariaDB is running", () => {
    expect(adminAvailability(ready)).toEqual({ enabled: true });
  });

  it("says to install phpMyAdmin first when it is missing", () => {
    expect(adminAvailability({ ...ready, installed: false })).toEqual({
      enabled: false,
      reason: "phpMyAdmin isn't installed. Install it from the Runtime Manager.",
    });
  });

  it("says Start MariaDB first when the database is not running (whatever its state)", () => {
    for (const dbStatus of ["stopped", "needsInit", "notInstalled", "starting", "error"] as const) {
      expect(adminAvailability({ ...ready, dbStatus })).toEqual({
        enabled: false,
        reason: "Start MariaDB first.",
      });
    }
  });

  it("is disabled without an address, with the reason", () => {
    expect(adminAvailability({ ...ready, running: false, url: null }).reason).toMatch(
      /Start phpMyAdmin first/,
    );
    expect(adminAvailability({ ...ready, url: null }).enabled).toBe(false);
  });
});

describe("Laravel helper commands", () => {
  it("offers nothing for a project that is not Laravel", () => {
    expect(
      laravelCommands({ isLaravel: false, hasVendor: false, hasEnv: false, npmScripts: ["dev"] }),
    ).toEqual([]);
  });

  it("offers composer install only while vendor/ is missing, then artisan serve and the npm scripts that exist", () => {
    const fresh = laravelCommands({
      isLaravel: true,
      hasVendor: false,
      hasEnv: false,
      npmScripts: ["dev", "build"],
    });
    expect(fresh.map((line) => line.command)).toEqual([
      "composer install",
      "php artisan serve",
      "npm run dev",
      "npm run build",
    ]);
    const installed = laravelCommands({
      isLaravel: true,
      hasVendor: true,
      hasEnv: true,
      npmScripts: [],
    });
    expect(installed.map((line) => line.command)).toEqual(["php artisan serve"]);
  });
});
