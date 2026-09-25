import { container } from "../services/container";

/** The shortcut in force for a command (the user's, if they changed it), for tooltips and hints. */
export function shortcutFor(command: string): string | undefined {
  return container.keybindings.labelFor(command);
}

/** `Label (Ctrl+S)` — or just `Label` when the command has no shortcut. */
export function withShortcut(label: string, command: string): string {
  const key = shortcutFor(command);
  return key === undefined ? label : `${label} (${key})`;
}
