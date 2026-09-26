import type { CommandRegistry } from "./commandRegistry";
import type { ShellKind } from "./ipc";
import type { TerminalService } from "./terminalService";

const SHELL_KINDS: readonly ShellKind[] = ["powerShell", "cmd", "gitBash", "wsl"];

function asShellKind(value: unknown): ShellKind | undefined {
  return SHELL_KINDS.find((kind) => kind === value);
}

/**
 * The integrated terminal's commands. `terminal.split` is deliberately not
 * registered: split panes aren't built yet, so its menu entry stays disabled
 * rather than pointing at a stub.
 */
export function registerTerminalCommands(commands: CommandRegistry, terminal: TerminalService) {
  const hasActive = () => terminal.getState().activeId !== null;

  commands.register("terminal.toggle", () => terminal.togglePanel(), {
    checked: () => terminal.isShowing(),
  });
  // The optional argument is the shell picked in the panel's shell selector.
  commands.register("terminal.new", async (shell) => {
    await terminal.createTerminal(asShellKind(shell));
  });
  commands.register(
    "terminal.clear",
    () => {
      terminal.clearActive();
    },
    { enabled: hasActive },
  );
  commands.register("terminal.kill", () => terminal.closeActive(), { enabled: hasActive });
  commands.register("terminal.killAll", () => terminal.closeAll(), {
    enabled: () => terminal.getState().sessions.length > 0,
    disabledReason: () =>
      terminal.getState().sessions.length > 0 ? undefined : "No terminal is open.",
  });
}
