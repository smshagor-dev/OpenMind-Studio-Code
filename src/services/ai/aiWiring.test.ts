import { describe, expect, it, vi } from "vitest";

import { aiExtension, aiRig, extProviderId, providerInfo } from "../../testUtils/aiFixtures";
import { CommandRegistry } from "../commandRegistry";
import type { EditorTabView } from "../workspaceService";
import { wireAi } from "./aiWiring";

const AI_COMMANDS = [
  "ai.openChat",
  "ai.newChat",
  "ai.explainSelection",
  "ai.suggestFix",
  "ai.generateDocs",
  "ai.explainTerminalError",
  "ai.summarizePreview",
];

type TabKind = EditorTabView["kind"];

function setup(options: Parameters<typeof aiRig>[0] = {}, tabKind: TabKind = "text") {
  const rig = aiRig(options);
  const commands = new CommandRegistry();
  const setAiActions = vi.fn();
  const tab = { id: "d1", docId: "d1", kind: tabKind, title: "math.ts", groupId: "group-1" };
  const state = {
    tabs: [tab],
    activeId: "d1",
    activeGroupId: "group-1",
    groups: [{ id: "group-1", tabs: [tab], activeTabId: "d1", locked: false }],
    weights: [1],
  };
  const selected = {
    text: "let x = 1",
    languageId: "typescript",
    startLine: 1,
    endLine: 1,
    uri: "file:///math.ts",
  };
  const wiring = wireAi({
    ipc: rig.ipc,
    events: rig.events,
    commands,
    settings: rig.settings,
    extensions: { all: () => rig.extensions.list },
    layout: { showView: vi.fn().mockResolvedValue(undefined) },
    editor: {
      selectedText: () => selected,
      insertAtCursor: vi.fn().mockReturnValue(true),
      setAiActions,
      hasEditor: () => true,
    },
    terminal: { activeSelection: () => "" },
    workspace: {
      getState: () => state as never,
      docPath: () => "C:/My Site/math.ts",
    },
    previews: { get: () => undefined },
  });
  // The wiring builds its own provider and chat services; the tests drive those.
  return {
    rig: { ...rig, providers: wiring.providers, chat: wiring.chat },
    commands,
    setAiActions,
    wiring,
  };
}

const registered = (commands: CommandRegistry) => AI_COMMANDS.filter((id) => commands.has(id));

describe("wireAi: AI commands follow the provider", () => {
  it("registers no AI command — only the provider manager — while no provider is enabled", async () => {
    const { rig, commands, setAiActions } = setup();
    await rig.providers.initialize();
    expect(registered(commands)).toEqual([]);
    expect(commands.has("ai.manageProviders")).toBe(true);
    expect(setAiActions).not.toHaveBeenCalledWith(expect.arrayContaining([expect.anything()]));
  });

  it("registers every AI command and the editor actions when a provider is enabled", async () => {
    const { rig, commands, setAiActions } = setup({ providers: [providerInfo()] });
    await rig.providers.initialize();
    expect(registered(commands)).toEqual(AI_COMMANDS);
    const actions = setAiActions.mock.calls.at(-1)?.[0] as {
      command: string;
      inContextMenu: boolean;
    }[];
    expect(actions.map((a) => a.command)).toEqual(
      expect.arrayContaining([
        "ai.explainSelection",
        "ai.suggestFix",
        "ai.generateDocs",
        "ai.openChat",
      ]),
    );
  });

  it("removes the commands and the editor actions when the provider is disabled, and brings them back on enable", async () => {
    const { rig, commands, setAiActions } = setup({ providers: [providerInfo()] });
    await rig.providers.initialize();
    await rig.providers.setEnabled("p1", false);
    expect(registered(commands)).toEqual([]);
    expect(setAiActions).toHaveBeenLastCalledWith([]);
    await rig.providers.setEnabled("p1", true);
    expect(registered(commands)).toEqual(AI_COMMANDS);
  });

  it("removes them when the extension that provides the provider is disabled or uninstalled", async () => {
    const extension = aiExtension();
    const { rig, commands } = setup({ extensions: [extension] });
    await rig.providers.initialize();
    expect(registered(commands)).toEqual(AI_COMMANDS);
    rig.setExtensions([{ ...extension, enabled: false }]);
    expect(registered(commands)).toEqual([]);
    rig.setExtensions([{ ...extension, enabled: true }]);
    expect(registered(commands)).toEqual(AI_COMMANDS);
    rig.setExtensions([]);
    expect(registered(commands)).toEqual([]);
    expect(rig.providers.find(extProviderId(extension))?.available).toBe(false);
  });

  it("keeps the commands while another provider remains", async () => {
    const { rig, commands } = setup({
      providers: [providerInfo(), providerInfo({ id: "p2", name: "Second" })],
    });
    await rig.providers.initialize();
    await rig.providers.setEnabled("p1", false);
    expect(registered(commands)).toEqual(AI_COMMANDS);
    await rig.providers.setEnabled("p2", false);
    expect(registered(commands)).toEqual([]);
  });

  it("does not register them at all when AI is off in settings", async () => {
    const { rig, commands } = setup({
      providers: [providerInfo()],
      settings: { "ai.enabled": false },
    });
    await rig.providers.initialize();
    expect(registered(commands)).toEqual([]);
  });
});

describe("wireAi: the commands say why they can't run", () => {
  it("selected-code commands are enabled on a text tab with a selection", async () => {
    const { rig, commands } = setup({ providers: [providerInfo()] });
    await rig.providers.initialize();
    expect(commands.isEnabled("ai.explainSelection")).toBe(true);
    expect(commands.isEnabled("ai.explainTerminalError")).toBe(false);
    expect(commands.reasonFor("ai.explainTerminalError")).toBe(
      "Select the terminal output to explain first.",
    );
    expect(commands.reasonFor("ai.summarizePreview")).toBe("Open a file preview first.");
  });

  it("selected-code commands are disabled with a reason while a preview tab is active", async () => {
    const { rig, commands } = setup({ providers: [providerInfo()] }, "filePreview");
    await rig.providers.initialize();
    for (const id of ["ai.explainSelection", "ai.suggestFix", "ai.generateDocs"]) {
      expect(commands.isEnabled(id)).toBe(false);
      expect(commands.reasonFor(id)).toBe("A preview is not a text editor. Switch to a text file.");
    }
  });
});
