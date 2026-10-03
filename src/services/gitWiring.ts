import type { EditorGroupService } from "./editorGroupService";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import { GitBlameService } from "./gitBlameService";
import { GitCloneService } from "./gitCloneService";
import { GitHistoryService } from "./gitHistoryService";
import { GitService } from "./gitService";
import { GitStashService } from "./gitStashService";
import type { IpcClient } from "./ipc";
import type { OutputService } from "./outputService";
import { SourceControlService } from "./sourceControlService";
import type { WorkspaceService } from "./workspaceService";

export interface GitWiringDeps {
  ipc: IpcClient;
  output: OutputService;
  events: EventBus<AppEvents>;
  workspace: WorkspaceService;
  editorGroups: EditorGroupService;
  /** Open files, the Explorer and Source Control look at the disk again after a Git operation changed it. */
  afterGitOperation: () => Promise<unknown>;
}

/** The Git client: Source Control (from the canonical state), Clone, History, Stash and Blame. */
export function wireGit(deps: GitWiringDeps) {
  const { events, workspace } = deps;
  const git = new GitService(deps.ipc, deps.output);
  const sourceControl = new SourceControlService(
    git,
    events,
    (path) => workspace.openPath(path),
    () => {
      events.emit("showRuntimeManager", undefined);
    },
    deps.afterGitOperation,
  );
  const clone = new GitCloneService(
    git,
    events,
    (path) => workspace.openFolder(path),
    () => sourceControl.runtime(),
  );
  const history = new GitHistoryService(git, events, (hash, file) =>
    sourceControl.openCommitDiff(hash, file),
  );
  const stash = new GitStashService(
    git,
    events,
    async (): Promise<void> => {
      await sourceControl.refresh();
      await deps.afterGitOperation();
    },
    () => {
      const changes = sourceControl.status()?.changes ?? [];
      const untracked = changes.filter((change) => change.worktree === "untracked").length;
      return { tracked: changes.length - untracked, untracked };
    },
  );
  const blame = new GitBlameService(
    git,
    () => {
      const tab = deps.editorGroups.activeTab();
      return tab ? workspace.docPath(tab.docId) : null;
    },
    () => sourceControl.repository(),
  );
  // Another folder: what was shown for the old one goes.
  events.on("workspaceFolderChanged", () => {
    history.reset();
    stash.reset();
    blame.close();
  });
  return {
    git,
    sourceControl,
    gitClone: clone,
    gitHistory: history,
    gitStash: stash,
    gitBlame: blame,
  };
}
