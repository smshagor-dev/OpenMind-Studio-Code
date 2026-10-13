import { describe, expect, it, vi } from "vitest";

import { CommandRegistry } from "./commandRegistry";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { IntegrationStatus } from "./ipc";
import {
  changeDetails,
  DESKTOP_SHORTCUT_COMMANDS,
  nothingToDo,
  parseCheckReport,
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

const REPORT = [
  "OpenMind Studio deployment check",
  "  Program:            Z:\\OpenMind Studio\\OpenMindStudio.exe",
  "  Network path:       \\\\fs01\\apps\\OpenMind Studio\\OpenMindStudio.exe",
  "  Desktop shortcut:   none on your Desktop",
  "",
  "What to do:",
  "  - To get a Desktop shortcut, run Create Desktop Shortcut.",
].join("\r\n");

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
    integrationDesktopShortcut: vi.fn().mockResolvedValue("Created C:\\Users\\s\\Desktop\\OpenMind Studio.lnk"),
    integrationCheck: vi.fn().mockResolvedValue(REPORT),
    clipboardWriteText: vi.fn().mockResolvedValue(undefined),
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
    expect(actions.map((a) => a.command)).toEqual([
      ...SHELL_INTEGRATION_COMMANDS.map(([id]) => id),
      ...DESKTOP_SHORTCUT_COMMANDS.map(([id]) => id),
    ]);
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

  it("create or repair the Desktop shortcut without asking, and pass on the manual steps when Windows refuses", async () => {
    const r = rig();
    await r.commands.execute("integration.desktopShortcut");
    expect(r.confirm).not.toHaveBeenCalled();
    expect(r.notices[0]).toContain("OpenMind Studio.lnk");
    r.ipc.integrationDesktopShortcut.mockRejectedValue("access denied. To add it by hand: right-click the Desktop");
    await r.commands.execute("integration.desktopShortcut");
    expect(r.errors[0]).toContain("To add it by hand");
  });

  it("show the installation check as facts and advice, and copy the report on request", async () => {
    expect(parseCheckReport(REPORT)).toEqual({
      details: [
        { label: "Program", value: "Z:\\OpenMind Studio\\OpenMindStudio.exe" },
        { label: "Network path", value: "\\\\fs01\\apps\\OpenMind Studio\\OpenMindStudio.exe" },
        { label: "Desktop shortcut", value: "none on your Desktop" },
      ],
      notes: ["To get a Desktop shortcut, run Create Desktop Shortcut."],
    });
    const r = rig(STATUS, "Copy Report");
    await r.commands.execute("integration.checkInstallation");
    const request = r.confirm.mock.calls[0]?.[0] as { details: unknown[]; buttons: string[] };
    expect(request.details).toHaveLength(3);
    expect(request.buttons).toEqual(["Copy Report"]);
    expect(r.ipc.clipboardWriteText).toHaveBeenCalledWith(REPORT);
  });
});
