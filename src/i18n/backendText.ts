import { t } from "./index";

/**
 * A few sentences the backend sends in English that matter for a decision (a task's risks in its confirmation).
 * Matched exactly; anything else the backend says is shown as it came.
 */
const KNOWN: Record<string, string> = {
  "It may download from or upload to the network.": "tasks.risk.network",
  "It deletes or resets files.": "tasks.risk.deletes",
  "It asks for administrator rights.": "tasks.risk.admin",
  "It runs outside the open folder.": "tasks.risk.outside",
  "It changes PATH (for this task only).": "tasks.risk.path",
  "Python debugger is not installed yet.": "debug.backend.pythonDebugger",
  "Python runtime is not installed yet.": "debug.backend.pythonRuntime",
  "Node.js debugger is not installed yet.": "debug.backend.nodeDebugger",
  "Node.js runtime is not installed yet.": "debug.backend.nodeRuntime",
  "PHP debugging requires Xdebug and is not available yet.": "debug.backend.php",
  "The notebook changed on disk since it was opened. Reload it, or save again to overwrite it.":
    "notebook.conflict",
};

export function translateBackend(text: string): string {
  const key = KNOWN[text];
  return key === undefined ? text : t(key);
}
