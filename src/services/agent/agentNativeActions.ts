/** Composition adapters: reuse the editor's existing Git, extension and file services. */
import { save } from "@tauri-apps/plugin-dialog";
import type { GitSnapshot, GitDiffSides } from "../ipc";
export interface AgentEditorActions {
  workspace: {
    ensureWorkspace: (fallback?: "documents" | "agent") => Promise<unknown>;
  };
  sourceControl: {
    refresh: () => Promise<void>;
    getState: () => { snapshot: GitSnapshot | null; error?: string | null };
  };
  ipc: {
    documentSave: (
      path: string,
      text: string,
      encoding: "utf8",
    ) => Promise<void>;
    gitDiff: (path: string, staged: boolean) => Promise<GitDiffSides>;
  };
  layout: { showView: (view: "extensions") => Promise<void> };
  extensions: {
    registry: {
      ensureLoaded: () => Promise<void>;
      all: () => {
        id: string;
        enabled: boolean;
        manifest: { version: string };
      }[];
      find: (id: string) => unknown;
    };
    service: {
      chooseVsix: () => Promise<void>;
      setEnabled: (id: string, enabled: boolean) => Promise<void>;
      getState: () => { error: string | null };
    };
  };
}

export async function exportAgentChat(
  host: AgentEditorActions,
  markdown: string,
): Promise<string | null> {
  const path = await save({
    defaultPath: `OpenMindAI-chat-${new Date().toISOString().slice(0, 10)}.md`,
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  if (!path) return null;
  await host.ipc.documentSave(path, markdown, "utf8");
  return path;
}
export async function agentGitChanges(
  host: AgentEditorActions,
): Promise<string> {
  await host.workspace.ensureWorkspace("agent");
  await host.sourceControl.refresh();
  const git = host.sourceControl.getState();
  if (git.error) throw new Error(git.error);
  const snapshot = git.snapshot;
  if (!snapshot || snapshot.state !== "repository")
    throw new Error(
      snapshot?.state === "gitMissing"
        ? snapshot.reason
        : "The current workspace is not a Git repository, or Git is unavailable.",
    );
  const changed = snapshot.status.changes;
  if (!changed.length) return "No Git changes.";
  const output: string[] = [];
  let remaining = 60000;
  for (const file of changed.slice(0, 40)) {
    for (const staged of [true, false]) {
      if ((staged ? file.index : file.worktree) === "unmodified") continue;
      if (staged && file.index === "untracked") continue;
      if (remaining <= 0) break;
      const diff = await host.ipc.gitDiff(file.path, staged);
      const text = `${file.path} (${staged ? "staged" : "working tree"})\n${diff.binary ? "[Binary file]" : `BEFORE:\n${diff.original ?? "[File absent]"}\nAFTER:\n${diff.modified ?? "[File absent]"}`}\n`;
      output.push(text.slice(0, remaining));
      remaining -= text.length;
    }
  }
  if (remaining <= 0 || changed.length > 40)
    output.push(
      "[Change snapshot truncated. Inspect remaining files with agent read-only tools.]",
    );
  return output.join("\n---\n");
}
export async function agentPlugins(
  host: AgentEditorActions,
  argument: string,
): Promise<string> {
  const [action = "list", id, ...extra] = argument.trim().split(/\s+/);
  if (extra.length)
    throw new Error(
      "Usage: /plugins [list|open|install|enable <id>|disable <id>]",
    );
  const extensions = host.extensions;
  await extensions.registry.ensureLoaded();
  if (action === "open" || action === "install") {
    await host.layout.showView("extensions");
    if (action === "install") {
      await extensions.service.chooseVsix();
      const error = extensions.service.getState().error;
      if (error) throw new Error(error);
    }
    return "The Extensions view is open. Installation uses the existing package inspection and trust confirmation.";
  }
  if (action === "enable" || action === "disable") {
    if (!id || !extensions.registry.find(id))
      throw new Error("Provide the exact ID of an installed plugin.");
    await extensions.service.setEnabled(id, action === "enable");
    const error = extensions.service.getState().error;
    if (error) throw new Error(error);
  } else if (action && action !== "list")
    throw new Error(
      "Usage: /plugins [list|open|install|enable <id>|disable <id>]",
    );
  return (
    extensions.registry
      .all()
      .map(
        (e) =>
          `${e.id} · ${e.manifest.version} · ${e.enabled ? "enabled" : "disabled"}`,
      )
      .join("\n") ||
    "No plugins installed. Use /plugins install to choose a VSIX, or /plugins open for the marketplace."
  );
}
