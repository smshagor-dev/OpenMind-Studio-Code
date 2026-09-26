import { describe, expect, it, vi } from "vitest";

import { CommandRegistry } from "./commandRegistry";
import { EditorGroupService } from "./editorGroupService";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import { DEFAULT_LAYOUT, type LayoutState } from "./layoutService";
import { registerMenuFillCommands, type MenuFillDeps } from "./menuFillCommands";
import { unbuiltReason } from "./menus";

function rig(
  options: { exists?: boolean; picked?: string | null; selection?: string | null } = {},
) {
  const commands = new CommandRegistry();
  const events = new EventBus<AppEvents>();
  const notices: string[] = [];
  events.on("appNotice", ({ message }) => notices.push(message));
  const groups = new EditorGroupService();
  let layoutState: LayoutState = { ...DEFAULT_LAYOUT };
  const layout = {
    getState: () => layoutState,
    toggle: (key: "zenMode" | "centeredLayout") => {
      layoutState = { ...layoutState, [key]: !layoutState[key] };
      return Promise.resolve();
    },
  };
  let fullscreen = false;
  const win = {
    getState: () => ({ fullscreen }),
    toggleFullscreen: vi.fn().mockImplementation(() => {
      fullscreen = !fullscreen;
      return Promise.resolve();
    }),
  };
  const ipc = {
    saveDocumentDialog: vi
      .fn()
      .mockResolvedValue(options.picked === undefined ? "D:/Any Place/new.txt" : options.picked),
    fsMetadata: vi
      .fn()
      .mockImplementation(() =>
        options.exists ? Promise.resolve({}) : Promise.reject(new Error("missing")),
      ),
    documentSave: vi.fn().mockResolvedValue(undefined),
  };
  const workspace = {
    openPath: vi.fn().mockResolvedValue(undefined),
    setActiveGroup: (id: string) => {
      groups.setActiveGroup(id);
    },
  };
  const terminalState = { activeId: null as string | null };
  const terminal = {
    getState: () => terminalState,
    createTerminal: vi.fn().mockImplementation(() => {
      terminalState.activeId = "t1";
      return Promise.resolve("t1");
    }),
    write: vi.fn(),
  };
  const panel = { show: vi.fn().mockResolvedValue(undefined) };
  const editor = {
    hasEditor: () => true,
    selectedText: () =>
      options.selection === undefined || options.selection === null
        ? null
        : { text: options.selection },
  };
  const run = vi.fn();
  registerMenuFillCommands({
    commands,
    events,
    ipc,
    workspace,
    groups,
    editor,
    terminal,
    panel,
    layout,
    window: win,
    autoSave: { toggle: vi.fn(), enabled: () => false },
    run,
  } as unknown as MenuFillDeps);
  return { commands, ipc, workspace, groups, layout, win, terminal, panel, run, notices };
}

describe("New File...", () => {
  it("creates an empty file wherever the Save dialog points and opens it", async () => {
    const r = rig();
    await r.commands.execute("file.newFilePicker");
    expect(r.ipc.documentSave).toHaveBeenCalledWith("D:/Any Place/new.txt", "", "utf8");
    expect(r.workspace.openPath).toHaveBeenCalledWith("D:/Any Place/new.txt");
  });

  it("never empties a file that is already there", async () => {
    const r = rig({ exists: true });
    await r.commands.execute("file.newFilePicker");
    expect(r.ipc.documentSave).not.toHaveBeenCalled();
    expect(r.workspace.openPath).toHaveBeenCalled();
  });

  it("cancelling the dialog does nothing", async () => {
    const r = rig({ picked: null });
    await r.commands.execute("file.newFilePicker");
    expect(r.ipc.documentSave).not.toHaveBeenCalled();
    expect(r.workspace.openPath).not.toHaveBeenCalled();
  });
});

describe("editor layout and Switch Group", () => {
  it("Two Columns, Three Columns and Single change the number of groups and lose no tab", () => {
    const r = rig();
    r.groups.openTab("d1", "text");
    void r.commands.execute("editorLayout.threeColumns");
    expect(r.groups.getState().groups).toHaveLength(3);
    expect(r.commands.isChecked("editorLayout.threeColumns")).toBe(true);
    r.groups.setActiveGroup(r.groups.getState().groups[2]?.id ?? "");
    r.groups.openTab("d2", "text");
    void r.commands.execute("editorLayout.single");
    const only = r.groups.getState().groups;
    expect(only).toHaveLength(1);
    expect(only[0]?.tabs.map((tab) => tab.docId).sort()).toEqual(["d1", "d2"]);
    void r.commands.execute("editorLayout.twoColumns");
    expect(r.groups.getState().groups).toHaveLength(2);
    expect(r.groups.getState().weights).toEqual([0.5, 0.5]);
  });

  it("Group 2 and Next/Previous Group need more than one group and move focus", () => {
    const r = rig();
    expect(r.commands.isEnabled("go.group2")).toBe(false);
    expect(r.commands.reasonFor("go.nextGroup")).toContain("only one editor group");
    void r.commands.execute("editorLayout.twoColumns");
    const [first, second] = r.groups.getState().groups;
    void r.commands.execute("go.group1");
    expect(r.groups.getState().activeGroupId).toBe(first?.id);
    void r.commands.execute("go.nextGroup");
    expect(r.groups.getState().activeGroupId).toBe(second?.id);
    void r.commands.execute("go.nextGroup");
    expect(r.groups.getState().activeGroupId).toBe(first?.id);
    void r.commands.execute("go.previousGroup");
    expect(r.groups.getState().activeGroupId).toBe(second?.id);
  });
});

describe("Zen Mode, Centered Layout and Run Selected Text", () => {
  it("Zen Mode hides the chrome, goes full screen and puts everything back", async () => {
    const r = rig();
    await r.commands.execute("view.toggleZenMode");
    expect(r.layout.getState().zenMode).toBe(true);
    expect(r.win.getState().fullscreen).toBe(true);
    await r.commands.execute("view.toggleZenMode");
    expect(r.layout.getState().zenMode).toBe(false);
    expect(r.win.getState().fullscreen).toBe(false);
  });

  it("Zen Mode leaves full screen alone when you were already in it", async () => {
    const r = rig();
    await r.win.toggleFullscreen();
    await r.commands.execute("view.toggleZenMode");
    await r.commands.execute("view.toggleZenMode");
    expect(r.win.getState().fullscreen).toBe(true);
  });

  it("Centered Layout toggles and is checkable", async () => {
    const r = rig();
    await r.commands.execute("view.toggleCenteredLayout");
    expect(r.commands.isChecked("view.toggleCenteredLayout")).toBe(true);
  });

  it("Run Selected Text types the selection into a terminal (opening one if needed) and presses Enter", async () => {
    const r = rig({ selection: "echo a\necho b" });
    await r.commands.execute("terminal.runSelectedText");
    expect(r.terminal.createTerminal).toHaveBeenCalled();
    expect(r.panel.show).toHaveBeenCalledWith("terminal");
    expect(r.terminal.write).toHaveBeenCalledWith("t1", "echo a\recho b\r");
  });

  it("Run Selected Text with nothing selected says so and sends nothing", async () => {
    const r = rig();
    await r.commands.execute("terminal.runSelectedText");
    expect(r.notices).toEqual(["Select the text to run first."]);
    expect(r.terminal.write).not.toHaveBeenCalled();
  });

  it("Run Active File and the Help aliases run the commands they stand for", async () => {
    const r = rig();
    r.commands.register("run.codeInTerminal", vi.fn());
    await r.commands.execute("terminal.runActiveFile");
    await r.commands.execute("help.keybindingsReference");
    await r.commands.execute("help.license");
    expect((r.run.mock.calls as unknown[][]).map((c) => c[0])).toEqual([
      "run.codeInTerminal",
      "preferences.openKeybindings",
      "help.about",
    ]);
  });
});

describe("entries that aren't built", () => {
  it("say why in words", () => {
    expect(unbuiltReason("help.documentation")).toContain("no online documentation");
    expect(unbuiltReason("workspace.addFolder")).toContain("one folder per window");
    expect(unbuiltReason("something.else")).toBe("This isn't built yet.");
  });
});
