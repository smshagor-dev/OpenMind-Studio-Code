import type { ShellKind } from "./ipc";
import type { TerminalShellStyle } from "./language/languageIpc";
import { shellStyleFor } from "./runCodeService";
import type { TerminalService } from "./terminalService";

/**
 * Types an argument list into a new OpenMind terminal (which starts with the portable runtimes, the proxy variables
 * and `PYTHONNOUSERSITE=1`), quoted for that terminal's shell by the backend. Used by the Network and dependency
 * helpers, always after a click. Resolves with an error message, or `null` when the line was typed.
 */
export async function typeInNewTerminal(
  terminal: Pick<TerminalService, "getState" | "createTerminal" | "write">,
  quote: (argv: string[], style: TerminalShellStyle) => Promise<string>,
  argv: string[],
  cwd: string | null,
  messages: { noShell: string; failed: string },
): Promise<string | null> {
  const state = terminal.getState();
  const kind =
    [state.lastShell, ...state.shells.map((shell) => shell.kind)].find(
      (candidate): candidate is ShellKind => candidate !== null && shellStyleFor(candidate) !== null,
    ) ?? null;
  const style = kind === null ? null : shellStyleFor(kind);
  if (kind === null || style === null) return messages.noShell;
  const line = await quote(argv, style);
  const id = await terminal.createTerminal(kind, cwd);
  if (id === null) return messages.failed;
  terminal.write(id, `${line}\r`);
  return null;
}
