import type { CommandRegistry } from "./commandRegistry";
import type { DocumentService } from "./documentService";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { ConfirmPrompt, InputPrompt } from "./extensionPromptService";
import type { IpcClient } from "./ipc";
import type { MarkerService } from "./markerService";
import type { OutputService } from "./outputService";
import type { PanelService } from "./panelService";
import { RunArgumentsService } from "./runArgumentsService";
import { RunCodeService } from "./runCodeService";
import { registerRunCommands } from "./runCommands";
import { RunConfigurationService } from "./runConfigurationService";
import type { SettingsService } from "./settingsService";
import type { TerminalService } from "./terminalService";
import type { WorkspaceService } from "./workspaceService";
import { t } from "../i18n";

export interface RunWiringDeps {
  ipc: IpcClient;
  events: EventBus<AppEvents>;
  commands: CommandRegistry;
  output: OutputService;
  workspace: WorkspaceService;
  documents: DocumentService;
  terminal: TerminalService;
  panel: PanelService;
  settings: SettingsService;
  markers: MarkerService;
  /** Shows a run's Output channel beside the editor (the secondary side bar). */
  showBeside: (channel: string) => void;
  /** The app's shared prompts (they exist once the extension services do; asked only when a user runs something). */
  confirm: (request: Omit<ConfirmPrompt, "kind" | "id">) => Promise<string | null>;
  inputBox: (request: Omit<InputPrompt, "kind" | "id">) => Promise<string | null>;
}

/** Run Code: the header's ▶, its run configurations and per-file arguments, the Run menu's commands. */
export function wireRunCode(deps: RunWiringDeps) {
  const { ipc, events, settings, documents } = deps;
  const configs = new RunConfigurationService(ipc);
  const runCode = new RunCodeService(
    ipc,
    events,
    deps.output,
    deps.workspace,
    configs,
    deps.terminal,
    deps.panel,
    deps.showBeside,
    {
      saveBeforeRun: () => settings.bool("run.saveBeforeRun", true),
      clearOutputBeforeRun: () => settings.bool("run.clearOutputBeforeRun", true),
    },
    deps.markers,
  );
  // Command-line arguments per file, remembered across restarts; every run of that file (Output or terminal) gets them.
  const runArguments = new RunArgumentsService(ipc);
  runCode.setArgumentsSource((path) => runArguments.get(path));
  runArguments.subscribe(() => {
    void runCode.refresh();
  });
  registerRunCommands({
    commands: deps.commands,
    events,
    runCode,
    configs,
    arguments: {
      store: runArguments,
      ask: (file, current) =>
        deps.inputBox({
          extension: t("run.interactive.source"),
          title: t("run.arguments.title"),
          prompt: t("run.arguments.prompt", { file: file.split(/[/\\]/).pop() ?? file }),
          placeHolder: t("run.arguments.placeholder"),
          value: current,
          password: false,
        }),
    },
  });
  // Run Code's Output can't type into a program: a file that reads the keyboard is offered the terminal.
  runCode.setInteractiveHost({
    text: (docId) => {
      try {
        return documents.contentOf(docId);
      } catch {
        return null;
      }
    },
    choose: async (file) => {
      const terminalLabel = t("run.interactive.terminal");
      const answer = await deps.confirm({
        extension: t("run.interactive.source"),
        title: t("run.interactive.title"),
        details: [{ label: t("run.interactive.file"), value: file }],
        notes: [t("run.interactive.note")],
        buttons: [terminalLabel, t("run.interactive.anyway")],
      });
      if (answer === null) return null;
      return answer === terminalLabel ? "terminal" : "output";
    },
  });
  return { runCode, configs, runArguments };
}
