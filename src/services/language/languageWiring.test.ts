import { ipcWorkspaceFeed } from "../../testUtils/canonicalFeeds";
import { describe, expect, it, vi } from "vitest";

import {
  REGISTRY,
  fileStatus,
  formatOption,
  workspaceStatus,
} from "../../testUtils/languageFixtures";
import { createFakeIpc } from "../../testUtils/fakeIpcClient";
import { CommandRegistry } from "../commandRegistry";
import { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import type { EditorTabView } from "../workspaceService";
import { wireLanguage } from "./languageWiring";

interface Options {
  kind?: EditorTabView["kind"] | "none";
  path?: string | null;
  dirty?: boolean;
  root?: string | null;
  file?: ReturnType<typeof fileStatus>;
}

async function setup(options: Options = {}) {
  const {
    kind = "text",
    path = "C:/My Project/src/a.ts",
    dirty = false,
    root = "C:/My Project",
  } = options;
  const events = new EventBus<AppEvents>();
  const ipc = createFakeIpc({
    languageRegistry: vi.fn().mockResolvedValue(REGISTRY),
    languageWorkspaceStatus: vi.fn().mockResolvedValue(workspaceStatus()),
    languageFileStatus: vi.fn().mockResolvedValue(options.file ?? fileStatus()),
  });
  const commands = new CommandRegistry();
  const tab = {
    id: "d1",
    docId: "d1",
    kind: kind === "none" ? "text" : kind,
    title: "a.ts",
    dirty,
    groupId: "group-1",
  };
  const tabs = kind === "none" ? [] : [tab];
  const state = {
    tabs,
    activeId: kind === "none" ? null : "d1",
    activeGroupId: "group-1",
    groups: [{ id: "group-1", tabs, activeTabId: kind === "none" ? null : "d1", locked: false }],
    weights: [1],
  };
  const save = vi.fn().mockResolvedValue(undefined);
  const terminal = {
    createTerminal: vi.fn().mockResolvedValue("t1"),
    write: vi.fn(),
    setActive: vi.fn(),
    getState: vi.fn().mockReturnValue({
      sessions: [
        {
          id: "t1",
          shell: "powerShell",
          title: "PowerShell",
          cwd: "",
          exited: false,
          exitCode: null,
        },
      ],
      activeId: "t1",
      shells: [],
      lastShell: null,
    }),
  };
  const wiring = wireLanguage({
    ipc,
    events,
    commands,
    workspace: {
      getState: () => state as never,
      docPath: () => path,
      getActiveWorkspace: () => (root === null ? null : { id: 1, path: root, name: "My Project" }),
    },
    documents: { save },
    terminal,
    showTerminal: vi.fn().mockResolvedValue(undefined),
  });
  // The folder's project status, as the canonical state delivers it.
  wiring.support.useCanonical(ipcWorkspaceFeed(() => ipc.languageWorkspaceStatus()));
  await wiring.support.initialize();
  const notices: string[] = [];
  events.on("appNotice", ({ message }) => {
    notices.push(message);
  });
  return { ...wiring, ipc, commands, save, terminal, notices };
}

describe("wireLanguage: the commands are registered and say why they can't run", () => {
  it("registers the status window, the rescan, format-with-tool and the linter", async () => {
    const { commands } = await setup();
    for (const id of [
      "language.showStatus",
      "language.refresh",
      "language.formatWithTool",
      "language.runLinter",
    ]) {
      expect(commands.has(id)).toBe(true);
    }
  });

  it("format and lint are disabled with a reason for every case that can't work", async () => {
    const noFolder = await setup({ root: null });
    expect(noFolder.commands.reasonFor("language.formatWithTool")).toBe("Open a folder first.");
    expect(noFolder.commands.isEnabled("language.refresh")).toBe(false);

    const preview = await setup({ kind: "filePreview" });
    expect(preview.commands.reasonFor("language.formatWithTool")).toBe(
      "Open a text file first (a preview can't be formatted).",
    );
    const none = await setup({ kind: "none" });
    expect(none.commands.isEnabled("language.runLinter")).toBe(false);

    const untitled = await setup({ path: null });
    expect(untitled.commands.reasonFor("language.formatWithTool")).toBe(
      "Save the file first: a tool works on a file on disk.",
    );

    const outside = await setup({ path: "D:/elsewhere/a.ts" });
    expect(outside.commands.reasonFor("language.formatWithTool")).toBe(
      "This file is outside the open folder.",
    );
    const sibling = await setup({ path: "C:/My Project 2/a.ts" });
    expect(sibling.commands.reasonFor("language.formatWithTool")).toBe(
      "This file is outside the open folder.",
    );

    const unknown = await setup({ path: "C:/My Project/data.xyz" });
    expect(unknown.commands.reasonFor("language.formatWithTool")).toBe(
      "OpenMind doesn't know this file's language.",
    );

    const nothingKnown = await setup({ path: "C:/My Project/notes.txt" });
    expect(nothingKnown.commands.reasonFor("language.formatWithTool")).toBe(
      "No formatter is known for Plain Text.",
    );
    expect(nothingKnown.commands.reasonFor("language.runLinter")).toBe(
      "No linter is known for Plain Text.",
    );
  });

  it("are enabled on a saved text file inside the folder whose language has candidates", async () => {
    const { commands } = await setup();
    expect(commands.isEnabled("language.formatWithTool")).toBe(true);
    expect(commands.isEnabled("language.runLinter")).toBe(true);
    // Windows paths and different letter case are the same folder.
    const win = await setup({ path: "c:\\my project\\src\\a.ts" });
    expect(win.commands.isEnabled("language.formatWithTool")).toBe(true);
  });
});

describe("wireLanguage: Format Document With Tool", () => {
  it("runs the tool that was found, in the terminal, in the project's folder", async () => {
    const rig = await setup({ file: fileStatus({ projectRoot: "apps/web" }) });
    await rig.commands.execute("language.formatWithTool");
    expect(rig.terminal.createTerminal).toHaveBeenCalledWith(undefined, "C:/My Project/apps/web");
    expect(rig.ipc.languageTerminalLine).toHaveBeenCalledWith(formatOption().argv, "powerShell");
    expect(rig.terminal.write).toHaveBeenCalledWith("t1", `${formatOption().argv.join(" ")}\r`);
    expect(rig.save).not.toHaveBeenCalled();
  });

  it("saves an edited file first, because a tool works on the file on disk", async () => {
    const rig = await setup({ dirty: true });
    await rig.commands.execute("language.formatWithTool");
    expect(rig.save).toHaveBeenCalledWith("d1");
    expect(rig.terminal.write).toHaveBeenCalled();
  });

  it("uses the first found tool (the project's own is listed first) and skips missing ones", async () => {
    const rig = await setup({
      file: fileStatus({
        formatters: [
          formatOption({
            tool: "biome",
            name: "Biome",
            found: null,
            argv: [],
            hint: "Add it to the project.",
          }),
          formatOption({ tool: "prettier", name: "Prettier" }),
        ],
      }),
    });
    await rig.commands.execute("language.formatWithTool");
    expect(rig.ipc.languageTerminalLine).toHaveBeenCalledWith(formatOption().argv, "powerShell");
  });

  it("says there is no formatter, naming the candidates and how to get them — and runs nothing", async () => {
    const rig = await setup({
      file: fileStatus({
        formatters: [
          formatOption({
            tool: "prettier",
            name: "Prettier",
            found: null,
            argv: [],
            hint: "Add it to the project (`npm i -D prettier`).",
          }),
          formatOption({
            tool: "biome",
            name: "Biome",
            found: null,
            argv: [],
            hint: "Add it to the project (`npm i -D @biomejs/biome`).",
          }),
        ],
      }),
    });
    await rig.commands.execute("language.formatWithTool");
    expect(rig.notices).toHaveLength(1);
    expect(rig.notices[0]).toContain("No formatter found for TypeScript");
    expect(rig.notices[0]).toContain("Prettier: Add it to the project (`npm i -D prettier`).");
    expect(rig.notices[0]).toContain("Biome:");
    expect(rig.terminal.createTerminal).not.toHaveBeenCalled();
  });

  it("does not run when the command is invoked while it is disabled", async () => {
    const rig = await setup({ kind: "filePreview" });
    await rig.commands.execute("language.formatWithTool");
    expect(rig.notices).toEqual(["Open a text file first (a preview can't be formatted)."]);
    expect(rig.terminal.createTerminal).not.toHaveBeenCalled();
    expect(rig.ipc.languageFileStatus).not.toHaveBeenCalled();
  });
});

describe("wireLanguage: Run Linter and the status window", () => {
  it("runs the linter that was found", async () => {
    const linter = formatOption({
      tool: "eslint",
      name: "ESLint",
      kind: "lint",
      argv: ["C:/My Project/node_modules/.bin/eslint.cmd", "C:/My Project/src/a.ts"],
    });
    const rig = await setup({ file: fileStatus({ linters: [linter] }) });
    await rig.commands.execute("language.runLinter");
    expect(rig.ipc.languageTerminalLine).toHaveBeenCalledWith(linter.argv, "powerShell");
  });

  it("reports a missing linter", async () => {
    const rig = await setup({
      file: fileStatus({
        linters: [
          formatOption({
            tool: "eslint",
            name: "ESLint",
            kind: "lint",
            found: null,
            argv: [],
            hint: "Add it to the project (`npm i -D eslint`).",
          }),
        ],
      }),
    });
    await rig.commands.execute("language.runLinter");
    expect(rig.notices[0]).toContain("No linter found for TypeScript");
    expect(rig.notices[0]).toContain("ESLint:");
  });

  it("opens the status window, rescans and looks up the active file — running nothing", async () => {
    const rig = await setup();
    expect(rig.ui.isOpen()).toBe(false);
    await rig.commands.execute("language.showStatus");
    expect(rig.ui.isOpen()).toBe(true);
    expect(rig.ipc.languageWorkspaceStatus).toHaveBeenCalled();
    expect(rig.ipc.languageFileStatus).toHaveBeenCalledWith("C:/My Project/src/a.ts");
    expect(rig.terminal.createTerminal).not.toHaveBeenCalled();
    expect(rig.support.getState().file?.language?.name).toBe("TypeScript");
  });

  it("opens the status window with no folder open and without any lookup", async () => {
    const rig = await setup({ root: null });
    await rig.commands.execute("language.showStatus");
    expect(rig.ui.isOpen()).toBe(true);
    expect(rig.ipc.languageWorkspaceStatus).not.toHaveBeenCalled();
  });
});

describe("wireLanguage: Run > Project commands", () => {
  it("runs the chosen project command through the terminal, only when executed", async () => {
    const rig = await setup();
    await rig.support.refresh();
    const project = rig.support.getState().workspace?.projects[0];
    const command = project?.commandStatus[0];
    if (!project || !command) throw new Error("the fixture has no project command");
    expect(rig.terminal.createTerminal).not.toHaveBeenCalled();
    await rig.commands.execute("language.runProjectCommand", project.root, command.id);
    expect(rig.terminal.createTerminal).toHaveBeenCalledTimes(1);
    expect(rig.terminal.write).toHaveBeenCalled();
  });

  it("says so, and runs nothing, when the command no longer exists", async () => {
    const rig = await setup();
    await rig.support.refresh();
    await rig.commands.execute("language.runProjectCommand", "nowhere", "nothing");
    expect(rig.notices).toEqual(["That project command is no longer available."]);
    expect(rig.terminal.createTerminal).not.toHaveBeenCalled();
  });
});
