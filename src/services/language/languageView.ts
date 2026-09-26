import type { LspServerInfo } from "../ipc";
import type {
  CommandCategory,
  CommandStatus,
  Confidence,
  FormatOption,
  LspCandidate,
  ToolFound,
  ToolStatus,
} from "./languageIpc";

/** How a piece of status is shown: fine, needs attention, or simply not there. */
export type Tone = "ok" | "warn" | "off";

export interface StatusLine {
  label: string;
  tone: Tone;
  detail: string;
}

const SOURCE_LABELS: Record<ToolFound["source"], string> = {
  project: "the project's own copy",
  bundled: "an app-local tool bundled with OpenMind",
  portable: "an OpenMind portable runtime",
  system: "the system PATH",
  env: "an environment variable",
};

export function toolLine(tool: ToolStatus): StatusLine {
  if (tool.found === null)
    return { label: tool.name, tone: "off", detail: `Not found. ${tool.hint}` };
  return {
    label: tool.name,
    tone: "ok",
    detail: `Found in ${SOURCE_LABELS[tool.found.source]}: ${tool.found.path}`,
  };
}

/** A formatter or linter: found (and where) or missing (and what to do). */
export function formatOptionLine(option: FormatOption): StatusLine {
  if (option.found === null) {
    return { label: option.name, tone: "off", detail: `Not found. ${option.hint}` };
  }
  const scope = option.wholeProject ? "works on the whole project" : "works on this file";
  return {
    label: option.name,
    tone: "ok",
    detail: `Found in ${SOURCE_LABELS[option.found.source]}; ${scope}.`,
  };
}

/**
 * A language server candidate. One of OpenMind's own servers shows its live state from Language Tools; any other
 * candidate is only ever "found" or "not found", and always says plainly that OpenMind can't start it yet.
 */
export function lspLine(candidate: LspCandidate, servers: readonly LspServerInfo[]): StatusLine {
  if (candidate.builtin === null) {
    return {
      label: candidate.name,
      tone: candidate.found === null ? "off" : "warn",
      detail: candidate.note,
    };
  }
  const server = servers.find((entry) => entry.id === candidate.builtin);
  if (server === undefined) {
    return {
      label: candidate.name,
      tone: "off",
      detail: "LSP not configured: the language servers haven't loaded.",
    };
  }
  switch (server.state) {
    case "running":
      return { label: server.name, tone: "ok", detail: "Running." };
    case "starting":
    case "installing":
      return {
        label: server.name,
        tone: "warn",
        detail: server.state === "installing" ? "Installing…" : "Starting…",
      };
    case "error":
      return {
        label: server.name,
        tone: "warn",
        detail: server.message ?? "The server stopped with an error.",
      };
    case "stopped":
      return server.installed
        ? {
            label: server.name,
            tone: "ok",
            detail: "Installed; it starts when a file it handles is opened.",
          }
        : {
            label: server.name,
            tone: "off",
            detail:
              "LSP not configured: install it from Language Tools (Manage > Language Tools). Nothing is downloaded until you press Install.",
          };
  }
}

export const CATEGORY_ORDER: CommandCategory[] = [
  "dev",
  "run",
  "build",
  "test",
  "lint",
  "format",
  "install",
  "clean",
];

export const CATEGORY_LABELS: Record<CommandCategory, string> = {
  dev: "Dev",
  run: "Run",
  build: "Build",
  test: "Test",
  lint: "Lint",
  format: "Format",
  install: "Install",
  clean: "Clean",
};

/** The commands of a project grouped by what they do, in a fixed order. */
export function groupCommands(
  commands: readonly CommandStatus[],
): [CommandCategory, CommandStatus[]][] {
  return CATEGORY_ORDER.map((category): [CommandCategory, CommandStatus[]] => [
    category,
    commands.filter((command) => command.category === category),
  ]).filter(([, list]) => list.length > 0);
}

export const CONFIDENCE_LABELS: Record<Confidence, string> = {
  high: "Certain",
  medium: "Likely",
  low: "Possible",
};
