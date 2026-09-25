import type {
  ExtensionHostStatus,
  ExtensionNodeInfo,
  InstalledExtension,
} from "./extensionsIpc";

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
    return { text: "No code to run: this extension only contributes data.", ready: true };
  }
  if (host.state === "running") return { text: `Runs in ${host.node ?? "Node.js"}.`, ready: true };
  if (node.portable) return { text: "Runs in OpenMind's portable Node.js.", ready: true };
  if (node.system !== null && node.allowSystem) {
    return { text: `Runs in the System Node.js at ${node.system}.`, ready: true };
  }
  return { text: NODE_REQUIRED, ready: false };
}

/** Why an extension's commands can't run right now (`undefined`: they can). */
export function commandBlockedReason(
  extension: InstalledExtension,
  host: ExtensionHostStatus,
  node: ExtensionNodeInfo,
): string | undefined {
  if (!extension.enabled) return `${displayName(extension)} is disabled.`;
  if (extension.runtimeRequirement === null) return undefined;
  if (host.state === "running") return undefined;
  const runtime = runtimeStatus(extension, host, node);
  if (!runtime.ready) return NODE_REQUIRED;
  if (host.state === "crashed") return host.error ?? "The extension host stopped.";
  return undefined;
}

/** A human line for a manifest activation event (`onCommand:x` → "When the command x runs"). */
export function describeActivation(event: string): string {
  if (event === "*") return "At every start-up (may slow the app down)";
  if (event === "onStartupFinished") return "After the app has started";
  const [kind, ...rest] = event.split(":");
  const value = rest.join(":");
  switch (kind) {
    case "onCommand":
      return `When the command "${value}" runs`;
    case "onLanguage":
      return `When a ${value} file is opened`;
    case "workspaceContains":
      return `When the folder contains ${value}`;
    case "onView":
      return `When the view "${value}" opens (views aren't supported yet, so this never triggers)`;
    default:
      return `${event} (not supported yet, never triggers)`;
  }
}

/** The contribution points of an extension as the details list shows them. */
export function pointLines(extension: InstalledExtension): {
  point: string;
  count: number;
  status: string;
  note: string | null;
}[] {
  return extension.points.map((point) => ({
    point: point.point,
    count: point.count,
    status:
      point.support === "supported"
        ? "Supported"
        : point.support === "metadata"
          ? "Metadata only"
          : "Not supported",
    note: point.support === "unsupported" ? (point.note ?? NOT_SUPPORTED_POINT) : point.note,
  }));
}
