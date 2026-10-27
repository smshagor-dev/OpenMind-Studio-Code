import type {
  ExtensionHostStatus,
  ExtensionNodeInfo,
  InstalledExtension,
  PermissionName,
} from "./extensionsIpc";
import { t } from "../i18n";

/** Shown before any `.vsix` is installed: extension code runs with the user's permissions. */
export const TRUST_WARNING =
  "Extensions can run code on your computer. Install only from trusted sources.";

export const NODE_REQUIRED = "Node.js runtime is required for extension host.";

export const MARKETPLACE_UNAVAILABLE = "Online extension marketplace is not available yet.";

export const API_SUBSET_NOTE =
  "OpenMind Studio supports a VS Code API subset. Anything outside it fails with a clear message.";

export const NOT_SUPPORTED_POINT = "This contribution point is not supported yet.";

/** The name shown for an extension. */
export function displayName(extension: InstalledExtension): string {
  return extension.manifest.displayName ?? extension.manifest.name;
}

/** Installed extensions whose name, id, publisher or description contains every word of `query`. */
export function filterExtensions(
  extensions: readonly InstalledExtension[],
  query: string,
): InstalledExtension[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...extensions];
  return extensions.filter((extension) => {
    const haystack = [
      displayName(extension),
      extension.id,
      extension.manifest.publisher,
      extension.manifest.description ?? "",
    ]
      .join(" ")
      .toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/** What running an extension's code needs, and whether that is there right now. */
export function runtimeStatus(
  extension: InstalledExtension,
  host: ExtensionHostStatus,
  node: ExtensionNodeInfo,
): { text: string; ready: boolean } {
  if (extension.runtimeRequirement === null) {
    return { text: t("extensions.runtime.noCode"), ready: true };
  }
  if (host.state === "running")
    return { text: t("extensions.runtime.runsIn", { node: host.node ?? "Node.js" }), ready: true };
  if (node.portable) return { text: t("extensions.runtime.portable"), ready: true };
  if (node.system !== null && node.allowSystem) {
    return { text: t("extensions.runtime.system", { path: node.system }), ready: true };
  }
  return { text: t("extensions.nodeRequired"), ready: false };
}

/** Why an extension's commands can't run right now (`undefined`: they can). */
export function commandBlockedReason(
  extension: InstalledExtension,
  host: ExtensionHostStatus,
  node: ExtensionNodeInfo,
): string | undefined {
  if (!extension.enabled) return t("extensions.isDisabled", { name: displayName(extension) });
  if (extension.runtimeRequirement === null) return undefined;
  if (host.state === "running") return undefined;
  const runtime = runtimeStatus(extension, host, node);
  if (!runtime.ready) return t("extensions.nodeRequired");
  if (host.state === "crashed") return host.error ?? t("extensions.hostStopped");
  return undefined;
}

/** A human line for a manifest activation event (`onCommand:x` → "When the command x runs"). */
export function describeActivation(event: string): string {
  if (event === "*") return t("activation.everyStartup");
  if (event === "onStartupFinished") return t("activation.afterStartup");
  const [kind, ...rest] = event.split(":");
  const value = rest.join(":");
  switch (kind) {
    case "onCommand":
      return t("activation.command", { value });
    case "onLanguage":
      return t("activation.language", { value });
    case "workspaceContains":
      return t("activation.contains", { value });
    case "onView":
      return t("activation.view", { value });
    default:
      return t("activation.unsupported", { event });
  }
}

/** The contribution points of an extension as the details list shows them. */
export function pointLines(extension: InstalledExtension): {
  point: string;
  count: number;
  support: string;
  status: string;
  note: string | null;
}[] {
  return extension.points.map((point) => ({
    point: point.point,
    count: point.count,
    support: point.support,
    status:
      point.support === "supported"
        ? t("extensions.point.supported")
        : point.support === "metadata"
          ? t("extensions.point.metadata")
          : t("extensions.point.unsupported"),
    note:
      point.support === "unsupported"
        ? (point.note ?? t("extensions.pointUnsupported"))
        : point.point === "languages"
          ? t("extensions.languagesRestart")
          : point.note,
  }));
}

// ---- permissions -------------------------------------------------------------------------------------------------

export const PERMISSION_INFO: Record<PermissionName, { label: string; description: string }> = {
  workspaceRead: { label: "Read the open folder", description: "Read files and open documents of the open folder." },
  workspaceWrite: { label: "Change the open folder", description: "Create, change or delete files in the open folder." },
  commands: { label: "Commands", description: "Register and run commands." },
  settings: { label: "Settings", description: "Read settings and hear about changes." },
  languages: { label: "Language features", description: "Add completion, hover, definitions and problems." },
  themes: { label: "Colour themes", description: "Offer colour themes." },
  snippets: { label: "Snippets", description: "Offer snippets." },
  network: { label: "Network", description: "Use the network (HTTP, sockets, fetch, open links)." },
  processExecution: { label: "Run programs", description: "Start other programs on this computer." },
  terminal: { label: "Terminal", description: "Control terminals." },
  filesystemOutsideWorkspace: {
    label: "Files outside the open folder",
    description: "Read or change any file on this computer.",
  },
};

export interface PermissionLine {
  name: PermissionName;
  label: string;
  description: string;
  /** Asked for by the extension, implied by what it contributes, or both. */
  origin: "requested" | "inferred" | "both";
  highRisk: boolean;
  accepted: boolean;
}

/** Every permission an extension asks for or implies, requested ones first. */
export function permissionLines(extension: InstalledExtension): PermissionLine[] {
  const { requested, inferred, accepted, highRisk } = extension.permissions;
  const names = [...new Set([...requested, ...inferred, ...accepted])];
  return names
    .map((name): PermissionLine => ({
      name,
      label: t(`permission.${name}.label`),
      description: t(`permission.${name}.description`),
      origin: requested.includes(name) ? (inferred.includes(name) ? "both" : "requested") : "inferred",
      highRisk: highRisk.includes(name),
      accepted: accepted.includes(name),
    }))
    .sort((a, b) => Number(b.highRisk) - Number(a.highRisk) || a.label.localeCompare(b.label));
}

/** The one permission a user can add by hand to an extension that doesn't ask for it. */
export const OUTSIDE_WORKSPACE: PermissionName = "filesystemOutsideWorkspace";

export const OUTSIDE_WORKSPACE_WARNING =
  "This allows the extension to access files outside your open workspace. Grant only for extensions you trust.";

/** Whether the "Grant access to files outside the workspace" action applies to this extension. */
export function canGrantOutsideWorkspace(extension: InstalledExtension): boolean {
  return !extension.permissions.accepted.includes(OUTSIDE_WORKSPACE);
}

/**
 * The permission the guard refused an extension (its last error is the host's "Permission '<name>' is required for
 * this extension API."), if the user hasn't granted it since; null otherwise.
 */
export function refusedPermission(extension: InstalledExtension, lastError: string | null): PermissionName | null {
  const name = lastError?.match(/Permission '([A-Za-z]+)' is required/)?.[1];
  if (name === undefined || !(name in PERMISSION_INFO)) return null;
  const permission = name as PermissionName;
  return extension.permissions.accepted.includes(permission) ? null : permission;
}

/** Set when an extension's last error was the guard refusing it files outside the open folder. */
export function outsideWorkspaceBlock(lastError: string | null): string | null {
  return lastError !== null && lastError.includes(`Permission '${OUTSIDE_WORKSPACE}'`)
    ? t("extensions.outsideBlocked")
    : null;
}

export const PERMISSION_LIMITS_NOTE =
  "Permissions guard the extension host's APIs and Node modules (child_process, network, fs paths). They are not a sandbox: extension code runs as you.";

/** The words for a host state. */
export function hostStateText(host: ExtensionHostStatus): string {
  switch (host.state) {
    case "running":
      return host.node ? t("extensions.host.runningOn", { node: host.node }) : t("extensions.host.running");
    case "starting":
      return t("extensions.host.starting");
    case "restarting":
      return t("extensions.host.restarting");
    case "crashed":
      return host.error
        ? t("extensions.host.crashedWith", { error: host.error })
        : t("extensions.host.crashed");
    case "unavailable":
      return host.error ?? t("extensions.nodeRequired");
    default:
      return t("extensions.host.notRunning");
  }
}
