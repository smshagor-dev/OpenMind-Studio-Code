import type { CommandRegistry } from "./commandRegistry";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { ExtensionPromptService } from "./extensionPromptService";
import type { ExtensionTaskService } from "./extensionTasks";
import type { IpcClient } from "./ipc";
import type { MarkerService } from "./markerService";
import type { TerminalService } from "./terminalService";
import { openOrCreate, TASKS_TEMPLATE } from "./workspaceJsonFiles";
import { WorkspaceTaskService } from "./workspaceTasks";

export interface TaskWiringDeps {
  ipc: IpcClient;
  events: EventBus<AppEvents>;
  commands: CommandRegistry;
  terminal: TerminalService;
  prompts: ExtensionPromptService;
  markers: MarkerService;
  extensionTasks: ExtensionTaskService;
  activeFile: () => string | null;
  workspaceFolder: () => string | null;
  openPath: (path: string) => Promise<unknown>;
  log: (line: string) => void;
}

/**
 * Terminal > Run Task..., Run Build Task... (Ctrl+Shift+B), Run Test Task..., Show Running Tasks...,
 * Restart Running Task..., Terminate Task... and Configure Tasks...: the folder's tasks.json tasks and the
 * extensions' tasks. Nothing here runs at launch.
 */
export function wireTasks(deps: TaskWiringDeps): WorkspaceTaskService {
  const { commands, terminal, prompts, events } = deps;
  const notice = (message: string) => {
    events.emit("appNotice", { message });
  };
  const tasks = new WorkspaceTaskService({
    ipc: deps.ipc,
    terminals: {
      createTaskTerminal: (title, start, show) => terminal.createTaskTerminal(title, start, show),
      onOutput: (id, listener) => terminal.onOutput(id, listener),
      waitForExit: (id) => terminal.waitForExit(id),
      closeTerminal: (id) => terminal.closeTerminal(id),
      setActive: (id) => {
        terminal.setActive(id);
      },
      lastShell: () => terminal.getState().lastShell,
    },
    confirm: (request) => prompts.confirm(request),
    quickPick: (request) => prompts.quickPick(request),
    setProblems: (owner, files) => {
      deps.markers.setExternal(owner, files);
    },
    activeFile: deps.activeFile,
    notice,
    log: deps.log,
    extensionTasks: {
      list: () => deps.extensionTasks.list(),
      confirmAndRun: (task) => deps.extensionTasks.confirmAndRun(task),
    },
  });
  const folderState = () =>
    deps.workspaceFolder() !== null
      ? { enabled: true }
      : { enabled: false, reason: "Open a folder to use its tasks." };
  const register = (id: string, run: () => Promise<unknown>, state = folderState) => {
    commands.register(
      id,
      async () => {
        await run();
      },
      { enabled: () => state().enabled, disabledReason: () => state().reason },
    );
  };
  register("tasks.run", () => tasks.pickAndRun());
  register("tasks.runBuild", () => tasks.pickAndRun("build"));
  register("tasks.runTest", () => tasks.pickAndRun("test"));
  const running = () =>
    tasks.getRunning().length > 0
      ? { enabled: true }
      : { enabled: false, reason: "No task is running." };
  register("tasks.showRunning", () => tasks.showRunning(), running);
  register("tasks.terminate", () => tasks.terminate(), running);
  register(
    "tasks.restartRunning",
    async () => {
      const current = tasks.getRunning()[0];
      if (!current) return;
      await tasks.stopAll();
      const task = (await tasks.list()).find((t) => t.id === current.id);
      if (task) await tasks.run(task);
    },
    running,
  );
  register("tasks.configure", async () => {
    const folder = deps.workspaceFolder();
    if (!folder) return;
    await openOrCreate(
      { ipc: deps.ipc, openPath: deps.openPath, notice },
      folder,
      "tasks.json",
      TASKS_TEMPLATE,
    );
  });
  // A folder that closes takes its running tasks with it.
  events.on("workspaceFolderChanged", () => {
    void tasks.stopAll();
  });
  return tasks;
}
