import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { BufferManager } from "./bufferManager";
import { CommandRegistry } from "./commandRegistry";
import { DocumentService } from "./documentService";
import { EditorService } from "./editorService";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { IpcClient } from "./ipc";
import { LayoutService } from "./layoutService";
import { ThemeService } from "./themeService";
import { type WindowApi, WindowService } from "./windowService";
import { registerWorkbenchCommands } from "./workbenchCommands";
import { WorkspaceService } from "./workspaceService";

const fakeWindowApi: WindowApi = {
  minimize: vi.fn().mockResolvedValue(undefined),
  toggleMaximize: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  isMaximized: vi.fn().mockResolvedValue(false),
  isFullscreen: vi.fn().mockResolvedValue(false),
  setFullscreen: vi.fn().mockResolvedValue(undefined),
  onResized: vi.fn().mockResolvedValue(() => undefined),
  setZoom: vi.fn().mockResolvedValue(undefined),
};

describe("registerWorkbenchCommands", () => {
  let ipc: IpcClient;
  let events: EventBus<AppEvents>;
  let buffers: BufferManager;
  let commands: CommandRegistry;
  let workspace: WorkspaceService;
  let layout: LayoutService;

  beforeEach(() => {
    ipc = createFakeIpc({
      documentOpen: vi.fn((path: string) =>
        Promise.resolve({
          path,
          content: "saved",
          encoding: "utf8" as const,
          lineEnding: "lf" as const,
        }),
      ),
    });
    events = new EventBus<AppEvents>();
    buffers = new BufferManager();
    commands = new CommandRegistry();
    const documents = new DocumentService(ipc, buffers, events);
    workspace = new WorkspaceService(documents, ipc, events);
    layout = new LayoutService(ipc);
    registerWorkbenchCommands({
      commands,
      events,
      ipc,
      documents,
      workspace,
      editor: new EditorService(ipc),
      layout,
      window: new WindowService(fakeWindowApi, ipc),
      theme: new ThemeService(ipc, events),
    });
  });

  it("disables editor actions while no editor is mounted", () => {
    expect(commands.isEnabled("edit.undo")).toBe(false);
    expect(commands.isEnabled("workbench.commandPalette")).toBe(false);
  });

  it("reports editor toggles as checked/unchecked", () => {
    expect(commands.isChecked("view.toggleMinimap")).toBe(true);
    expect(commands.isChecked("view.toggleWordWrap")).toBe(false);
  });

  it("file.revert is enabled only for a dirty active document", async () => {
    const id = (await workspace.openPath("a.ts")) ?? "";
    expect(commands.isEnabled("file.revert")).toBe(false);

    buffers.setValue(id, "edited");
    expect(commands.isEnabled("file.revert")).toBe(true);

    await commands.execute("file.revert");
    expect(buffers.getValue(id)).toBe("saved");
  });

  it("view.toggleSidebar flips the layout and reports its checked state", async () => {
    expect(commands.isChecked("view.toggleSidebar")).toBe(true);

    await commands.execute("view.toggleSidebar");

    expect(layout.getState().sidebarVisible).toBe(false);
    expect(commands.isChecked("view.toggleSidebar")).toBe(false);
  });

  it("view.showExplorer reveals the sidebar and asks the explorer to take focus", async () => {
    const focus = vi.fn();
    events.on("focusExplorer", focus);
    await layout.setSidebarVisible(false);

    await commands.execute("view.showExplorer");

    expect(layout.getState().sidebarVisible).toBe(true);
    expect(focus).toHaveBeenCalled();
  });

  it("file.openRecentFolder opens the folder passed as its argument", async () => {
    await commands.execute("file.openRecentFolder", "C:/proj");

    expect(ipc.workspaceOpenFolder).toHaveBeenCalledWith("C:/proj");
  });

  it("help.about emits showAbout", async () => {
    const listener = vi.fn();
    events.on("showAbout", listener);

    await commands.execute("help.about");

    expect(listener).toHaveBeenCalled();
  });
});
