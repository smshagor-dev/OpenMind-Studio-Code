import { describe, expect, it, vi } from "vitest";

import { CommandRegistry } from "./commandRegistry";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { IntegrationStatus } from "./ipc";
import {
  changeDetails,
  nothingToDo,
  registerShellIntegrationCommands,
  SHELL_INTEGRATION_COMMANDS,
} from "./shellIntegrationCommands";

const STATUS: IntegrationStatus = {
  exe: "D:\\Portable\\OpenMind Studio\\OpenMindStudio.exe",
  binDir: "D:\\Portable\\OpenMind Studio\\bin",
  pathPresent: false,
  pathAdded: false,
  explorerThisCopy: false,
  explorerOtherCopy: null,
};

function rig(status: IntegrationStatus = STATUS, answer: string | null = "Apply") {
  const commands = new CommandRegistry();
  const events = new EventBus<AppEvents>();
  const notices: string[] = [];
  const errors: string[] = [];
  events.on("appNotice", ({ message }) => notices.push(message));
  events.on("appError", ({ message }) => errors.push(message));
  const ipc = {
    integrationStatus: vi.fn().mockResolvedValue(status),
    integrationApply: vi.fn().mockResolvedValue("Added D:\\Portable\\OpenMind Studio\\bin to your PATH."),
  };
  const setAppActions = vi.fn();
  const confirm = vi.fn().mockResolvedValue(answer);
  registerShellIntegrationCommands({ commands, events, ipc, editor: { setAppActions }, confirm });
  return { commands, ipc, confirm, setAppActions, notices, errors };
}

describe("shell integration commands", () => {
  it("are in the palette under their own owner, one per action", () => {
    const r = rig();
    const [actions, owner] = r.setAppActions.mock.calls[0] as [{ command: string; label: string }[], string];
    expect(owner).toBe("integration");
    expect(actions.map((a) => a.command)).toEqual(SHELL_INTEGRATION_COMMANDS.map(([id]) => id));
    expect(actions[0]?.label).toBe("Shell Integration: Add OpenMind Studio to PATH (this user)");
  });

  it("change nothing until the user confirms, then show what the backend did", async () => {
    const cancelled = rig(STATUS, null);
    await cancelled.commands.execute("integration.addToPath");
    expect(cancelled.confirm).toHaveBeenCalledTimes(1);
    expect(cancelled.ipc.integrationApply).not.toHaveBeenCalled();

    const r = rig();
    await r.commands.execute("integration.addToPath");
    const request = r.confirm.mock.calls[0]?.[0] as { details: { value: string }[]; notes: string[] };
    expect(request.details.map((d) => d.value)).toEqual(["HKCU\\Environment\\Path", STATUS.binDir]);
    expect(request.notes.join(" ")).toContain("new one");
    expect(r.ipc.integrationApply).toHaveBeenCalledWith("add-path");
    expect(r.notices).toEqual(["Added D:\\Portable\\OpenMind Studio\\bin to your PATH."]);
  });

  it("say so instead of asking when there is nothing to do", async () => {
    const r = rig({ ...STATUS, pathPresent: true });
    await r.commands.execute("integration.addToPath");
    await r.commands.execute("integration.removeFromPath");
    await r.commands.execute("integration.unregisterExplorer");
    expect(r.confirm).not.toHaveBeenCalled();
    expect(r.ipc.integrationApply).not.toHaveBeenCalled();
    expect(r.notices).toHaveLength(3);
    expect(nothingToDo("remove-path", { ...STATUS, pathAdded: true })).toBeNull();
  });

  it("warn when the Explorer entries run another copy, and report failures", async () => {
    const r = rig({ ...STATUS, explorerOtherCopy: '"C:\\Other\\OpenMindStudio.exe" "%V"' });
    await r.commands.execute("integration.registerExplorer");
    const request = r.confirm.mock.calls[0]?.[0] as { notes: string[] };
    expect(request.notes.join(" ")).toContain("C:\\Other\\OpenMindStudio.exe");
    expect(r.ipc.integrationApply).toHaveBeenCalledWith("add-explorer");
    expect(changeDetails("add-explorer", STATUS)[1]?.value).toBe(STATUS.exe);

    const failing = rig();
    failing.ipc.integrationStatus.mockRejectedValue(new Error("access denied"));
    await failing.commands.execute("integration.addToPath");
    expect(failing.errors[0]).toContain("access denied");
  });
});
