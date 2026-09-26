import type { ToolCategory, ToolEntry, ToolVersion } from "./toolchainIpc";

// Pure helpers that turn the backend's tool list into what the Tools page draws.

export type Tone = "ok" | "warn" | "error" | "info" | "off";

export interface Chip {
  label: string;
  tone: Tone;
}

export interface Section {
  id: string;
  title: string;
  tools: ToolEntry[];
}

const SECTION_ORDER: { id: string; title: string; categories: ToolCategory[] }[] = [
  { id: "runtimes", title: "Runtimes", categories: ["runtime"] },
  { id: "package-managers", title: "Package Managers", categories: ["packageManager"] },
  { id: "language-servers", title: "Language Servers", categories: ["languageServer"] },
  { id: "formatters", title: "Formatters", categories: ["formatter"] },
  { id: "linters", title: "Linters", categories: ["linter"] },
  { id: "debuggers", title: "Debuggers", categories: ["debugger"] },
  { id: "vcs", title: "Version Control", categories: ["vcs"] },
  { id: "helpers", title: "Helper Tools", categories: ["databaseTool", "helperTool"] },
  { id: "sdks", title: "Mobile/Desktop SDKs", categories: ["sdk"] },
];

/**
 * Groups tools into the page's sections. A tool that is external (a big SDK or runtime the user installs) goes to
 * "Mobile/Desktop SDKs" when it is one, and otherwise to "External Required"; empty sections are dropped.
 */
export function sectionsOf(tools: ToolEntry[]): Section[] {
  const external = tools.filter((tool) => tool.status === "external" && tool.category !== "sdk");
  const sections: Section[] = SECTION_ORDER.map((section) => ({
    id: section.id,
    title: section.title,
    tools: tools.filter(
      (tool) =>
        section.categories.includes(tool.category) &&
        (tool.category === "sdk" || tool.status !== "external"),
    ),
  }));
  sections.push({ id: "external", title: "External Required", tools: external });
  return sections.filter((section) => section.tools.length > 0);
}

export function statusChip(tool: ToolEntry): Chip {
  switch (tool.status) {
    case "active":
      return { label: "Active", tone: "ok" };
    case "broken":
      return { label: "Broken", tone: "error" };
    case "external":
      return { label: "External", tone: "info" };
    case "missing":
      return { label: "Missing", tone: "warn" };
  }
}

export function versionChip(version: ToolVersion): Chip {
  switch (version.status) {
    case "active":
      return { label: "Active", tone: "ok" };
    case "broken":
      return { label: "Broken", tone: "error" };
    case "bundled":
      return { label: "Bundled", tone: "info" };
  }
}

/** "3 of up to 5 versions" — the honest count, never rounded up to the cap. */
export function versionCount(tool: ToolEntry): string {
  const usable = tool.versions.filter((version) => version.status !== "broken").length;
  if (tool.versions.length === 0) return "No versions bundled";
  const noun = usable === 1 ? "version" : "versions";
  return `${String(usable)} ${noun} available (up to ${String(tool.maxVersions)} kept)`;
}

/** Shortens a long path in the middle so both the start and the file name stay visible. */
export function shortPath(path: string, max = 46): string {
  const clean = path.replace(/\\/g, "/");
  if (clean.length <= max) return clean;
  const keepEnd = Math.ceil((max - 1) * 0.6);
  const keepStart = max - 1 - keepEnd;
  return `${clean.slice(0, keepStart)}…${clean.slice(clean.length - keepEnd)}`;
}

export function formatSize(bytes: number | null): string | null {
  if (bytes === null) return null;
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit] ?? "GB"}`;
}

/** What a tool card says when nothing is bundled: the setup hint, or that the tool is external. */
export function missingLine(tool: ToolEntry): string | null {
  if (tool.status === "active") return null;
  if (tool.status === "broken") {
    return "A listed version is missing from tools/. Copy it back or update tools/toolchains.json.";
  }
  return tool.hint;
}

/** The tools whose bundled version the project status shows: Git, Composer and the Python debugger. */
export const STATUS_TOOL_IDS = ["git", "composer", "debugpy"] as const;

export interface BundledLine {
  label: string;
  tone: "ok" | "warn" | "off";
  detail: string;
}

/** One honest line per status tool: the active bundled version, or that nothing is bundled and what to do. */
export function bundledLines(tools: ToolEntry[]): BundledLine[] {
  return STATUS_TOOL_IDS.flatMap((id): BundledLine[] => {
    const tool = tools.find((entry) => entry.id === id);
    if (!tool) return [];
    if (tool.status === "active" && tool.activeVersion) {
      return [
        {
          label: tool.name,
          tone: "ok",
          detail: `Active ${tool.activeVersion} — bundled with OpenMind Studio · ${versionCount(tool)}.`,
        },
      ];
    }
    if (tool.status === "broken") {
      return [
        {
          label: tool.name,
          tone: "warn",
          detail: "A bundled version is listed but its program is missing from tools/.",
        },
      ];
    }
    const detail =
      id === "debugpy"
        ? "No debugger bundled. Python debugging uses the debugger from the Runtime Manager, and says so when it is missing."
        : `Nothing bundled. ${tool.hint}`;
    return [{ label: tool.name, tone: "off", detail }];
  });
}
