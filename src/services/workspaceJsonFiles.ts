import type { IpcClient } from "./ipc";

/** A starting `launch.json`: the two debuggers OpenMind runs, each on the file in front. */
export const LAUNCH_TEMPLATE = `{
  // Debug configurations for this folder. OpenMind Studio runs "debugpy" (Python) and "node" (JavaScript)
  // "launch" configurations; other types are listed with the reason they can't run.
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Python: Current File",
      "type": "debugpy",
      "request": "launch",
      "program": "\${file}",
      "cwd": "\${workspaceFolder}"
    },
    {
      "name": "Node.js: Current File",
      "type": "node",
      "request": "launch",
      "program": "\${file}",
      "cwd": "\${workspaceFolder}"
    }
  ]
}
`;

/** A starting `tasks.json` with one harmless task. */
export const TASKS_TEMPLATE = `{
  // Tasks for this folder: Terminal > Run Task... runs them (after showing what will run).
  "version": "2.0.0",
  "tasks": [
    {
      "label": "echo",
      "type": "shell",
      "command": "echo Hello from a task",
      "problemMatcher": []
    }
  ]
}
`;

export interface JsonFileDeps {
  ipc: Pick<IpcClient, "fsMetadata" | "fsCreateFolder" | "fsCreateFile" | "documentSave">;
  openPath: (path: string) => Promise<unknown>;
  notice: (message: string) => void;
}

/**
 * Opens the folder's `.openmind/<name>` or `.vscode/<name>`; when neither exists, creates `.vscode/<name>` from
 * `template` (only because the user asked for it) and opens it.
 */
export async function openOrCreate(
  deps: JsonFileDeps,
  folder: string,
  name: "launch.json" | "tasks.json",
  template: string,
): Promise<string> {
  const root = folder.replace(/[\\/]+$/, "");
  for (const dir of [".openmind", ".vscode"]) {
    const path = `${root}/${dir}/${name}`;
    try {
      await deps.ipc.fsMetadata(path);
      await deps.openPath(path);
      return path;
    } catch {
      // Not there: try the next place.
    }
  }
  const dir = `${root}/.vscode`;
  try {
    await deps.ipc.fsMetadata(dir);
  } catch {
    await deps.ipc.fsCreateFolder(root, root, ".vscode");
  }
  const path = await deps.ipc.fsCreateFile(root, dir, name);
  await deps.ipc.documentSave(path, template, "utf8");
  await deps.openPath(path);
  deps.notice(`Created .vscode/${name}.`);
  return path;
}
