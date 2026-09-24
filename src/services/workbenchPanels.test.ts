import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { CommandRegistry } from "./commandRegistry";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import { LayoutService } from "./layoutService";
import { MAX_OUTPUT_LINES, OutputService, stamped } from "./outputService";
import { PANEL_MAX_HEIGHT, PANEL_MIN_HEIGHT, PanelService } from "./panelService";
import { PortsService } from "./portsService";
import { registerViewCommands } from "./viewCommands";

describe("OutputService", () => {
  it("starts with the standard channels and the first one selected", () => {
    const output = new OutputService();

    expect(output.getState().channels).toEqual([
      "OpenMind Studio",
      "Runtime Manager",
      "Terminal",
      "Search",
      "Run Code",
    ]);
    expect(output.getState().selected).toBe("OpenMind Studio");
  });

  it("appends lines, splitting on newlines, and notifies", () => {
    const output = new OutputService();
    const listener = vi.fn();
    output.subscribe(listener);

    output.append("Terminal", "one\r\ntwo\n");
    output.append("Terminal", "three");

    expect(output.getLines("Terminal")).toEqual(["one", "two", "three"]);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(output.getLines("Search")).toEqual([]);
  });

  it("appending to an unknown channel creates it", () => {
    const output = new OutputService();

    output.append("Python", "hello");

    expect(output.getState().channels).toContain("Python");
    expect(output.getLines("Python")).toEqual(["hello"]);
  });

  it("selects only channels that exist, and clears one channel without touching the others", () => {
    const output = new OutputService();
    output.append("Terminal", "t");
    output.append("Search", "s");

    output.select("Search");
    output.select("Nope");
    output.clear("Terminal");

    expect(output.getState().selected).toBe("Search");
    expect(output.getLines("Terminal")).toEqual([]);
    expect(output.getLines("Search")).toEqual(["s"]);
  });

  it("returns a new lines array only when a channel changes", () => {
    const output = new OutputService();
    output.append("Terminal", "a");
    const before = output.getLines("Terminal");

    output.append("Search", "x");

    expect(output.getLines("Terminal")).toBe(before);
  });

  it("keeps only the newest lines once a channel is over its limit", () => {
    const output = new OutputService();
    for (let i = 0; i < MAX_OUTPUT_LINES + 10; i += 1)
      output.append("Terminal", `line ${String(i)}`);

    const lines = output.getLines("Terminal");

    expect(lines).toHaveLength(MAX_OUTPUT_LINES);
    expect(lines[lines.length - 1]).toBe(`line ${String(MAX_OUTPUT_LINES + 9)}`);
  });

  it("stamped formats a clock time prefix", () => {
    expect(stamped("hi", new Date(2026, 0, 2, 3, 4, 5))).toBe("[03:04:05] hi");
  });
});

describe("PortsService", () => {
  let ipc: ReturnType<typeof createFakeIpc>;
  let ports: PortsService;

  beforeEach(() => {
    ipc = createFakeIpc();
    ports = new PortsService(ipc, new EventBus<AppEvents>());
  });

  it("starts empty", () => {
    expect(ports.list()).toEqual([]);
  });

  it("registers, lists in port order, and re-registering updates rather than duplicates", () => {
    ports.register({ port: 8080, label: "API", source: "php" });
    ports.register({ port: 3000, label: "Web", source: "node", url: "http://localhost:3000" });
    ports.register({ port: 8080, label: "API v2", source: "php" });

    expect(ports.list().map((p) => [p.port, p.label])).toEqual([
      [3000, "Web"],
      [8080, "API v2"],
    ]);
  });

  it("rejects ports outside 1-65535", () => {
    for (const port of [0, 65536, 1.5, Number.NaN, -1]) {
      expect(() => ports.register({ port, label: "x", source: "s" }), String(port)).toThrow(
        RangeError,
      );
    }
  });

  it("unregisters by id and by source", () => {
    const id = ports.register({ port: 1000, label: "a", source: "one" });
    ports.register({ port: 2000, label: "b", source: "two" });
    ports.register({ port: 3000, label: "c", source: "two" });

    expect(ports.unregister(id)).toBe(true);
    expect(ports.unregister(id)).toBe(false);
    ports.unregisterSource("two");

    expect(ports.list()).toEqual([]);
  });

  it("opens in the browser only when the entry has a URL", async () => {
    const withUrl = ports.register({
      port: 3000,
      label: "Web",
      source: "n",
      url: "http://localhost:3000",
    });
    const without = ports.register({ port: 4000, label: "Raw", source: "n" });

    expect(ports.canOpenInBrowser(withUrl)).toBe(true);
    expect(ports.canOpenInBrowser(without)).toBe(false);
    expect(await ports.openInBrowser(withUrl)).toBe(true);
    expect(await ports.openInBrowser(without)).toBe(false);
    expect(ipc.openExternalUrl).toHaveBeenCalledTimes(1);
    expect(ipc.openExternalUrl).toHaveBeenCalledWith("http://localhost:3000");
  });

  it("a failing browser launch surfaces as an error, not an exception", async () => {
    const events = new EventBus<AppEvents>();
    const errors: string[] = [];
    events.on("appError", ({ message }) => errors.push(message));
    ports = new PortsService(
      createFakeIpc({ openExternalUrl: vi.fn().mockRejectedValue("no browser") }),
      events,
    );
    const id = ports.register({
      port: 3000,
      label: "Web",
      source: "n",
      url: "http://localhost:3000",
    });

    expect(await ports.openInBrowser(id)).toBe(false);
    expect(errors).toHaveLength(1);
  });
});

describe("PanelService", () => {
  it("starts hidden on the Terminal tab", () => {
    const panel = new PanelService(createFakeIpc());

    expect(panel.getState()).toMatchObject({ visible: false, activeTab: "terminal" });
  });

  it("show, hide and toggle work, and setActiveTab shows the panel", async () => {
    const panel = new PanelService(createFakeIpc());

    await panel.show("output");
    expect(panel.getState()).toMatchObject({ visible: true, activeTab: "output" });
    await panel.toggle();
    expect(panel.getState().visible).toBe(false);
    await panel.toggle();
    expect(panel.getState()).toMatchObject({ visible: true, activeTab: "output" });
    await panel.hide();
    await panel.setActiveTab("ports");
    expect(panel.getState()).toMatchObject({ visible: true, activeTab: "ports" });
  });

  it("persists its state and restores it", async () => {
    const ipc = createFakeIpc();
    const panel = new PanelService(ipc);
    await panel.show("problems");
    panel.previewHeight(400);
    await panel.commitHeight();
    const saved = vi.mocked(ipc.settingsSet).mock.calls.at(-1)?.[1] ?? "";

    const restored = new PanelService(
      createFakeIpc({ settingsGet: vi.fn().mockResolvedValue(saved) }),
    );
    await restored.initialize();

    expect(restored.getState()).toEqual({ visible: true, height: 400, activeTab: "problems" });
  });

  it("clamps the height", () => {
    const panel = new PanelService(createFakeIpc());

    panel.previewHeight(1);
    expect(panel.getState().height).toBe(PANEL_MIN_HEIGHT);
    panel.previewHeight(99999);
    expect(panel.getState().height).toBe(PANEL_MAX_HEIGHT);
  });

  it("ignores garbage in storage and an unknown tab name", async () => {
    const garbage = new PanelService(
      createFakeIpc({ settingsGet: vi.fn().mockResolvedValue("{nope") }),
    );
    await garbage.initialize();
    expect(garbage.getState().activeTab).toBe("terminal");

    const odd = new PanelService(
      createFakeIpc({
        settingsGet: vi.fn().mockResolvedValue('{"visible":true,"activeTab":"bogus"}'),
      }),
    );
    await odd.initialize();
    expect(odd.getState()).toMatchObject({ visible: true, activeTab: "terminal" });
  });
});

describe("view commands", () => {
  let commands: CommandRegistry;
  let layout: LayoutService;
  let panel: PanelService;
  let output: OutputService;
  let events: EventBus<AppEvents>;
  const search = {
    clear: vi.fn(),
    cancel: vi.fn(),
    getState: () => ({ status: "idle" }),
  };

  beforeEach(() => {
    const ipc = createFakeIpc();
    commands = new CommandRegistry();
    layout = new LayoutService(ipc);
    panel = new PanelService(ipc);
    output = new OutputService();
    events = new EventBus<AppEvents>();
    registerViewCommands({
      commands,
      events,
      layout,
      panel,
      output,
      search: search as never,
    });
  });

  it("each side view command shows that view and reveals a hidden side bar", async () => {
    await layout.setSidebarVisible(false);

    for (const [id, view] of [
      ["view.showSearch", "search"],
      ["view.showSourceControl", "scm"],
      ["view.showRun", "debug"],
      ["view.showExtensions", "extensions"],
      ["view.showExplorer", "explorer"],
    ] as const) {
      await commands.execute(id);
      expect(layout.getState(), id).toMatchObject({ activeView: view, sidebarVisible: true });
    }
  });

  it("view.showExplorer also asks the explorer to take focus", async () => {
    const focus = vi.fn();
    events.on("focusExplorer", focus);

    await commands.execute("view.showExplorer");

    expect(focus).toHaveBeenCalled();
  });

  it("search.findInFiles shows Search and asks its input to take focus", async () => {
    const focus = vi.fn();
    events.on("focusSearch", focus);

    await commands.execute("search.findInFiles");

    expect(layout.getState().activeView).toBe("search");
    expect(focus).toHaveBeenCalled();
  });

  it("panel commands pick the tab, and Ctrl+J toggles with a checked state", async () => {
    await commands.execute("view.showProblems");
    expect(panel.getState()).toMatchObject({ visible: true, activeTab: "problems" });
    await commands.execute("view.showOutput");
    expect(panel.getState().activeTab).toBe("output");
    await commands.execute("view.showDebugConsole");
    expect(panel.getState().activeTab).toBe("debugConsole");
    await commands.execute("view.showPorts");
    expect(panel.getState().activeTab).toBe("ports");

    expect(commands.isChecked("view.togglePanel")).toBe(true);
    await commands.execute("view.togglePanel");
    expect(commands.isChecked("view.togglePanel")).toBe(false);
  });

  it("output.clear clears the selected channel", async () => {
    output.append("Terminal", "x");
    output.select("Terminal");

    await commands.execute("output.clear");

    expect(output.getLines("Terminal")).toEqual([]);
  });

  it("search.cancel is only enabled while a search is running", () => {
    expect(commands.isEnabled("search.cancel")).toBe(false);
  });
});

describe("LayoutService side views", () => {
  it("clicking the active view hides the side bar; another view switches to it", async () => {
    const layout = new LayoutService(createFakeIpc());

    await layout.toggleView("explorer");
    expect(layout.getState().sidebarVisible).toBe(false);
    await layout.toggleView("explorer");
    expect(layout.getState()).toMatchObject({ sidebarVisible: true, activeView: "explorer" });
    await layout.toggleView("search");
    expect(layout.getState()).toMatchObject({ sidebarVisible: true, activeView: "search" });
  });

  it("restores a saved view and falls back to the Explorer for an unknown one", async () => {
    const good = new LayoutService(
      createFakeIpc({ settingsGet: vi.fn().mockResolvedValue('{"activeView":"scm"}') }),
    );
    await good.initialize();
    const bad = new LayoutService(
      createFakeIpc({ settingsGet: vi.fn().mockResolvedValue('{"activeView":"remote"}') }),
    );
    await bad.initialize();

    expect(good.getState().activeView).toBe("scm");
    expect(bad.getState().activeView).toBe("explorer");
  });
});
