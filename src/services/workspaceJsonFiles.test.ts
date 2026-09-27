import { describe, expect, it, vi } from "vitest";

import { LAUNCH_TEMPLATE, openOrCreate, TASKS_TEMPLATE } from "./workspaceJsonFiles";

function deps(existing: string[]) {
  const ipc = {
    fsMetadata: vi.fn((path: string) =>
      existing.includes(path) ? Promise.resolve({} as never) : Promise.reject(new Error("missing")),
    ),
    fsCreateFolder: vi.fn(() => Promise.resolve("C:/w/.vscode")),
    fsCreateFile: vi.fn((_root: string, dir: string, name: string) => Promise.resolve(`${dir}/${name}`)),
    documentSave: vi.fn(() => Promise.resolve()),
  };
  return { ipc, openPath: vi.fn(() => Promise.resolve(null)), notice: vi.fn() };
}

describe("launch.json / tasks.json", () => {
  it("an existing file is opened (.openmind first) and nothing is written", async () => {
    const d = deps(["C:/w/.openmind/tasks.json", "C:/w/.vscode/tasks.json"]);
    expect(await openOrCreate(d, "C:/w/", "tasks.json", TASKS_TEMPLATE)).toBe("C:/w/.openmind/tasks.json");
    expect(d.openPath).toHaveBeenCalledWith("C:/w/.openmind/tasks.json");
    expect(d.ipc.documentSave).not.toHaveBeenCalled();
  });

  it("with none, .vscode/<name> is created from the template, opened and announced", async () => {
    const d = deps([]);
    expect(await openOrCreate(d, "C:/w", "launch.json", LAUNCH_TEMPLATE)).toBe("C:/w/.vscode/launch.json");
    expect(d.ipc.fsCreateFolder).toHaveBeenCalledWith("C:/w", "C:/w", ".vscode");
    expect(d.ipc.documentSave).toHaveBeenCalledWith("C:/w/.vscode/launch.json", LAUNCH_TEMPLATE, "utf8");
    expect(d.notice).toHaveBeenCalledWith("Created .vscode/launch.json.");
    expect(LAUNCH_TEMPLATE).toContain('"type": "debugpy"');
    expect(TASKS_TEMPLATE).toContain('"version": "2.0.0"');
  });
});
