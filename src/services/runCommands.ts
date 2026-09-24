import type { CommandRegistry } from "./commandRegistry";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import { extensionOf } from "./editorAssociationService";
import type { RunConfigurationService } from "./runConfigurationService";
import type { RunCodeService } from "./runCodeService";

export interface RunCommandDeps {
  commands: CommandRegistry;
  events: EventBus<AppEvents>;
  runCode: RunCodeService;
  configs: RunConfigurationService;
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
  // Which runtime a run uses is chosen where runtimes are managed: the active version there wins.
  commands.register("run.selectRuntime", () => {
    events.emit("showRuntimeManager", undefined);
  });
}
