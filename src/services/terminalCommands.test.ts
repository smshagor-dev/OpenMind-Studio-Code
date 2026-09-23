import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { CommandRegistry } from "./commandRegistry";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import { KeybindingService } from "./keybindings";
import { buildMenuBar } from "./menus";
import { registerTerminalCommands } from "./terminalCommands";
import { TerminalService } from "./terminalService";

describe("terminal commands", () => {
  let commands: CommandRegistry;
  let terminal: TerminalService;
  let ipc: ReturnType<typeof createFakeIpc>;

  beforeEach(async () => {
    ipc = createFakeIpc({
      terminalListShells: vi.fn().mockResolvedValue([
        { kind: "powerShell", label: "PowerShell", available: true },
        { kind: "cmd", label: "Command Prompt", available: true },
      ]),
      terminalCreate: vi.fn().mockResolvedValue({ id: "t1", shell: "cmd", cwd: "C:/proj", pid: 1 }),
    });
    terminal = new TerminalService(ipc, new EventBus<AppEvents>(), () => "C:/proj");
    await terminal.initialize();
    commands = new CommandRegistry();
    registerTerminalCommands(commands, terminal);
  });

  it("terminal.toggle opens the panel and reports its checked state", async () => {
    expect(commands.isChecked("terminal.toggle")).toBe(false);

    await commands.execute("terminal.toggle");

    expect(commands.isChecked("terminal.toggle")).toBe(true);
    expect(ipc.terminalCreate).toHaveBeenCalledTimes(1);
  });

  it("terminal.new creates a terminal, honouring the shell chosen in the selector", async () => {
    await commands.execute("terminal.new", "cmd");

    expect(ipc.terminalCreate).toHaveBeenCalledWith("cmd", "C:/proj", 80, 24);
  });

  it("terminal.new ignores an argument that isn't a known shell", async () => {
    await commands.execute("terminal.new", "definitely-not-a-shell");

    expect(ipc.terminalCreate).toHaveBeenCalledWith(null, "C:/proj", 80, 24);
  });

  it("clear and kill are disabled until a terminal exists, then act on the active one", async () => {
    expect(commands.isEnabled("terminal.clear")).toBe(false);
    expect(commands.isEnabled("terminal.kill")).toBe(false);

    await commands.execute("terminal.new");
    expect(commands.isEnabled("terminal.kill")).toBe(true);

    await commands.execute("terminal.kill");
    expect(ipc.terminalClose).toHaveBeenCalledWith("t1");
    expect(commands.isEnabled("terminal.kill")).toBe(false);
  });

  it("does not register a split command, so its menu entry stays disabled", () => {
    expect(commands.isEnabled("terminal.split")).toBe(false);
  });

  it("Ctrl+` toggles and Ctrl+Shift+` creates a terminal through the keybinding service", () => {
    const keybindings = new KeybindingService(commands);
    const base = { altKey: false, metaKey: false, code: "Backquote" };

    expect(keybindings.resolve({ ...base, ctrlKey: true, shiftKey: false })).toBe(
      "terminal.toggle",
    );
    expect(keybindings.resolve({ ...base, ctrlKey: true, shiftKey: true })).toBe("terminal.new");
    expect(keybindings.labelFor("terminal.toggle")).toBe("Ctrl+`");
  });

  it("the Terminal menu lists New/Clear/Kill and each maps to a registered command", () => {
    const menu = buildMenuBar({ folders: [], files: [] }).find(
      (entry) => entry.label === "Terminal",
    );
    const ids = JSON.stringify(menu);

    for (const id of ["terminal.new", "terminal.clear", "terminal.kill"]) {
      expect(ids).toContain(id);
      expect(commands.list()).toContain(id);
    }
  });
});
