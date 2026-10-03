import { beforeEach, describe, expect, it, vi } from "vitest";

import { emptyExtensionsSnapshot, testExtension } from "../testUtils/fakeExtensionsIpc";
import { command, rig, type Rig, started } from "../testUtils/extensionRig";
import { ExtensionContributionService } from "./extensionContributionService";
import type { ExtensionHostStatus } from "./extensionsIpc";

describe("ExtensionRegistryService", () => {
  it("starts empty, lists what the backend has and searches the installed list", async () => {
    const empty = rig();
    expect(empty.registry.getState().snapshot).toBeNull();
    await empty.registry.initialize();
    expect(empty.registry.all()).toEqual([]);

    const other = testExtension({ manifest: { ...command.manifest, name: "other", displayName: "Zebra Tools" } });
    const r = await started([command, other]);
    expect(r.registry.all()).toHaveLength(2);
    r.registry.setQuery("zebra");
    expect(r.registry.visible().map((extension) => extension.id)).toEqual([other.id]);
    r.registry.setQuery("nothing");
    expect(r.registry.visible()).toEqual([]);
  });

  it("follows the canonical extension list when it changes (another window, a folder removed by hand)", async () => {
    const r = rig([command]);
    await r.registry.initialize();
    expect(r.registry.all()).toHaveLength(1);
    r.extensionsFeed.push(emptyExtensionsSnapshot());
    expect(r.registry.all()).toHaveLength(0);
  });
});

describe("ExtensionService", () => {
  let r: Rig;
  beforeEach(async () => {
    r = await started([]);
  });

  it("reads the .vsix first and installs only after the user confirms", async () => {
    (r.ipc.extPickVsix as ReturnType<typeof vi.fn>).mockResolvedValue("C:/My Downloads/sample command.vsix");
    (r.ipc.extInspectVsix as ReturnType<typeof vi.fn>).mockResolvedValue(command);
    await r.service.chooseVsix();
    expect(r.service.getState().pendingInstall?.extension.id).toBe(command.id);
    expect(r.ipc.extInstall).not.toHaveBeenCalled();

    r.snapshot.current = emptyExtensionsSnapshot({ extensions: [command] });
    (r.ipc.extInstall as ReturnType<typeof vi.fn>).mockResolvedValue(command);
    await r.service.confirmInstall();
    expect(r.ipc.extInstall).toHaveBeenCalledWith("C:/My Downloads/sample command.vsix", false);
    expect(r.registry.all()).toHaveLength(1);
    expect(r.service.getState().notice).toBe("Installed Sample Command 1.0.0.");
    expect(r.service.getState().selectedId).toBe(command.id);
  });

  it("cancelling the confirmation installs nothing", async () => {
    (r.ipc.extPickVsix as ReturnType<typeof vi.fn>).mockResolvedValue("C:/a.vsix");
    await r.service.chooseVsix();
    r.service.cancelInstall();
    await r.service.confirmInstall();
    expect(r.service.getState().pendingInstall).toBeNull();
    expect(r.ipc.extInstall).not.toHaveBeenCalled();
  });

  it("picking no file does nothing, and a bad file shows the backend's reason", async () => {
    await r.service.chooseVsix();
    expect(r.ipc.extInspectVsix).not.toHaveBeenCalled();
    (r.ipc.extPickVsix as ReturnType<typeof vi.fn>).mockResolvedValue("C:/bad.vsix");
    (r.ipc.extInspectVsix as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("This is not a valid .vsix file: it has no extension/package.json"),
    );
    await r.service.chooseVsix();
    expect(r.service.getState().error).toBe("This is not a valid .vsix file: it has no extension/package.json");
    expect(r.service.getState().pendingInstall).toBeNull();
  });

  it("installing over the same extension asks to replace it", async () => {
    r = await started([command]);
    (r.ipc.extPickVsix as ReturnType<typeof vi.fn>).mockResolvedValue("C:/v2.vsix");
    (r.ipc.extInspectVsix as ReturnType<typeof vi.fn>).mockResolvedValue(command);
    await r.service.chooseVsix();
    expect(r.service.getState().pendingInstall?.replaces?.id).toBe(command.id);
    await r.service.confirmInstall();
    expect(r.ipc.extInstall).toHaveBeenCalledWith("C:/v2.vsix", true);
  });

  it("enables, disables and uninstalls (uninstall only after confirming)", async () => {
    r = await started([command]);
    await r.service.setEnabled(command.id, false);
    expect(r.ipc.extSetEnabled).toHaveBeenCalledWith(command.id, false);
    expect(r.service.getState().notice).toBe("Sample Command is disabled.");

    r.service.requestUninstall(command.id);
    expect(r.ipc.extUninstall).not.toHaveBeenCalled();
    r.service.cancelUninstall();
    expect(r.service.getState().pendingUninstall).toBeNull();
    r.service.requestUninstall(command.id);
    r.snapshot.current = emptyExtensionsSnapshot();
    await r.service.confirmUninstall();
    expect(r.ipc.extUninstall).toHaveBeenCalledWith(command.id);
    expect(r.registry.all()).toEqual([]);
    expect(r.service.getState().notice).toBe("Uninstalled Sample Command.");
  });

  it("every button that can't work says why", async () => {
    expect(r.service.reloadAvailability()).toEqual({
      enabled: false,
      reason: "No installed extension has code to run.",
    });
    r = await started([command]);
    expect(r.service.reloadAvailability().enabled).toBe(true);
  });

  it("reports that Node.js is required when there is no runtime for extension code", async () => {
    r = await started([command], { node: { portable: false, system: null, allowSystem: false } });
    expect(r.service.runtimeProblem()).toBe("Node.js runtime is required for extension host.");
    r = await started([command], { node: { portable: true, system: null, allowSystem: false } });
    expect(r.service.runtimeProblem()).toBeNull();
    r = await started(
      [command],
      { host: { state: "crashed", pid: null, node: null, error: "The extension host stopped unexpectedly." } },
    );
    expect(r.service.runtimeProblem()).toBe("The extension host stopped unexpectedly.");
  });
});

describe("ExtensionHostService", () => {
  it("does not start a host when nothing needs one", async () => {
    const r = await started([testExtension({ runtimeRequirement: null })]);
    expect(await r.host.activateFor({ kind: "startup" })).toEqual([]);
    expect(r.ipc.extHostStart).not.toHaveBeenCalled();
  });

  it("starts lazily with the current settings and folders, then wakes extensions", async () => {
    const r = await started([command]);
    (r.ipc.extActivateFor as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: command.id, ok: true, error: null },
    ]);
    const results = await r.host.activateFor({ kind: "command", command: "sampleCommand.hello" });
    expect(results).toHaveLength(1);
    expect(r.ipc.extHostStart).toHaveBeenCalledWith({
      configuration: { "sampleConfig.greeting": "Hello" },
      workspaceFolders: [{ path: "C:/My Site", name: "My Site" }],
      documents: [],
      activeEditor: null,
    });
    expect(r.host.isRunning()).toBe(true);
  });

  it("shows an activation failure as an error and keeps the app alive", async () => {
    const r = await started([command]);
    (r.ipc.extActivateFor as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: command.id, ok: false, error: "Activating a.b failed: boom" },
    ]);
    await r.host.activateFor({ kind: "startup" });
    expect(r.errors).toContain("Activating a.b failed: boom");
    await expect(r.host.executeCommand("sampleCommand.hello")).rejects.toThrow("Activating a.b failed: boom");
  });

  it("tells the user why the host can't start", async () => {
    const r = await started([command]);
    (r.ipc.extHostStart as ReturnType<typeof vi.fn>).mockRejectedValue("Node.js runtime is required for extension host.");
    expect(await r.host.start()).toBe(false);
    expect(r.errors).toContain("Node.js runtime is required for extension host.");
    expect(r.host.isRunning()).toBe(false);
  });

  it("answers the host's questions through the bridge and reports failures back", async () => {
    const r = await started([command]);
    let ask: (request: { id: unknown; method: string; params: unknown }) => void = () => undefined;
    vi.mocked(r.ipc.onExtHostRequest).mockImplementation((handler) => {
      ask = handler;
      return Promise.resolve(() => undefined);
    });
    await r.host.initialize();
    ask({ id: 7, method: "workspace/getLanguages", params: {} });
    await vi.waitFor(() => {
      expect(r.ipc.extHostRespond).toHaveBeenCalledWith(7, ["plaintext"], null);
    });
    ask({ id: 8, method: "fs/readEverything", params: {} });
    await vi.waitFor(() => {
      expect(r.ipc.extHostRespond).toHaveBeenCalledWith(8, null, "Not an allowed extension host request: fs/readEverything");
    });
  });

  it("shows a crashed host as stopped and drops what it registered", async () => {
    const r = await started([command]);
    let state: (status: ExtensionHostStatus) => void = () => undefined;
    vi.mocked(r.ipc.onExtHostState).mockImplementation((handler) => {
      state = handler;
      return Promise.resolve(() => undefined);
    });
    await r.host.initialize();
    r.bridge.handleNotification("commands/registered", { command: "x.y" });
    expect(r.bridge.registeredCommands().has("x.y")).toBe(true);
    state({ state: "crashed", pid: null, node: null, error: "The extension host stopped unexpectedly." });
    expect(r.host.status().state).toBe("crashed");
    expect(r.bridge.registeredCommands().size).toBe(0);
  });
});

describe("the API bridge", () => {
  it("routes an extension's output and messages to Output and the prompt list", async () => {
    const r = await started([command]);
    r.bridge.handleNotification("log/output", { extension: "a.b", channel: "Sample Command", text: "ran" });
    expect(r.output.getLines("Sample Command")).toEqual(["ran"]);
    r.bridge.handleNotification("log/output", { extension: "a.b", channel: "console", text: "[log] hi" });
    expect(r.output.getLines("Extension Host")).toEqual(["[a.b] [log] hi"]);
    r.bridge.handleNotification("log/output", { extension: "a.b", channel: "Git", text: "mine" });
    expect(r.output.getLines("Git (extension)")).toEqual(["mine"]);

    r.bridge.handleNotification("ui/showMessage", {
      extension: "a.b",
      severity: "info",
      message: "Hello from the sample command extension",
      items: [],
    });
    expect(r.prompts.getState().messages[0]?.message).toBe("Hello from the sample command extension");
  });

  it("returns the button a user clicked to the extension", async () => {
    const r = await started([]);
    const answer = r.bridge.handleRequest("ui/showMessage", {
      extension: "a.b",
      severity: "warning",
      message: "Sure?",
      items: ["Yes", "No"],
    });
    const id = r.prompts.getState().messages[0]?.id ?? -1;
    r.prompts.answer(id, "Yes");
    await expect(answer).resolves.toBe("Yes");
  });

  it("quick picks and input boxes wait for the user and can be cancelled", async () => {
    const r = await started([]);
    const pick = r.bridge.handleRequest("ui/showQuickPick", { extension: "a.b", items: [{ label: "One" }, { label: "Two" }] });
    const input = r.bridge.handleRequest("ui/showInputBox", { extension: "a.b", prompt: "Name?" });
    expect(r.prompts.getState().dialog?.kind).toBe("quickPick");
    r.prompts.answer(r.prompts.getState().dialog?.id ?? -1, 1);
    await expect(pick).resolves.toBe(1);
    expect(r.prompts.getState().dialog?.kind).toBe("input");
    r.prompts.dismiss(r.prompts.getState().dialog?.id ?? -1);
    await expect(input).resolves.toBeNull();
  });

  it("refuses anything that is not on its list", async () => {
    const r = await started([]);
    await expect(r.bridge.handleRequest("terminal/run", { command: "del *" })).rejects.toThrow("Not an allowed");
  });
});

describe("ExtensionContributionService", () => {
  it("puts contributed commands in the command registry, blocked with a reason when there is no Node.js", async () => {
    const r = await started([command], { node: { portable: false, system: null, allowSystem: false } });
    expect(r.commands.has("sampleCommand.hello")).toBe(true);
    expect(r.commands.isEnabled("sampleCommand.hello")).toBe(false);
    expect(r.commands.reasonFor("sampleCommand.hello")).toBe("Node.js runtime is required for extension host.");
  });

  it("running a contributed command wakes its extension, then runs it in the host", async () => {
    const r = await started([command], { node: { portable: true, system: null, allowSystem: false } });
    (r.ipc.extActivateFor as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: command.id, ok: true, error: null }]);
    (r.ipc.extHostRequest as ReturnType<typeof vi.fn>).mockResolvedValue("hello");
    expect(r.commands.isEnabled("sampleCommand.hello")).toBe(true);
    await r.commands.execute("sampleCommand.hello", "arg");
    expect(r.ipc.extActivateFor).toHaveBeenCalledWith({ kind: "command", command: "sampleCommand.hello" });
    expect(r.ipc.extHostRequest).toHaveBeenCalledWith("host/executeCommand", {
      command: "sampleCommand.hello",
      args: ["arg"],
    });
  });

  it("a command stops being available when its extension is disabled or removed", async () => {
    const r = await started([command]);
    expect(r.commands.has("sampleCommand.hello")).toBe(true);
    r.snapshot.current = emptyExtensionsSnapshot({ extensions: [{ ...command, enabled: false }] });
    await r.registry.refresh();
    expect(r.commands.has("sampleCommand.hello")).toBe(false);
    r.snapshot.current = emptyExtensionsSnapshot({ extensions: [command] });
    await r.registry.refresh();
    expect(r.commands.has("sampleCommand.hello")).toBe(true);
  });

  it("a built-in command keeps its id", async () => {
    const r = rig([command]);
    r.commands.register("sampleCommand.hello", () => undefined);
    await r.registry.initialize();
    r.contributions.initialize();
    expect(r.commands.list().filter((id) => id === "sampleCommand.hello")).toHaveLength(1);
  });

  it("offers the palette and context-menu actions, the shortcut and the explorer item", async () => {
    const r = await started([command]);
    expect(r.editorActions).toEqual([
      { command: "sampleCommand.hello", label: "Sample: Say Hello", inContextMenu: true },
    ]);
    expect(r.contributions.keybindings()).toEqual([
      { key: "Ctrl+Alt+H", command: "sampleCommand.hello", owner: "app", extension: command.id },
    ]);
    expect(r.contributions.explorerItems()).toEqual([
      { command: "sampleCommand.hello", label: "Sample: Say Hello", group: "z" },
    ]);
    expect(r.contributions.commandInfos()).toEqual([
      { id: "sampleCommand.hello", title: "Say Hello", category: "Sample" },
    ]);
  });

  it("hides a command from the palette when the extension says when: false", async () => {
    const hidden = testExtension({
      manifest: {
        ...command.manifest,
        contributes: {
          ...command.manifest.contributes,
          menus: { commandPalette: [{ command: "sampleCommand.hello", when: "false", group: null }] },
        },
      },
    });
    const r = await started([hidden]);
    expect(r.editorActions).toEqual([]);
    expect(r.commands.has("sampleCommand.hello")).toBe(true);
  });

  it("wakes extensions when a file of their language opens", async () => {
    const lang = testExtension({ activationEvents: ["onLanguage:php"] });
    const r = await started([lang], { node: { portable: true, system: null, allowSystem: false } });
    r.contributions.languageOpened("python");
    expect(r.ipc.extActivateFor).not.toHaveBeenCalled();
    r.contributions.languageOpened("php");
    await vi.waitFor(() => {
      expect(r.ipc.extActivateFor).toHaveBeenCalledWith({ kind: "language", language: "php" });
    });
  });

  it("says which contributed language a file name belongs to (by extension or exact name), only while enabled", async () => {
    const lang = testExtension({
      manifest: {
        ...command.manifest,
        contributes: {
          ...command.manifest.contributes,
          languages: [{ id: "openmind-sample", extensions: [".omsample"], filenames: ["Samplefile"], aliases: [] }],
        },
      },
    });
    const r = await started([lang]);
    expect(r.contributions.languageForPath("C:/My Site/a.OMSAMPLE")).toBe("openmind-sample");
    expect(r.contributions.languageForPath("C:\\My Site\\Samplefile")).toBe("openmind-sample");
    expect(r.contributions.languageForPath("C:/My Site/readme.txt")).toBeNull();
    r.snapshot.current = emptyExtensionsSnapshot({ extensions: [{ ...lang, enabled: false }] });
    await r.registry.refresh();
    expect(r.contributions.languageForPath("C:/My Site/a.omsample")).toBeNull();
  });

  it("loads a contributed theme from the extension's own file", async () => {
    const themed = testExtension({
      manifest: {
        ...command.manifest,
        contributes: {
          ...command.manifest.contributes,
          themes: [{ label: "Night", uiTheme: "vs-dark", path: "./themes/night.json" }],
        },
      },
    });
    const r = await started([themed]);
    (r.ipc.extReadFile as ReturnType<typeof vi.fn>).mockResolvedValue('{ "colors": { "editor.background": "#101820" } }');
    expect(r.contributions.themes()).toEqual([
      { value: `extension:${themed.id}/Night`, label: "Night", extension: "Sample Command" },
    ]);
    const theme = await r.contributions.load(`extension:${themed.id}/Night`);
    expect(theme?.monaco.colors["editor.background"]).toBe("#101820");
    expect(r.ipc.extReadFile).toHaveBeenCalledWith(themed.id, "./themes/night.json");
    expect(await r.contributions.load("extension:nobody.none/Missing")).toBeNull();
  });

  it("registers contributed languages and loads snippets for them", async () => {
    const lang = testExtension({
      runtimeRequirement: null,
      manifest: {
        ...command.manifest,
        main: null,
        contributes: {
          ...command.manifest.contributes,
          languages: [{ id: "openmind-sample", extensions: [".omsample"], filenames: [], aliases: ["OpenMind Sample"] }],
          snippets: [{ language: "openmind-sample", path: "./snippets.json" }],
        },
      },
    });
    const r = rig([lang]);
    const registerLanguage = vi.fn();
    const registerSnippets = vi.fn().mockReturnValue(() => undefined);
    const contributions = new ExtensionContributionService({
      ipc: r.ipc,
      events: r.events,
      registry: r.registry,
      host: r.host,
      commands: r.commands,
      binding: { registerLanguage, registerSnippets, setEditorActions: vi.fn() },
      languageOf: () => "plaintext",
    });
    (r.ipc.extReadFile as ReturnType<typeof vi.fn>).mockResolvedValue(
      '{ "Block": { "prefix": "omblock", "body": "block $1" } }',
    );
    await r.registry.initialize();
    contributions.initialize();
    expect(registerLanguage).toHaveBeenCalledWith(expect.objectContaining({ id: "openmind-sample", extensions: [".omsample"] }));
    await vi.waitFor(() => {
      expect(registerSnippets).toHaveBeenCalledWith("openmind-sample", [
        expect.objectContaining({ prefixes: ["omblock"], body: "block $1" }),
      ]);
    });
  });
});
