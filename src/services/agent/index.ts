// The OpenMindAI Agent of this window, built from the app's own services (kept out of container.ts, which is at its
// size limit). Editor startup preloads an existing setup; downloading always needs an explicit action.
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { historyIpc } from "./agentHistory";
import { container } from "../container";
import { i18n, t } from "../../i18n";
import { tauriAgentIpc, type AgentIpc } from "./agentIpc";
import { AgentService, type AgentHost } from "./agentService";

const LANGUAGE_NAMES: Record<string, string> = { en: "English", ru: "Russian" };

/** Paths of this window's documents with unsaved edits. */
function unsavedPaths(): string[] {
  const paths = new Set<string>();
  for (const group of container.workspace.getState().groups) {
    for (const tab of group.tabs) {
      if (!tab.dirty) continue;
      try {
        const path = container.documents.snapshot(tab.docId).path;
        if (path) paths.add(path);
      } catch {
        // A preview tab is not a document.
      }
    }
  }
  return [...paths];
}

function taskScope(): string {
  try { return getCurrentWebviewWindow().label; } catch { return "main"; }
}

export function agentHost(): AgentHost {
  return {
    unsavedPaths,
    historyIpc,
    taskScope: taskScope(),
    uiLanguage: () => LANGUAGE_NAMES[i18n.language] ?? "English",
    hasFolder: () => container.workspace.getActiveWorkspace() !== null,
    workspacePath: () => container.workspace.getActiveWorkspace()?.path ?? null,
    installEngine: () => container.runtime.install("llamacpp", null),
    confirm: async (message, okLabel) => {
      const answer = await container.extensions.prompts.confirm({
        extension: "OpenMindAI Agent",
        title: t("agent.title"),
        details: [],
        notes: [message],
        buttons: [okLabel],
      });
      return answer === okLabel;
    },
    notify: (message) => {
      container.events.emit("appNotice", { message });
    },
    openFile: (path) => {
      void container.workspace.openPath(path);
    },
    suggestFiles: async (query) => {
      const hits = await container.ipc.searchFilesIndexed(query, null, 8);
      return hits.map((hit) => hit.relativePath);
    },
    settingGet: (key) => container.ipc.settingsGet(key),
    settingSet: (key, value) => container.ipc.settingsSet(key, value),
    text: (key, params) => t(key, params),
  };
}

export function createAgent(ipc: AgentIpc = tauriAgentIpc, host: AgentHost = agentHost()): AgentService {
  return new AgentService(ipc, host);
}

export const agent = createAgent();
