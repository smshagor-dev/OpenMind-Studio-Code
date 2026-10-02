import type { CommandRegistry } from "./commandRegistry";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import { extensionOf } from "./editorAssociationService";
import type { RunConfigurationService } from "./runConfigurationService";
import type { RunArgumentsService } from "./runArgumentsService";
import type { RunCodeService } from "./runCodeService";

export interface RunCommandDeps {
  commands: CommandRegistry;
  events: EventBus<AppEvents>;
  runCode: RunCodeService;
  configs: RunConfigurationService;
  /** The remembered command-line arguments, and how to ask for new ones (`null` = the user cancelled). */
  arguments?: {
    store: RunArgumentsService;
    ask: (file: string, current: string) => Promise<string | null>;
  };
}

/**
 * Run Code's commands. `debug.runWithoutDebugging` (the Run menu's "Run
 * Without Debugging") is the same action, so that entry is live too; the
 * debugger's own commands stay unregistered and their entries disabled.
 */
export function registerRunCommands(deps: RunCommandDeps): void {
  const { commands, events, runCode, configs } = deps;
  const canRun = () => runCode.canRun();

  commands.register(
    "run.code",
    async () => {
      await runCode.run();
    },
    { enabled: canRun },
  );
  commands.register(
    "debug.runWithoutDebugging",
    async () => {
      await runCode.run();
    },
    { enabled: canRun },
  );
  commands.register(
    "run.codeInTerminal",
    async () => {
      await runCode.run({ target: "terminal" });
    },
    {
      enabled: canRun,
    },
  );
  commands.register(
    "run.codeShowOutput",
    async () => {
      await runCode.run({ target: "output", showOutput: true });
    },
    { enabled: canRun },
  );
  commands.register(
    "run.stop",
    async () => {
      await runCode.stop();
    },
    { enabled: () => runCode.canStop() },
  );
  commands.register(
    "run.configure",
    () => {
      events.emit("showRunConfiguration", undefined);
    },
    {
      enabled: () => configs.supports(extensionOf(runCode.activeEditor()?.path ?? null)),
    },
  );
  const args = deps.arguments;
  if (args) {
    // Asks for the program's arguments (the remembered ones filled in), remembers them for this file and runs it.
    commands.register(
      "run.codeWithArguments",
      async () => {
        const file = runCode.activeEditor()?.path;
        if (file == null) return;
        const answer = await args.ask(file, args.store.get(file));
        if (answer === null) return;
        await args.store.set(file, answer);
        await runCode.refresh();
        await runCode.run();
      },
      // Also when the file's saved arguments are what make Run refuse: this is where they are fixed.
      { enabled: () => canRun() || (!runCode.canStop() && hasArguments(runCode, args.store)) },
    );
  }
  // Which runtime a run uses is chosen where runtimes are managed: the active version there wins.
  commands.register("run.selectRuntime", () => {
    events.emit("showRuntimeManager", undefined);
  });
}

/** Whether the active file has remembered arguments (they can be edited even while they make Run refuse). */
export function hasArguments(
  runCode: { activeEditor: () => { path: string | null } | null },
  store: Pick<RunArgumentsService, "get">,
): boolean {
  const path = runCode.activeEditor()?.path;
  return path != null && store.get(path) !== "";
}
