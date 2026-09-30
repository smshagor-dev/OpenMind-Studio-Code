import type { BrokerEvent, BrokerPhase, BrokerProvider, FailureKind } from "./brokerIpc";
import type { NetProblem } from "./networkIpc";

/** How many operations the Downloads list keeps. */
export const MAX_DOWNLOADS = 50;

const ACTIVE: ReadonlySet<BrokerPhase> = new Set(["queued", "resolving", "connecting", "downloading", "verifying", "finalizing"]);

export function isActive(event: BrokerEvent): boolean {
  return ACTIVE.has(event.phase);
}

/** The list with `event` put in (replacing an older event of the same operation), newest operation first. */
export function upsertDownload(list: readonly BrokerEvent[], event: BrokerEvent): BrokerEvent[] {
  const index = list.findIndex((item) => item.id === event.id);
  if (index >= 0) {
    const next = [...list];
    next[index] = event;
    return next;
  }
  return [event, ...list].slice(0, MAX_DOWNLOADS);
}

/** The list without finished operations (complete, failed, cancelled); running and queued ones stay. */
export function withoutFinished(list: readonly BrokerEvent[]): BrokerEvent[] {
  return list.filter(isActive);
}

/**
 * What "Copy Error Details" puts on the clipboard: the tool, the file, the stage, the failure category and the
 * broker's message. The backend already removed user names, passwords, queries and tokens from the message.
 */
export function errorDetails(event: BrokerEvent): string {
  const lines = [
    `Tool: ${providerLabel(event.provider)}`,
    `Item: ${event.artifact}`,
    `Stage: ${event.phase}`,
    `Failure: ${event.failure ?? "none"}`,
    `Bytes: ${event.bytes}${event.total !== null ? ` of ${event.total}` : ""}`,
  ];
  if (event.retry !== null) lines.push(`Attempt: ${event.retry}`);
  if (event.detail !== null) lines.push(`Message: ${event.detail}`);
  return lines.join("\n");
}

/** 0-100, or `null` when the size isn't known. */
export function percent(event: BrokerEvent): number | null {
  if (event.total === null || event.total <= 0) return null;
  return Math.min(100, Math.floor((event.bytes / event.total) * 100));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/** The provider as the tool the user typed. */
export function providerLabel(provider: BrokerProvider): string {
  switch (provider) {
    case "pypi":
      return "pip";
    case "npm":
      return "npm";
    case "go":
      return "Go";
    case "git":
      return "Git";
    case "composer":
      return "Composer";
    case "cargo":
      return "Cargo";
    case "yarn":
      return "Yarn";
    case "pnpm":
      return "pnpm";
    case "rustup":
      return "rustup";
    default:
      return "openmind-fetch";
  }
}

/** The network problem a failure is, for the network-failure card (`null`: nothing the network card can help with). */
export function failureProblem(kind: FailureKind): NetProblem | null {
  switch (kind) {
    case "dns":
      return "dns";
    case "connection":
      return "connectionFailed";
    case "timeout":
      return "timeout";
    case "tls":
    case "certificate":
      return "tls";
    case "proxyUnavailable":
      return "proxyUnavailable";
    case "proxyAuthentication":
      return "proxyAuthRequired";
    case "blocked":
      return "blocked";
    case "checksum":
    case "integrity":
      return "checksum";
    default:
      return null;
  }
}
