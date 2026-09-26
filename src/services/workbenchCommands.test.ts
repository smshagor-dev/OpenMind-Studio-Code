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
    // ".rs", not ".ts": a real DocumentService maps ".ts" to Monaco's "typescript" language,
    // which lazily loads a worker-backed language service that jsdom can't run and that leaks an
    // async rejection past this test file's teardown — see CLAUDE.md's "Editor Test Stability
    // Gate" milestone entry.
    const id = (await workspace.openPath("a.rs")) ?? "";
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

  it("file.openRecentFolder opens the folder passed as its argument", async () => {
    await commands.execute("file.openRecentFolder", "C:/proj");

    expect(ipc.workspaceOpenFolder).toHaveBeenCalledWith("C:/proj");
  });

  it("Edit > Paste reads the clipboard through the app and never through the WebView", async () => {
    const pasted: string[] = [];
    const editor = { pasteText: (text: string) => pasted.push(text) > 0, hasEditor: () => true };
    const localCommands = new CommandRegistry();
    const localIpc = createFakeIpc({
      clipboardReadText: vi.fn().mockResolvedValue("from clipboard"),
    });
    const documents = new DocumentService(localIpc, new BufferManager(), events);
    registerWorkbenchCommands({
      commands: localCommands,
      events,
      ipc: localIpc,
      documents,
      workspace: new WorkspaceService(documents, localIpc, events),
      editor: editor as unknown as EditorService,
      layout,
      window: new WindowService(fakeWindowApi, localIpc),
    });
    await localCommands.execute("edit.paste");
    expect(localIpc.clipboardReadText).toHaveBeenCalled();
    expect(pasted).toEqual(["from clipboard"]);
  });

  it("File > Revert is simply unavailable on a preview tab instead of throwing", () => {
    const localCommands = new CommandRegistry();
    const documents = new DocumentService(ipc, new BufferManager(), events);
    const isDirty = vi.spyOn(documents, "isDirty").mockImplementation(() => {
      throw new Error('document "pv:1" does not exist');
    });
    const workspaceStub = {
      getState: () => ({
        activeId: "pv:1",
        tabs: [{ id: "pv:1", kind: "filePreview", dirty: false }],
      }),
    } as unknown as WorkspaceService;
    registerWorkbenchCommands({
      commands: localCommands,
      events,
      ipc,
      documents,
      workspace: workspaceStub,
      editor: new EditorService(ipc),
      layout,
      window: new WindowService(fakeWindowApi, ipc),
    });
    expect(() => localCommands.isEnabled("file.revert")).not.toThrow();
    expect(localCommands.isEnabled("file.revert")).toBe(false);
    expect(isDirty).not.toHaveBeenCalled();
  });

  it("help.about emits showAbout", async () => {
    const listener = vi.fn();
    events.on("showAbout", listener);

    await commands.execute("help.about");

    expect(listener).toHaveBeenCalled();
  });
});
