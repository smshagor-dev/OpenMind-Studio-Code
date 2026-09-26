import type { CommandRegistry } from "../commandRegistry";
import type { DocumentService } from "../documentService";
import type { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import type { TerminalService } from "../terminalService";
import type { WorkspaceService } from "../workspaceService";
import type { FormatOption, LanguageIpc } from "./languageIpc";
import { LanguageSupportService } from "./languageSupportService";
import { ProjectCommandService } from "./projectCommandService";

export interface LanguageWiringDeps {
  ipc: LanguageIpc;
  events: EventBus<AppEvents>;
  commands: CommandRegistry;
  workspace: Pick<WorkspaceService, "getState" | "docPath" | "getActiveWorkspace">;
  documents: Pick<DocumentService, "save">;
  terminal: Pick<TerminalService, "createTerminal" | "write" | "setActive" | "getState">;
  showTerminal: () => Promise<void>;
}

/** Whether the Language / Project Status window is open. Transient UI state. */
export class LanguageUiService {
  private open = false;
  private readonly listeners = new Set<() => void>();

  isOpen(): boolean {
    return this.open;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setOpen(open: boolean): void {
    this.open = open;
    for (const listener of this.listeners) listener();
  }
}

type ToolKind = "format" | "lint";

function normalized(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

/** Whether `path` is inside `root` (a whole-folder prefix, case-insensitive like Windows paths). */
function isInside(root: string, path: string): boolean {
  const base = normalized(root).replace(/\/+$/, "");
  return normalized(path).startsWith(`${base}/`);
}

/**
 * Builds the language services and the commands around them: the status window, "Format Document With Tool" and
 * "Run Linter" (which run a formatter or linter that was actually found, in the terminal, on the saved file), and a
 * rescan. Called once by the composition root.
 */
export function wireLanguage(deps: LanguageWiringDeps) {
  const { ipc, events, commands, workspace, documents } = deps;
  const rootOf = () => workspace.getActiveWorkspace()?.path ?? null;
  const support = new LanguageSupportService(ipc, events, () => rootOf() !== null);
  const projects = new ProjectCommandService({
    ipc,
    events,
    terminal: deps.terminal,
    showTerminal: deps.showTerminal,
    workspaceRoot: rootOf,
  });
  const ui = new LanguageUiService();

  const activeText = () => {
    const state = workspace.getState();
    const group = state.groups.find((g) => g.id === state.activeGroupId);
    const tab = group?.tabs.find((t) => t.id === group.activeTabId);
    if (tab?.kind !== "text") return null;
    const path = workspace.docPath(tab.docId);
    return { docId: tab.docId, dirty: tab.dirty, path };
  };

  /** Why "Format with tool" / "Run linter" can't be used right now, without looking anything up. */
  const reasonFor = (kind: ToolKind): string | null => {
    const root = rootOf();
    if (root === null) return "Open a folder first.";
    const active = activeText();
    if (active === null) return "Open a text file first (a preview can't be formatted).";
    if (active.path === null) return "Save the file first: a tool works on a file on disk.";
    if (!isInside(root, active.path)) return "This file is outside the open folder.";
    const language = support.languageOf(active.path);
    if (language === null) return "OpenMind doesn't know this file's language.";
    const known = kind === "format" ? language.formatters : language.linters;
    return known.length === 0
      ? `No ${kind === "format" ? "formatter" : "linter"} is known for ${language.name}.`
      : null;
  };

  const runTool = async (kind: ToolKind): Promise<void> => {
    const reason = reasonFor(kind);
    const active = activeText();
    if (reason !== null || active?.path == null) {
      events.emit("appNotice", { message: reason ?? "Open a saved text file first." });
      return;
    }
    // A tool works on the file on disk: save the editor's text first (the user asked for this).
    if (active.dirty) await documents.save(active.docId);
    const file = await support.lookUpFile(active.path);
    if (file === null) return;
    const options: FormatOption[] = kind === "format" ? file.formatters : file.linters;
    const found = options.find((option) => option.found !== null);
    if (found === undefined) {
      const language = file.language?.name ?? "this file";
      const advice = options.slice(0, 3).map((option) => `${option.name}: ${option.hint}`);
      events.emit("appNotice", {
        message: `No ${kind === "format" ? "formatter" : "linter"} found for ${language} (looked in the project, OpenMind's runtimes and PATH). ${advice.join(" ")}`,
      });
      return;
    }
    await projects.runTool(found, file.projectRoot ?? "");
  };

  commands.register("language.showStatus", async () => {
    ui.setOpen(true);
    await support.refresh();
    const active = activeText();
    if (active?.path != null) await support.lookUpFile(active.path);
  });
  commands.register("language.refresh", () => support.refresh(), {
    enabled: () => rootOf() !== null,
    disabledReason: () => (rootOf() === null ? "Open a folder first." : undefined),
  });
  for (const [id, kind] of [
    ["language.formatWithTool", "format"],
    ["language.runLinter", "lint"],
  ] as const) {
    commands.register(id, () => runTool(kind), {
      enabled: () => reasonFor(kind) === null,
      disabledReason: () => reasonFor(kind) ?? undefined,
    });
  }
  // Run > Project Run / Build / Test Commands: the same click-to-run path as the status window's buttons.
  commands.register("language.runProjectCommand", async (projectRoot, commandId) => {
    const project = support
      .getState()
      .workspace?.projects.find((candidate) => candidate.root === projectRoot);
    const command = project?.commandStatus.find((candidate) => candidate.id === commandId);
    if (command === undefined) {
      events.emit("appNotice", { message: "That project command is no longer available." });
      return;
    }
    await projects.runCommand(command);
  });
  return { support, projects, ui, reasonFor, activeText };
}
