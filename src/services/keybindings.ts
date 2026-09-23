import type { CommandRegistry } from "./commandRegistry";

/**
 * Who actually dispatches a binding:
 * - `app`: `KeybindingService` handles the keystroke globally (window-level listener).
 * - `editor`: Monaco already binds this key natively while the editor has focus; the entry exists
 *   only so menus can display the same shortcut VS Code shows. Dispatching it ourselves too would
 *   run the action twice.
 */
export type KeybindingOwner = "app" | "editor";

export interface Keybinding {
  /** Normalized chord, e.g. `Ctrl+Shift+S`, `Alt+Z`, `F11`. */
  key: string;
  command: string;
  owner: KeybindingOwner;
}

/** VS Code's Windows default keybindings for every command OpenMind Studio's menus expose. */
export const DEFAULT_KEYBINDINGS: Keybinding[] = [
  // File
  { key: "Ctrl+N", command: "file.new", owner: "app" },
  { key: "Ctrl+O", command: "file.open", owner: "app" },
  { key: "Ctrl+Shift+O", command: "file.openFolder", owner: "app" },
  { key: "Ctrl+Shift+T", command: "file.reopenClosed", owner: "app" },
  { key: "Ctrl+S", command: "file.save", owner: "app" },
  { key: "Ctrl+Shift+S", command: "file.saveAs", owner: "app" },
  { key: "Ctrl+W", command: "file.closeActiveTab", owner: "app" },
  { key: "Ctrl+F4", command: "file.closeActiveTab", owner: "app" },
  { key: "Alt+F4", command: "file.closeWindow", owner: "app" },
  // Edit (Monaco-native)
  { key: "Ctrl+Z", command: "edit.undo", owner: "editor" },
  { key: "Ctrl+Y", command: "edit.redo", owner: "editor" },
  { key: "Ctrl+X", command: "edit.cut", owner: "editor" },
  { key: "Ctrl+C", command: "edit.copy", owner: "editor" },
  { key: "Ctrl+V", command: "edit.paste", owner: "editor" },
  { key: "Ctrl+F", command: "edit.find", owner: "editor" },
  { key: "Ctrl+H", command: "edit.replace", owner: "editor" },
  { key: "Ctrl+Shift+F", command: "search.findInFiles", owner: "app" },
  { key: "Ctrl+Shift+H", command: "search.replaceInFiles", owner: "app" },
  { key: "Ctrl+/", command: "edit.toggleLineComment", owner: "editor" },
  { key: "Shift+Alt+A", command: "edit.toggleBlockComment", owner: "editor" },
  // Selection (Monaco-native)
  { key: "Ctrl+A", command: "selection.selectAll", owner: "editor" },
  { key: "Shift+Alt+Right", command: "selection.expand", owner: "editor" },
  { key: "Shift+Alt+Left", command: "selection.shrink", owner: "editor" },
  { key: "Shift+Alt+Up", command: "selection.copyLineUp", owner: "editor" },
  { key: "Shift+Alt+Down", command: "selection.copyLineDown", owner: "editor" },
  { key: "Alt+Up", command: "selection.moveLineUp", owner: "editor" },
  { key: "Alt+Down", command: "selection.moveLineDown", owner: "editor" },
  { key: "Ctrl+Alt+Up", command: "selection.addCursorAbove", owner: "editor" },
  { key: "Ctrl+Alt+Down", command: "selection.addCursorBelow", owner: "editor" },
  { key: "Shift+Alt+I", command: "selection.addCursorsToLineEnds", owner: "editor" },
  { key: "Ctrl+D", command: "selection.addNextOccurrence", owner: "editor" },
  { key: "Ctrl+Shift+L", command: "selection.selectAllOccurrences", owner: "editor" },
  // View
  { key: "Ctrl+Shift+P", command: "workbench.commandPalette", owner: "app" },
  { key: "F1", command: "workbench.commandPalette", owner: "app" },
  { key: "F11", command: "view.toggleFullScreen", owner: "app" },
  { key: "Ctrl+B", command: "view.toggleSidebar", owner: "app" },
  { key: "Ctrl+J", command: "view.togglePanel", owner: "app" },
  { key: "Ctrl+=", command: "view.zoomIn", owner: "app" },
  { key: "Ctrl+-", command: "view.zoomOut", owner: "app" },
  { key: "Ctrl+Numpad0", command: "view.zoomReset", owner: "app" },
  { key: "Ctrl+Shift+E", command: "view.showExplorer", owner: "app" },
  { key: "Ctrl+Shift+G", command: "view.showSourceControl", owner: "app" },
  { key: "Ctrl+Shift+D", command: "view.showRun", owner: "app" },
  { key: "Ctrl+Shift+X", command: "view.showExtensions", owner: "app" },
  { key: "Ctrl+Shift+M", command: "view.showProblems", owner: "app" },
  { key: "Ctrl+Shift+U", command: "view.showOutput", owner: "app" },
  { key: "Ctrl+`", command: "terminal.toggle", owner: "app" },
  { key: "Alt+Z", command: "view.toggleWordWrap", owner: "app" },
  // Go
  { key: "Ctrl+PageDown", command: "go.nextEditor", owner: "app" },
  { key: "Ctrl+PageUp", command: "go.previousEditor", owner: "app" },
  { key: "Ctrl+P", command: "go.toFile", owner: "app" },
  { key: "Ctrl+T", command: "go.toSymbolInWorkspace", owner: "app" },
  { key: "Ctrl+Shift+O", command: "go.toSymbolInEditor", owner: "editor" },
  { key: "F12", command: "go.toDefinition", owner: "editor" },
  { key: "Ctrl+F12", command: "go.toImplementations", owner: "editor" },
  { key: "Shift+F12", command: "go.toReferences", owner: "editor" },
  { key: "Ctrl+G", command: "go.toLine", owner: "editor" },
  { key: "Ctrl+Shift+\\", command: "go.toBracket", owner: "editor" },
  { key: "F8", command: "go.nextProblem", owner: "editor" },
  { key: "Shift+F8", command: "go.previousProblem", owner: "editor" },
  // Run
  { key: "F5", command: "debug.start", owner: "app" },
  { key: "Ctrl+F5", command: "debug.runWithoutDebugging", owner: "app" },
  { key: "Shift+F5", command: "debug.stop", owner: "app" },
  { key: "Ctrl+Shift+F5", command: "debug.restart", owner: "app" },
  { key: "F10", command: "debug.stepOver", owner: "app" },
  { key: "F11", command: "debug.stepInto", owner: "app" },
  { key: "Shift+F11", command: "debug.stepOut", owner: "app" },
  { key: "F9", command: "debug.toggleBreakpoint", owner: "app" },
  // Terminal
  { key: "Ctrl+Shift+`", command: "terminal.new", owner: "app" },
  { key: "Ctrl+Shift+5", command: "terminal.split", owner: "app" },
  { key: "Ctrl+Shift+B", command: "tasks.runBuild", owner: "app" },
];

const CODE_TO_KEY: Record<string, string> = {
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  NumpadAdd: "=",
  NumpadSubtract: "-",
};

const MODIFIER_CODES = new Set([
  "ControlLeft",
  "ControlRight",
  "ShiftLeft",
  "ShiftRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
]);

export interface KeyEventLike {
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/**
 * Normalizes a keyboard event to the `Ctrl+Shift+Alt+Key` form used in `DEFAULT_KEYBINDINGS`.
 * Uses `event.code` (physical key), not `event.key`, so Shift doesn't turn `=` into `+` and
 * keyboard layouts don't change which binding fires. `null` for a bare modifier press.
 */
export function normalizeKeyEvent(event: KeyEventLike): string | null {
  if (MODIFIER_CODES.has(event.code)) {
    return null;
  }
  let key: string;
  if (event.code.startsWith("Key")) {
    key = event.code.slice(3);
  } else if (event.code.startsWith("Digit")) {
    key = event.code.slice(5);
  } else {
    key = CODE_TO_KEY[event.code] ?? event.code;
  }
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push("Ctrl");
  if (event.shiftKey) parts.push("Shift");
  if (event.altKey) parts.push("Alt");
  parts.push(key);
  return parts.join("+");
}

/**
 * Routes global keystrokes to commands and supplies the shortcut labels menus display. Only
 * `app`-owned bindings are dispatched, and only while the command is enabled — so e.g. F11 goes to
 * "Step Into" once a debug session exists to enable it, and to "Full Screen" otherwise.
 */
export class KeybindingService {
  constructor(
    private readonly commands: CommandRegistry,
    private readonly bindings: Keybinding[] = DEFAULT_KEYBINDINGS,
  ) {}

  /** Returns the command id that was dispatched, or `null` if the event wasn't ours to handle. */
  resolve(event: KeyEventLike): string | null {
    const key = normalizeKeyEvent(event);
    if (key === null) {
      return null;
    }
    const match = this.bindings.find(
      (binding) =>
        binding.owner === "app" && binding.key === key && this.commands.isEnabled(binding.command),
    );
    return match?.command ?? null;
  }

  /** The shortcut label shown next to `command` in menus (first binding wins), if any. */
  labelFor(command: string): string | undefined {
    return this.bindings.find((binding) => binding.command === command)?.key;
  }
}
