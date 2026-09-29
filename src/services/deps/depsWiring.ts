import { t } from "../../i18n";
import type { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import type { ConfirmPrompt } from "../extensionPromptService";
import { tauriLanguageIpc, type TerminalShellStyle } from "../language/languageIpc";
import { terminalPlainText } from "../network/networkWiring";
import type { OutputService } from "../outputService";
import { typeInNewTerminal } from "../terminalCommand";
import type { TerminalService } from "../terminalService";
import { DependencyService } from "./dependencyService";
import { tauriDepsIpc, type DepsIpc } from "./depsIpc";

/** Run Code's Output channels: a program's own errors land there. */
const RUN_CHANNELS = new Set(["Python", "Node.js", "PHP", "Run Code"]);

export interface DepsWiringDeps {
  events: EventBus<AppEvents>;
  output: Pick<OutputService, "onAppend">;
  terminal: Pick<TerminalService, "getState" | "subscribe" | "onOutput" | "createTerminal" | "write">;
  confirm: (request: Omit<ConfirmPrompt, "kind" | "id">) => Promise<string | null>;
  openFile: (path: string) => void;
  run: (command: string) => void;
  /** The file Run Code acts on (the project is found from it), or `null`. */
  activeFilePath: () => string | null;
  workspaceRoot: () => string | null;
  ipc?: DepsIpc;
  terminalLine?: (argv: string[], style: TerminalShellStyle) => Promise<string>;
}

/**
 * The dependency helper's wiring: Run Code's Output and every terminal are watched for "missing" errors (module,
 * package, command, header), line by line; the card's installs are typed into a new terminal after confirmation.
 */
export function wireDeps(deps: DepsWiringDeps): DependencyService {
  const quote = deps.terminalLine ?? ((argv, style) => tauriLanguageIpc.languageTerminalLine(argv, style));
  const service = new DependencyService({
    ipc: deps.ipc ?? tauriDepsIpc,
    events: deps.events,
    confirm: deps.confirm,
    runInTerminal: (argv, cwd) =>
      typeInNewTerminal(deps.terminal, quote, argv, cwd, {
        noShell: t("network.wheels.noShell"),
        failed: t("network.stale.failed"),
      }),
    openFile: deps.openFile,
    openRuntimeManager: () => {
      deps.run("workloads.open");
    },
    runActiveInTerminal: () => {
      deps.run("run.codeInTerminal");
    },
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
          folder = promptFolder(line) ?? folder;
          if (line.trim() !== "") service.report(line, folder ?? session.cwd, t("network.failure.sourceTerminal"));
        }
      });
    }
  });
  return service;
}

/**
 * The current folder a shell prompt shows: PowerShell `PS C:\dir> ...`, cmd `C:\dir>...` (no space after `>`);
 * otherwise `null`. A line must start with a drive path, so program output such as `a > b` never counts.
 */
export function promptFolder(line: string): string | null {
  const match = /^(?:PS )?([A-Za-z]:\\[^<>|"?*\r\n]*?)>/.exec(line.trimStart());
  return match?.[1] ?? null;
}
