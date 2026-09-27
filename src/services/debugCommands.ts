import type { BreakpointService } from "./breakpointService";
import type { CommandRegistry } from "./commandRegistry";
import type { DebugService } from "./debugService";
import type { EditorService } from "./editorService";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";

export interface DebugCommandDeps {
  commands: CommandRegistry;
  debug: DebugService;
  breakpoints: BreakpointService;
  editor: EditorService;
  events: EventBus<AppEvents>;
  /** The saved text file in front and the cursor line of its editor. */
  activeFile: () => { path: string; docId: string } | null;
  /** Shows the Run and Debug view (where the breakpoint form opens). */
  showDebugView?: () => void;
  /** Opens (or creates) the folder's launch.json; `null` when no folder is open. */
  openLaunchJson?: (() => Promise<unknown>) | null;
  /** Whether a folder is open (launch.json lives in it). */
  hasFolder?: () => boolean;
}

/**
 * The Run menu's debugger commands and their shortcuts (F5, Shift+F5, F9, F10, F11, Shift+F11 are
 * already bound to these ids). F5 is Start Debugging — or Continue once the program is paused —
 * never Run Code; Ctrl+F5 stays Run Code. Every command is enabled only when it can really run
 * and says why when it can't.
 */
export function registerDebugCommands(deps: DebugCommandDeps): void {
  const { commands, debug, breakpoints, editor, events, activeFile } = deps;
  const guarded = (
    id: string,
    handler: () => unknown,
    state: () => { enabled: boolean; reason?: string },
  ) => {
    commands.register(
      id,
      async () => {
        await handler();
      },
      { enabled: () => state().enabled, disabledReason: () => state().reason },
    );
  };

  guarded(
    "debug.start",
    () => (debug.controlState("continue").enabled ? debug.control("continue") : debug.start()),
    () => (debug.controlState("continue").enabled ? { enabled: true } : debug.startState()),
  );
  guarded(
    "debug.stop",
    () => debug.stop(),
    () => debug.controlState("stop"),
  );
  guarded(
    "debug.restart",
    () => debug.restart(),
    () => debug.controlState("restart"),
  );
  guarded(
    "debug.continue",
    () => debug.control("continue"),
    () => debug.controlState("continue"),
  );
  guarded(
    "debug.pause",
    () => debug.control("pause"),
    () => debug.controlState("pause"),
  );
  guarded(
    "debug.stepOver",
    () => debug.control("stepOver"),
    () => debug.controlState("stepOver"),
  );
  guarded(
    "debug.stepInto",
    () => debug.control("stepInto"),
    () => debug.controlState("stepInto"),
  );
  guarded(
    "debug.stepOut",
    () => debug.control("stepOut"),
    () => debug.controlState("stepOut"),
  );

  guarded(
    "debug.toggleBreakpoint",
    () => {
      const file = activeFile();
      const line = editor.getStatus()?.line;
      if (file && line !== undefined) breakpoints.toggle(file.path, line);
    },
    () =>
      activeFile() !== null && editor.hasEditor()
        ? { enabled: true }
        : { enabled: false, reason: "Save the file to set a breakpoint in it." },
  );
  const any = () =>
    breakpoints.getState().breakpoints.length > 0
      ? { enabled: true }
      : { enabled: false, reason: "There are no breakpoints." };
  guarded(
    "debug.enableAllBreakpoints",
    () => {
      breakpoints.setAllEnabled(true);
    },
    any,
  );
  guarded(
    "debug.disableAllBreakpoints",
    () => {
      breakpoints.setAllEnabled(false);
    },
    any,
  );
  guarded(
    "debug.removeAllBreakpoints",
    () => {
      breakpoints.removeAll();
    },
    any,
  );

  // Conditional breakpoints, logpoints and editing: a breakpoint at the cursor with its form open in Run and Debug.
  const editHere = () => {
    const file = activeFile();
    const line = editor.getStatus()?.line;
    if (file && line !== undefined) {
      breakpoints.editAt(file.path, line);
      deps.showDebugView?.();
    }
  };
  const editable = () =>
    activeFile() !== null && editor.hasEditor()
      ? { enabled: true }
      : { enabled: false, reason: "Save the file to set a breakpoint in it." };
  for (const id of [
    "debug.newConditionalBreakpoint",
    "debug.newLogpoint",
    "debug.editBreakpoint",
  ]) {
    guarded(id, editHere, editable);
  }
  const launchState = () =>
    deps.openLaunchJson && deps.hasFolder?.()
      ? { enabled: true }
      : { enabled: false, reason: "Open a folder: launch.json belongs to a folder." };
  guarded("debug.openConfigurations", () => deps.openLaunchJson?.(), launchState);
  guarded("debug.addConfiguration", () => deps.openLaunchJson?.(), launchState);

  // "Install Additional Debuggers…" opens the Runtime Manager, where the Python and Node.js debuggers install.
  commands.register("debug.installDebuggers", () => {
    events.emit("showRuntimeManager", undefined);
  });
}
