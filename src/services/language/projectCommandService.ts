import type { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import { shellStyleFor } from "../runCodeService";
import type { TerminalService } from "../terminalService";
import type { CommandStatus, FormatOption, LanguageIpc } from "./languageIpc";

export interface Availability {
  enabled: boolean;
  reason: string | null;
}

export interface ProjectCommandDeps {
  ipc: LanguageIpc;
  events: EventBus<AppEvents>;
  terminal: Pick<TerminalService, "createTerminal" | "write" | "setActive" | "getState">;
  showTerminal: () => Promise<void>;
  workspaceRoot: () => string | null;
}

function joinPath(root: string, relative: string): string {
  const base = root.replace(/[\\/]+$/, "");
  return relative === "" ? base : `${base}/${relative}`;
}

/**
 * Puts a project's command into the integrated terminal — only when the user clicks it. The command is an argument
 * list from the backend; this asks the backend to render it for the terminal's shell, opens a new terminal in the
 * project's folder (so the folder is right and the portable runtimes are first on that terminal's PATH, like every
 * terminal), types the line and shows the panel. A command that can't run says why instead of being offered.
 */
export class ProjectCommandService {
  constructor(private readonly deps: ProjectCommandDeps) {}

  availability(command: CommandStatus): Availability {
    if (command.available) return { enabled: true, reason: null };
    return { enabled: false, reason: command.reason ?? "This command isn't available." };
  }

  /** The tooltip of a command: what it is, where it runs and that it downloads. */
  describe(command: CommandStatus): string {
    const parts = [command.argv.join(" ")];
    if (command.cwd !== "") parts.push(`in ${command.cwd}`);
    if (command.network) parts.push("may download packages");
    if (command.note !== null) parts.push(command.note);
    return parts.join(" — ");
  }

  async runCommand(command: CommandStatus): Promise<boolean> {
    const state = this.availability(command);
    if (!state.enabled) {
      this.deps.events.emit("appNotice", { message: state.reason ?? "This command can't run." });
      return false;
    }
    return this.typeIntoTerminal(command.argv, command.cwd, command.label);
  }

  /** Runs a formatter or linter that was found (its resolved path is the first word). */
  async runTool(option: FormatOption, cwd: string): Promise<boolean> {
    if (option.found === null || option.argv.length === 0) {
      this.deps.events.emit("appNotice", {
        message: `${option.name} was not found. ${option.hint}`,
      });
      return false;
    }
    return this.typeIntoTerminal(option.argv, cwd, option.name);
  }

  private async typeIntoTerminal(argv: string[], cwd: string, label: string): Promise<boolean> {
    const root = this.deps.workspaceRoot();
    if (root === null) {
      this.deps.events.emit("appNotice", { message: "Open a folder first." });
      return false;
    }
    const id = await this.deps.terminal.createTerminal(undefined, joinPath(root, cwd));
    if (id === null) return false;
    const session = this.deps.terminal.getState().sessions.find((s) => s.id === id);
    const style = session === undefined ? null : shellStyleFor(session.shell);
    if (style === null) {
      this.deps.events.emit("appNotice", {
        message: `"${label}" can't be typed into a WSL terminal. Open a PowerShell, cmd or Git Bash terminal.`,
      });
      return false;
    }
    try {
      const line = await this.deps.ipc.languageTerminalLine(argv, style);
      // The terminal echoes exactly what is typed, so the command is visible there.
      this.deps.terminal.write(id, `${line}\r`);
      this.deps.terminal.setActive(id);
      await this.deps.showTerminal();
      return true;
    } catch (error) {
      this.deps.events.emit("appError", { message: `Couldn't run "${label}": ${String(error)}` });
      return false;
    }
  }
}
