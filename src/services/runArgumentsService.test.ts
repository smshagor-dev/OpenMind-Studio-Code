import { describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { CommandRegistry } from "./commandRegistry";
import { OutputService } from "./outputService";
import type { PanelService } from "./panelService";
import type { TerminalService } from "./terminalService";
import type { WorkspaceService } from "./workspaceService";
import { RUN_ARGUMENTS_KEY, RunArgumentsService } from "./runArgumentsService";
import { registerRunCommands } from "./runCommands";
import { RunCodeService } from "./runCodeService";
import type { RunConfigurationService } from "./runConfigurationService";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";

function memoryStore(initial: string | null = null) {
  const saved = new Map<string, string>();
  if (initial !== null) saved.set(RUN_ARGUMENTS_KEY, initial);
  return {
    saved,
    settingsGet: vi.fn((key: string) => Promise.resolve(saved.get(key) ?? null)),
    settingsSet: vi.fn((key: string, value: string) => {
      saved.set(key, value);
      return Promise.resolve();
    }),
  };
}

describe("RunArgumentsService", () => {
  it("remembers arguments per file and keeps them across a restart", async () => {
    const store = memoryStore();
    const first = new RunArgumentsService(store);
    await first.load();
    await first.set("C:/p/args.f90", '  7 "two words" ');
    await first.set("C:/p/other.pas", "x");
    await first.set("C:/p/other.pas", "   ");

    const restarted = new RunArgumentsService(store);
    await restarted.load();
    expect(restarted.get("C:/p/args.f90")).toBe('7 "two words"');
    expect(restarted.get("C:/p/other.pas")).toBe("");
    expect(JSON.parse(store.saved.get(RUN_ARGUMENTS_KEY) ?? "{}")).toEqual({ "C:/p/args.f90": '7 "two words"' });
  });

  it("ignores a damaged stored value and non-text entries", async () => {
    const broken = new RunArgumentsService(memoryStore("{not json"));
    await broken.load();
    expect(broken.get("C:/p/a.py")).toBe("");
    const mixed = new RunArgumentsService(memoryStore(JSON.stringify({ "C:/p/a.py": 3, "C:/p/b.py": "x" })));
    await mixed.load();
    expect(mixed.get("C:/p/a.py")).toBe("");
    expect(mixed.get("C:/p/b.py")).toBe("x");
  });

  it("tells listeners when arguments change", async () => {
    const service = new RunArgumentsService(memoryStore());
    const listener = vi.fn();
    service.subscribe(listener);
    await service.set("C:/p/a.py", "1");
    expect(listener).toHaveBeenCalled();
  });
});

describe("Run Code requests", () => {
  it("carry the file's arguments, and a change asks the backend again", async () => {
    const runResolve = vi.fn().mockResolvedValue({ runnable: true, kind: "fortran", language: "Fortran", reason: null });
    const ipc = createFakeIpc({ runResolve, onRunEvent: vi.fn(() => Promise.resolve(() => undefined)) });
    const tab = { id: "d1", path: "C:/p/args.f90", title: "args.f90", dirty: false, kind: "text" };
    const workspace = {
      getState: () => ({ tabs: [tab], activeId: "d1", groups: [], activeGroupId: "group-1", weights: [1] }),
      getActiveWorkspace: () => ({ id: 1, name: "p", path: "C:/p" }),
    } as unknown as WorkspaceService;
    const run = new RunCodeService(
      ipc,
      new EventBus<AppEvents>(),
      new OutputService(),
      workspace,
      { subscribe: () => () => undefined, templateFor: () => null } as unknown as RunConfigurationService,
      {} as unknown as TerminalService,
      {} as unknown as PanelService,
    );
    const store = new RunArgumentsService(memoryStore());
    run.setArgumentsSource((path) => store.get(path));
    await run.refresh();
    expect(runResolve).toHaveBeenLastCalledWith(expect.objectContaining({ file: "C:/p/args.f90", arguments: null }));

    await store.set("C:/p/args.f90", '7 "two words"');
    await run.refresh();
    expect(runResolve).toHaveBeenLastCalledWith(
      expect.objectContaining({ file: "C:/p/args.f90", arguments: '7 "two words"' }),
    );
  });
});

describe("Run Code with Arguments...", () => {
  async function rig(answer: string | null) {
    const commands = new CommandRegistry();
    const store = new RunArgumentsService(memoryStore());
    await store.set("C:/p/args.f90", "old");
    const runCode = {
      canRun: () => true,
      canStop: () => false,
      activeEditor: () => ({ path: "C:/p/args.f90" }),
      refresh: vi.fn(() => Promise.resolve()),
      run: vi.fn(() => Promise.resolve(true)),
    };
    const ask = vi.fn(() => Promise.resolve(answer));
    registerRunCommands({
      commands,
      events: new EventBus<AppEvents>(),
      runCode: runCode as unknown as RunCodeService,
      configs: { supports: () => true } as unknown as RunConfigurationService,
      arguments: { store, ask },
    });
    await commands.execute("run.codeWithArguments");
    return { store, runCode, ask };
  }

  it("asks with the remembered arguments, remembers the answer and runs", async () => {
    const r = await rig('7 "two words"');
    expect(r.ask).toHaveBeenCalledWith("C:/p/args.f90", "old");
    expect(r.store.get("C:/p/args.f90")).toBe('7 "two words"');
    expect(r.runCode.run).toHaveBeenCalledOnce();
  });

  it("does nothing when cancelled", async () => {
    const r = await rig(null);
    expect(r.store.get("C:/p/args.f90")).toBe("old");
    expect(r.runCode.run).not.toHaveBeenCalled();
  });
});
