import { describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { DebugConfigurationService } from "./debugConfigurationService";
import type { DebugConfigurations } from "./workflowIpc";

const LAUNCH: DebugConfigurations = {
  files: [
    {
      path: "C:/My Site/.vscode/launch.json",
      error: null,
      configurations: [
        {
          name: "App",
          source: "C:/My Site/.vscode/launch.json",
          typeName: "debugpy",
          request: "launch",
          config: { name: "App", target: "python", program: "C:/My Site/app.py", cwd: "C:/My Site", args: [], stopOnEntry: false },
          problem: null,
          notes: ["output goes to the Debug Console (console is ignored)"],
        },
        {
          name: "C++",
          source: "C:/My Site/.vscode/launch.json",
          typeName: "cppdbg",
          request: "launch",
          config: null,
          problem: 'The debugger type "cppdbg" is not supported.',
          notes: [],
        },
      ],
      compounds: [{ name: "Both", configurations: ["App", "C++"], problem: "Compound configurations are not supported yet." }],
    },
    { path: "C:/My Site/.openmind/launch.json", error: "launch.json is not valid JSON (line 3, column 1).", configurations: [], compounds: [] },
  ],
  extensionDebuggers: [{ kind: "go", label: "Go", extension: "golang.go" }],
};

function service(data: DebugConfigurations = LAUNCH, recent: string | null = null) {
  const ipc = createFakeIpc({
    debugConfigurations: vi.fn().mockResolvedValue(data),
    settingsGet: vi.fn().mockResolvedValue(recent),
    settingsSet: vi.fn().mockResolvedValue(undefined),
  });
  return { ipc, configs: new DebugConfigurationService(ipc) };
}

describe("DebugConfigurationService", () => {
  it("lists built-in and launch.json configurations, unsupported ones with their reason", async () => {
    const { configs, ipc } = service();
    await configs.refresh("C:/My Site/tool.py");
    expect(ipc.debugConfigurations).toHaveBeenCalledWith("C:/My Site/tool.py");
    const entries = configs.entries("C:/My Site/tool.py", "C:/My Site");
    expect(entries.map((e) => [e.name, e.sourceLabel])).toEqual([
      ["Python: Current File", "Built-in"],
      ["App", ".vscode/launch.json"],
      ["C++", ".vscode/launch.json"],
      ["Both (compound)", ".vscode/launch.json"],
    ]);
    expect(entries[2]?.problem).toContain("cppdbg");
    expect(entries[3]?.config).toBeNull();
    expect(configs.getState().fileErrors).toEqual([".openmind/launch.json: launch.json is not valid JSON (line 3, column 1)."]);
    expect(configs.extensionDebuggers()[0]?.extension).toBe("golang.go");
  });

  it("the chosen entry starts, else the first that can run; recently used come first and are remembered", async () => {
    const { configs, ipc } = service(LAUNCH, JSON.stringify(["C:/My Site/.vscode/launch.json::App"]));
    await configs.refresh(null);
    expect(configs.currentEntry(null, "C:/My Site")?.name).toBe("App");
    configs.choose("C:/My Site/.vscode/launch.json::C++");
    expect(configs.current(null, "C:/My Site")).toBeNull();
    expect(configs.currentEntry(null, "C:/My Site")?.problem).toContain("cppdbg");
    configs.recordUsed("C:/My Site/.vscode/launch.json::C++");
    expect(configs.entries(null, "C:/My Site")[0]?.name).toBe("C++");
    expect(ipc.settingsSet).toHaveBeenCalledWith(
      "debug.recentConfigurations",
      JSON.stringify(["C:/My Site/.vscode/launch.json::C++", "C:/My Site/.vscode/launch.json::App"]),
    );
  });

  it("a failed read is shown, and without a backend only the built-in configurations exist", async () => {
    const failing = createFakeIpc({ debugConfigurations: vi.fn().mockRejectedValue(new Error("no")) });
    const configs = new DebugConfigurationService(failing);
    await configs.refresh(null);
    expect(configs.getState().fileErrors[0]).toContain("couldn't be read");
    const offline = new DebugConfigurationService();
    await offline.refresh("a.js");
    expect(offline.entries("C:/w/a.js", "C:/w").map((e) => e.name)).toEqual(["Node.js: Current File"]);
  });
});
