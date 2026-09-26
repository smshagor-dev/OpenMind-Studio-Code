import type { AutoSaveService } from "./autoSaveService";
import type { CommandRegistry } from "./commandRegistry";
import type { EditorGroupService } from "./editorGroupService";
import type { EditorService } from "./editorService";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { IpcClient } from "./ipc";
import type { LayoutService } from "./layoutService";
import type { PanelService } from "./panelService";
import type { TerminalService } from "./terminalService";
import type { WindowService } from "./windowService";
import type { WorkspaceService } from "./workspaceService";

export interface MenuFillDeps {
  commands: CommandRegistry;
  events: EventBus<AppEvents>;
  ipc: IpcClient;
  workspace: WorkspaceService;
  groups: EditorGroupService;
  editor: EditorService;
  terminal: TerminalService;
  panel: PanelService;
  layout: LayoutService;
  window: WindowService;
  autoSave: AutoSaveService;
  run: (id: string) => void;
}

/**
 * Menu commands that were missing: New File... (choose any place on the computer), Auto Save, the column layouts,
 * Switch Group, Zen Mode, Centered Layout, Run Active File / Run Selected Text and two Help aliases. Each one does
 * its real job; nothing here is a placeholder.
 */
export function registerMenuFillCommands(deps: MenuFillDeps): void {
  const { commands, events, ipc, workspace, groups, editor, terminal, panel, layout } = deps;
  const notice = (message: string) => {
    events.emit("appNotice", { message });
  };

  // --- New File... : the native Save dialog picks the place (any drive or folder), then the file is created and opened ---
  commands.register("file.newFilePicker", async () => {
    const path = await ipc.saveDocumentDialog(undefined);
    if (path === null) return;
    const exists = await ipc.fsMetadata(path).then(
      () => true,
      () => false,
    );
    // A file that is already there is opened as it is: choosing its name never empties it.
    if (!exists) await ipc.documentSave(path, "", "utf8");
    await workspace.openPath(path);
  });

  // --- Auto Save ---
  commands.register(
    "file.toggleAutoSave",
    async () => {
      await deps.autoSave.toggle();
    },
    { checked: () => deps.autoSave.enabled() },
  );

  // --- Editor layout (groups are side by side) ---
  for (const [id, count] of [
    ["editorLayout.single", 1],
    ["editorLayout.twoColumns", 2],
    ["editorLayout.threeColumns", 3],
  ] as const) {
    commands.register(
      id,
      () => {
        groups.setColumns(count);
      },
      { checked: () => groups.getState().groups.length === count },
    );
  }

  // --- Go > Switch Group ---
  const groupAt = (index: number) => groups.getState().groups[index];
  for (const [id, index] of [
    ["go.group1", 0],
    ["go.group2", 1],
  ] as const) {
    commands.register(
      id,
      () => {
        const group = groupAt(index);
        if (group) workspace.setActiveGroup(group.id);
      },
      {
        enabled: () => groupAt(index) !== undefined,
        disabledReason: () => `There is no group ${String(index + 1)}. Split the editor first.`,
      },
    );
  }
  const cycleGroup = (delta: number) => {
    const { groups: all, activeGroupId } = groups.getState();
    const current = all.findIndex((group) => group.id === activeGroupId);
    const next = all[(((current + delta) % all.length) + all.length) % all.length];
    if (next) workspace.setActiveGroup(next.id);
  };
  const manyGroups = () => groups.getState().groups.length > 1;
  const oneGroup = () =>
    manyGroups() ? undefined : "There is only one editor group. Split the editor first.";
  commands.register(
    "go.nextGroup",
    () => {
      cycleGroup(1);
    },
    { enabled: manyGroups, disabledReason: oneGroup },
  );
  commands.register(
    "go.previousGroup",
    () => {
      cycleGroup(-1);
    },
    { enabled: manyGroups, disabledReason: oneGroup },
  );

  // --- Zen Mode / Centered Layout ---
  let zenMadeFullScreen = false;
  commands.register(
    "view.toggleZenMode",
    async () => {
      const entering = !layout.getState().zenMode;
      await layout.toggle("zenMode");
      const fullscreen = deps.window.getState().fullscreen;
      if (entering && !fullscreen) {
        zenMadeFullScreen = true;
        await deps.window.toggleFullscreen();
      } else if (!entering && zenMadeFullScreen) {
        zenMadeFullScreen = false;
        await deps.window.toggleFullscreen();
      }
    },
    { checked: () => layout.getState().zenMode },
  );
  commands.register("view.toggleCenteredLayout", () => layout.toggle("centeredLayout"), {
    checked: () => layout.getState().centeredLayout,
  });

  // --- Terminal > Run Active File / Run Selected Text ---
  commands.register(
    "terminal.runActiveFile",
    () => {
      deps.run("run.codeInTerminal");
    },
    {
      enabled: () => commands.isEnabled("run.codeInTerminal"),
      disabledReason: () => commands.reasonFor("run.codeInTerminal"),
    },
  );
  commands.register(
    "terminal.runSelectedText",
    async () => {
      const selected = editor.selectedText();
      if (selected === null) {
        notice("Select the text to run first.");
        return;
      }
      if (terminal.getState().activeId === null) await terminal.createTerminal();
      const id = terminal.getState().activeId;
      if (id === null) return;
      await panel.show("terminal");
      terminal.write(id, `${selected.text.replace(/\r?\n/g, "\r")}\r`);
    },
    {
      enabled: () => editor.hasEditor(),
      disabledReason: () => (editor.hasEditor() ? undefined : "Open a text file first."),
    },
  );

  // --- Help aliases ---
  commands.register("help.keybindingsReference", () => {
    deps.run("preferences.openKeybindings");
  });
  commands.register("help.license", () => {
    deps.run("help.about");
  });
}
