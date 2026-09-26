import type { Availability } from "./runtimeService";

// Pure model behind the PHP stack Configuration page: status chips, the connection helpers and the Admin button's
// availability. No I/O, no clipboard — the services do that. Nothing here ever contains a password except
// `envBlock`, which is only ever built at the moment the user asks to copy it.

export type Tone = "ok" | "warn" | "error" | "info" | "off";

export interface Chip {
  label: string;
  tone: Tone;
}

/** What the password row shows while it is hidden: a fixed run of dots, never the real length. */
export const MASKED_PASSWORD = "••••••••";

export const LOCAL_HOST = "127.0.0.1";
export const DB_USER = "root";

export function phpChip(input: {
  installed: boolean;
  active: string | null;
  healthy: boolean;
}): Chip {
  if (!input.installed) return { label: "PHP: Not installed", tone: "warn" };
  if (!input.healthy) return { label: "PHP: Broken", tone: "error" };
  return input.active
    ? { label: `PHP: Active ${input.active}`, tone: "ok" }
    : { label: "PHP: Installed", tone: "info" };
}

export function composerChip(input: { installed: boolean; active: string | null }): Chip {
  if (!input.installed) return { label: "Composer: Not installed", tone: "warn" };
  return input.active
    ? { label: `Composer: ${input.active}`, tone: "ok" }
    : { label: "Composer: Installed", tone: "info" };
}

export type DbStatus = "notInstalled" | "needsInit" | "stopped" | "starting" | "running" | "error";

export function mariaDbChip(status: DbStatus): Chip {
  switch (status) {
    case "running":
      return { label: "MariaDB: Running", tone: "ok" };
    case "starting":
      return { label: "MariaDB: Starting", tone: "info" };
    case "error":
      return { label: "MariaDB: Error", tone: "error" };
    case "notInstalled":
      return { label: "MariaDB: Not installed", tone: "warn" };
    case "needsInit":
      return { label: "MariaDB: Not initialized", tone: "warn" };
    case "stopped":
      return { label: "MariaDB: Stopped", tone: "off" };
  }
}

export function phpMyAdminChip(input: { installed: boolean; running: boolean }): Chip {
  if (!input.installed) return { label: "phpMyAdmin: Not installed", tone: "warn" };
  return input.running
    ? { label: "phpMyAdmin: Running", tone: "ok" }
    : { label: "phpMyAdmin: Available", tone: "info" };
}

/** `mysql://root@127.0.0.1:3307` — no password, so it is safe to copy and paste anywhere. */
export function connectionString(port: number): string {
  return `mysql://${DB_USER}@${LOCAL_HOST}:${String(port)}`;
}

/** The block a Laravel `.env` needs. Built only when the user clicks Copy; never shown, logged or written to a file. */
export function envBlock(port: number, password: string): string {
  return [
    "DB_CONNECTION=mariadb",
    `DB_HOST=${LOCAL_HOST}`,
    `DB_PORT=${String(port)}`,
    "DB_DATABASE=",
    `DB_USERNAME=${DB_USER}`,
    `DB_PASSWORD=${password}`,
  ].join("\n");
}

/**
 * The Admin (open phpMyAdmin) button: it needs phpMyAdmin installed, MariaDB running, phpMyAdmin running and an
 * address. Every "no" says what to do next.
 */
export function adminAvailability(input: {
  installed: boolean;
  running: boolean;
  dbStatus: DbStatus;
  url: string | null;
}): Availability {
  if (!input.installed) {
    return {
      enabled: false,
      reason: "phpMyAdmin isn't installed. Install it from the Runtime Manager.",
    };
  }
  if (input.dbStatus !== "running") {
    return { enabled: false, reason: "Start MariaDB first." };
  }
  if (!input.running || input.url === null) {
    return { enabled: false, reason: "Start phpMyAdmin first — it has no address until it runs." };
  }
  return { enabled: true };
}

export interface LaravelInput {
  isLaravel: boolean;
  hasVendor: boolean;
  hasEnv: boolean;
  npmScripts: string[];
}

export interface LaravelLine {
  id: string;
  label: string;
  /** The command line to copy (never run from here). */
  command: string;
}

/** The commands the Laravel helper offers to copy, from what the project folder really contains. */
export function laravelCommands(input: LaravelInput): LaravelLine[] {
  if (!input.isLaravel) return [];
  const lines: LaravelLine[] = [];
  if (!input.hasVendor) {
    lines.push({
      id: "composer-install",
      label: "Install PHP packages",
      command: "composer install",
    });
  }
  lines.push({ id: "artisan-serve", label: "Serve the app", command: "php artisan serve" });
  for (const script of input.npmScripts) {
    lines.push({
      id: `npm-${script}`,
      label: script === "dev" ? "Front-end dev server" : "Front-end build",
      command: `npm run ${script}`,
    });
  }
  return lines;
}
