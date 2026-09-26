import { describe, expect, it, vi } from "vitest";

import { commandStatus, formatOption, languageRig } from "../../testUtils/languageFixtures";

describe("ProjectCommandService: what a command says about itself", () => {
  it("is enabled when its tools were found, and disabled with the reason when not", () => {
    const { projects } = languageRig();
    expect(projects.availability(commandStatus())).toEqual({ enabled: true, reason: null });
    const missing = commandStatus({
      available: false,
      reason: "Cargo not found. Install Rust (rustup) — OpenMind doesn't install it.",
      missing: ["cargo"],
    });
    expect(projects.availability(missing)).toEqual({ enabled: false, reason: missing.reason });
    expect(projects.availability(commandStatus({ available: false, reason: null }))).toEqual({
      enabled: false,
      reason: "This command isn't available.",
    });
  });

  it("describes the command line, its folder, downloads and note", () => {
    const { projects } = languageRig();
    expect(projects.describe(commandStatus())).toBe("pnpm run dev");
    expect(
      projects.describe(
        commandStatus({
          cwd: "apps/web",
          network: true,
          note: "Downloads the project's packages.",
        }),
      ),
    ).toBe(
      "pnpm run dev — in apps/web — may download packages — Downloads the project's packages.",
    );
  });
});

describe("ProjectCommandService: running a command", () => {
  it("opens a terminal in the project's folder, types the command and shows the panel — only when asked", async () => {
    const rig = languageRig();
    expect(rig.terminal.createTerminal).not.toHaveBeenCalled();
    const ran = await rig.projects.runCommand(commandStatus({ cwd: "apps/web" }));
    expect(ran).toBe(true);
    expect(rig.terminal.createTerminal).toHaveBeenCalledWith(undefined, "C:/My Project/apps/web");
    expect(rig.ipc.languageTerminalLine).toHaveBeenCalledWith(["pnpm", "run", "dev"], "powerShell");
    expect(rig.terminal.write).toHaveBeenCalledWith("t1", "pnpm run dev\r");
    expect(rig.terminal.setActive).toHaveBeenCalledWith("t1");
    expect(rig.showTerminal).toHaveBeenCalled();
  });

  it("runs in the workspace folder itself for a top-level project (a path with spaces)", async () => {
    const rig = languageRig();
    await rig.projects.runCommand(commandStatus({ cwd: "" }));
    expect(rig.terminal.createTerminal).toHaveBeenCalledWith(undefined, "C:/My Project");
  });

  it("does nothing but explain when the command is disabled", async () => {
    const rig = languageRig();
    const ran = await rig.projects.runCommand(
      commandStatus({ available: false, reason: "iOS builds require macOS and Xcode." }),
    );
    expect(ran).toBe(false);
    expect(rig.terminal.createTerminal).not.toHaveBeenCalled();
    expect(rig.notices).toEqual(["iOS builds require macOS and Xcode."]);
  });

  it("refuses without an open folder and in a WSL terminal, and reports a line that can't be typed safely", async () => {
    const noFolder = languageRig({ hasWorkspace: false });
    expect(await noFolder.projects.runCommand(commandStatus())).toBe(false);
    expect(noFolder.notices).toEqual(["Open a folder first."]);

    const wsl = languageRig();
    wsl.terminal.getState.mockReturnValue({
      sessions: [{ id: "t1", shell: "wsl", title: "WSL", cwd: "", exited: false, exitCode: null }],
      activeId: "t1",
      shells: [],
      lastShell: null,
    });
    expect(await wsl.projects.runCommand(commandStatus())).toBe(false);
    expect(wsl.notices[0]).toContain("WSL terminal");
    expect(wsl.terminal.write).not.toHaveBeenCalled();

    const unsafe = languageRig();
    const errors: string[] = [];
    unsafe.events.on("appError", ({ message }) => {
      errors.push(message);
    });
    vi.mocked(unsafe.ipc.languageTerminalLine).mockRejectedValueOnce(
      new Error("an argument contains a line break"),
    );
    expect(await unsafe.projects.runCommand(commandStatus())).toBe(false);
    expect(errors[0]).toContain("line break");
    expect(unsafe.terminal.write).not.toHaveBeenCalled();
  });

  it("stops quietly when the terminal couldn't be created", async () => {
    const rig = languageRig();
    rig.terminal.createTerminal.mockResolvedValue(null);
    expect(await rig.projects.runCommand(commandStatus())).toBe(false);
    expect(rig.terminal.write).not.toHaveBeenCalled();
  });
});

describe("ProjectCommandService: formatters and linters", () => {
  it("types the resolved tool path and arguments, quoted by the backend", async () => {
    const rig = languageRig();
    expect(await rig.projects.runTool(formatOption(), "apps/web")).toBe(true);
    expect(rig.terminal.createTerminal).toHaveBeenCalledWith(undefined, "C:/My Project/apps/web");
    expect(rig.ipc.languageTerminalLine).toHaveBeenCalledWith(formatOption().argv, "powerShell");
  });

  it("says a missing tool was not found, with what to do", async () => {
    const rig = languageRig();
    const missing = formatOption({
      found: null,
      argv: [],
      name: "Black",
      hint: "Install Black (`pip install black`).",
    });
    expect(await rig.projects.runTool(missing, "")).toBe(false);
    expect(rig.notices).toEqual(["Black was not found. Install Black (`pip install black`)."]);
    expect(rig.terminal.createTerminal).not.toHaveBeenCalled();
  });
});
