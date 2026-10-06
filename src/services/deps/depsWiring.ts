import { t } from "../../i18n";
import type { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import type { ConfirmPrompt } from "../extensionPromptService";
import { terminalPlainText } from "../network/networkWiring";
import type { OutputService } from "../outputService";
import type { TerminalService } from "../terminalService";
import { DependencyActions } from "./dependencyActions";
import { DependencyService, type PythonGuiHost } from "./dependencyService";
import { tauriDepsIpc, type DepsIpc } from "./depsIpc";

/** Run Code's Output channels: a program's own errors land there. */
const RUN_CHANNELS = new Set(["Python", "Node.js", "PHP", "C", "C++", "Java", "Rust", "Assembly", "Run Code"]);

export interface DepsWiringDeps {
  events: EventBus<AppEvents>;
  output: Pick<OutputService, "onAppend">;
  terminal: Pick<TerminalService, "getState" | "subscribe" | "onOutput" | "createTaskTerminal" | "waitForExit">;
  confirm: (request: Omit<ConfirmPrompt, "kind" | "id">) => Promise<string | null>;
  openFile: (path: string) => void;
  run: (command: string) => void;
  /** The file Run Code acts on (the project is found from it), or `null`. */
  activeFilePath: () => string | null;
  workspaceRoot: () => string | null;
  ipc?: DepsIpc;
  /** Tcl/Tk for OpenMind's portable Python (see `PythonGuiHost`). */
  pythonGui?: PythonGuiHost;
}

export interface DepsWiring {
  /** The missing-package card. */
  helper: DependencyService;
  /** The one runner for package operations (the card and the Dependencies view). */
  actions: DependencyActions;
  /** Called after any operation ended (to read the project again). */
  onChanged: (listener: () => void) => () => void;
}

/**
 * The dependency helper's wiring: Run Code's Output and every terminal are watched for "missing" errors (module,
 * package, command, header), line by line; installs go through `DependencyActions` (plan, confirmation, the program in a
 * new terminal, its real exit code) — the same runner the Dependencies view uses.
 */
export function wireDeps(deps: DepsWiringDeps): DepsWiring {
  const ipc = deps.ipc ?? tauriDepsIpc;
  const changed = new Set<() => void>();
  const actions = new DependencyActions({
    ipc,
    confirm: deps.confirm,
    terminals: deps.terminal,
    notice: (message) => {
      deps.events.emit("appNotice", { message });
    },
    error: (message) => {
      deps.events.emit("appError", { message });
    },
    changed: () => {
      for (const listener of [...changed]) listener();
    },
  });
  const service = new DependencyService({
    ipc,
    events: deps.events,
    confirm: deps.confirm,
    actions,
    openFile: deps.openFile,
    openRuntimeManager: () => {
      deps.run("workloads.open");
    },
    runActiveInTerminal: () => {
      deps.run("run.codeInTerminal");
    },
    pythonGui: deps.pythonGui,
  });

  deps.output.onAppend((channel, line) => {
    if (!RUN_CHANNELS.has(channel)) return;
    service.report(line, deps.activeFilePath() ?? deps.workspaceRoot(), channel, true);
  });

  // Terminal output arrives in chunks that can split a line: complete lines are looked at, the rest is kept. The
  // shell's current folder is followed through its prompt (the user may have `cd`'d since the terminal started), so
  // an install runs in the folder the failed command ran in.
  const watched = new Set<string>();
  deps.terminal.subscribe(() => {
    for (const session of deps.terminal.getState().sessions) {
      if (watched.has(session.id)) continue;
      watched.add(session.id);
      const decoder = new TextDecoder();
      let pending = "";
      let folder: string | null = null;
      deps.terminal.onOutput(session.id, (data) => {
        pending += terminalPlainText(decoder.decode(data, { stream: true }));
        const lines = pending.split(/\r?\n|\r/);
        pending = (lines.pop() ?? "").slice(-2000);
        for (const line of lines) {
          const prompt = readPrompt(line);
          // A prompt whose folder isn't a Windows path (`~`, `/home/me` in WSL) resets to the terminal's own folder.
          if (prompt !== null) folder = prompt.folder;
          if (line.trim() !== "") service.report(line, folder ?? session.cwd, t("network.failure.sourceTerminal"));
        }
      });
    }
  });
  return {
    helper: service,
    actions,
    onChanged: (listener) => {
      changed.add(listener);
      return () => {
        changed.delete(listener);
      };
    },
  };
}

/**
 * The current folder a shell prompt shows: PowerShell `PS C:\dir> ...`, cmd `C:\dir>...` (no space after `>`);
 * otherwise `null`. A line must start with a drive path, so program output such as `a > b` never counts.
 */
export function promptFolder(line: string): string | null {
  const match = /^(?:PS )?([A-Za-z]:\\[^<>|"?*\r\n]*?)>/.exec(line.trimStart());
  return match?.[1] ?? null;
}

/**
 * A shell prompt line and the Windows folder it shows (`folder: null` when the prompt's folder isn't on a Windows
 * drive), or `null` when the line isn't a prompt. Besides PowerShell and cmd: Git Bash's default prompt line
 * `user@host MINGW64 /e/My Work (main)` and WSL's `user@host:/mnt/e/My Work$ ...`. Only the prompt text is read —
 * nothing is typed into the shell to ask.
 */
export function readPrompt(line: string): { folder: string | null } | null {
  const windows = promptFolder(line);
  if (windows !== null) return { folder: windows };
  const text = line.trimEnd();
  const gitBash = /^[\w.-]+@[\w.-]+ (?:MINGW64|MINGW32|MSYS|UCRT64|CLANG64|CLANGARM64) (\/.*?|~.*?)(?: \([^()]*\))?$/.exec(text)?.[1];
  if (gitBash !== undefined) return { folder: windowsPath(gitBash, /^\/([A-Za-z])(\/.*)?$/) };
  const wsl = /^[\w.-]+@[\w.-]+:(\/[^$#]*|~[^$#]*)[$#](?:\s|$)/.exec(text)?.[1];
  if (wsl !== undefined) return { folder: windowsPath(wsl, /^\/mnt\/([A-Za-z])(\/.*)?$/) };
  return null;
}

/** `/e/My Work` (Git Bash) or `/mnt/e/My Work` (WSL) -> `E:\My Work`; anything else (`~`, `/home/me`) -> `null`. */
function windowsPath(path: string, drive: RegExp): string | null {
  const match = drive.exec(path.trim());
  const letter = match?.[1];
  if (match === null || letter === undefined) return null;
  const rest = (match[2] ?? "").replace(/\/+$/, "").replace(/\//g, "\\");
  return `${letter.toUpperCase()}:\\${rest.replace(/^\\/, "")}`;
}
