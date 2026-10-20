import type { Availability } from "./runtimeService";
import { t } from "../i18n";

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
  if (!input.installed) return { label: t("php.chip.php.notInstalled"), tone: "warn" };
  if (!input.healthy) return { label: t("php.chip.php.broken"), tone: "error" };
  return input.active
    ? { label: t("php.chip.php.active", { version: input.active }), tone: "ok" }
    : { label: t("php.chip.php.installed"), tone: "info" };
}

export function composerChip(input: { installed: boolean; active: string | null }): Chip {
  if (!input.installed) return { label: t("php.chip.composer.notInstalled"), tone: "warn" };
  return input.active
    ? { label: `Composer: ${input.active}`, tone: "ok" }
    : { label: t("php.chip.composer.installed"), tone: "info" };
}

export type DbStatus = "notInstalled" | "needsInit" | "stopped" | "starting" | "running" | "error";

export function mariaDbChip(status: DbStatus): Chip {
  switch (status) {
    case "running":
      return { label: t("php.chip.db.running"), tone: "ok" };
    case "starting":
      return { label: t("php.chip.db.starting"), tone: "info" };
    case "error":
      return { label: t("php.chip.db.error"), tone: "error" };
    case "notInstalled":
      return { label: t("php.chip.db.notInstalled"), tone: "warn" };
    case "needsInit":
      return { label: t("php.chip.db.needsInit"), tone: "warn" };
    case "stopped":
      return { label: t("php.chip.db.stopped"), tone: "off" };
  }
}

export function phpMyAdminChip(input: { installed: boolean; running: boolean }): Chip {
  if (!input.installed) return { label: t("php.chip.pma.notInstalled"), tone: "warn" };
  return input.running
    ? { label: t("php.chip.pma.running"), tone: "ok" }
    : { label: t("php.chip.pma.available"), tone: "info" };
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
 * What a program needs to reach OpenMind's MySQL, one setting per line (Python, PHP, Node.js ... all take these five).
 * Built only when the user clicks Copy. A password OpenMind can't read (`null`) is left empty for the user to fill in.
 */
export function connectionSettings(port: number, password: string | null, database: string | null): string {
  return [
    `host=${LOCAL_HOST}`,
    `port=${String(port)}`,
    `user=${DB_USER}`,
    `password=${password ?? ""}`,
    ...(database === null ? [] : [`database=${database}`]),
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
