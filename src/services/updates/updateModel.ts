// Pure rules of the update UI (no React, no Tauri): what the status bar says, and when a mandatory update blocks work.
import type { UpdateInfo } from "./updateIpc";

/** What the status bar item shows, or null when there is nothing worth showing (up to date, or a quiet failure). */
export interface UpdateStatusText {
  key: string;
  params: Record<string, string | number>;
  /** Draws attention (ready to install, mandatory, or a failure the user should know about). */
  prominent: boolean;
}

export function percent(info: Pick<UpdateInfo, "downloaded" | "total">): number | null {
  if (info.total === null || info.total <= 0) return null;
  return Math.min(100, Math.floor((info.downloaded / info.total) * 100));
}

export function statusText(info: UpdateInfo | null): UpdateStatusText | null {
  if (info === null) return null;
  const version = info.version ?? "";
  switch (info.phase) {
    case "downloading": {
      const done = percent(info);
      return done === null
        ? { key: "update.status.downloading", params: { version }, prominent: false }
        : { key: "update.status.downloadingPercent", params: { version, percent: done }, prominent: false };
    }
    case "ready":
      return { key: "update.status.ready", params: { version }, prominent: true };
    case "installing":
      return { key: "update.status.installing", params: { version }, prominent: true };
    case "available":
      return info.mode.kind === "managed"
        ? { key: "update.status.managed", params: { version }, prominent: info.mandatory }
        : { key: "update.status.available", params: { version }, prominent: info.mandatory };
    case "failed":
      // A network problem is retried quietly; a bad signature, a broken feed or a failed install is worth a word.
      return info.failure === null || info.failure.kind === "network"
        ? null
        : { key: "update.status.failed", params: {}, prominent: true };
    default:
      return null;
  }
}

/**
 * Whether a mandatory update now blocks further work in this window. Only when the update is downloaded, verified and
 * installable here (`ready`, not managed by someone else) — never because the server or the network is unavailable,
 * and never after an install attempt failed and the user chose to continue.
 */
export function mandatoryBlocks(info: UpdateInfo | null, continuedAfterFailure: boolean): boolean {
  return (
    info !== null &&
    info.mandatory &&
    info.ready &&
    info.mode.kind !== "managed" &&
    !continuedAfterFailure &&
    info.phase !== "installing"
  );
}

/** Why Restart to Update can't be pressed now, as an i18n key with parameters (null: it can). */
export function restartBlocker(info: UpdateInfo | null): { key: string; params: Record<string, number> } | null {
  if (info === null || !info.ready) return { key: "update.blocked.notReady", params: {} };
  if (info.mode.kind === "managed") return { key: "update.blocked.managed", params: {} };
  if (info.activity.unsaved > 0) return { key: "update.blocked.unsaved", params: { count: info.activity.unsaved } };
  return null;
}

/** Running programs Restart to Update would stop (asked about before it goes ahead). */
export function interruptions(info: UpdateInfo): number {
  return info.activity.busyTerminals + info.activity.runs;
}
