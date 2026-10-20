import type { EditorAiActions, EditorSnapshot } from "../agent/editorAiActions";
import type { CommandRegistry } from "../commandRegistry";
import type { FileGitRemote } from "../git/fileGitRemote";
import { CancelledError } from "../git/fileGitRemote";
import type { FileGitService, GitTarget } from "../git/fileGitService";
import type { GitViewsService, HistoryMode } from "../git/gitViewsService";
import { gitBlocker, type FileGitProbe, type GitNeed } from "./fileGitProbe";

/** What the editor in front can do now, for enabling the editing entries. */
export interface ActiveEditorFacts {
  hasEditor: boolean;
  readOnly: boolean;
}

export interface EditorMenuDeps {
  commands: CommandRegistry;
  /** Runs a Monaco action in the editor in front (focusing it first). */
  runEditorAction: (actionId: string) => void;
  facts: () => ActiveEditorFacts;
  /** Why a language-server action can't run for the file in front (`null`: it can). */
  lspBlocker: (action: "definition" | "typeDefinition" | "implementation" | "references" | "codeAction") => string | null;
  git: FileGitService;
  remote: FileGitRemote;
  views: GitViewsService;
  probe: FileGitProbe;
  ai: EditorAiActions;
  /** The editor in front as an AI snapshot, or `null`. */
  activeSnapshot: () => EditorSnapshot | null;
  /** A whole file (from the Explorer or a tab) as an AI snapshot. */
  fileSnapshot: (path: string) => Promise<EditorSnapshot>;
  /** Why inline chat can't open (`null`: it can). */
  inlineBlocker: () => string | null;
  openInlineChat: () => void;
  /** The file and line(s) of the editor in front, or `null`. */
  activeTarget: () => GitTarget | null;
  toggleSetting: (id: string) => Promise<void>;
  settingOn: (id: string) => boolean;
  openSettings: (query: string) => void;
  startDictation: () => Promise<void>;
  t: (key: string, params?: Record<string, string | number>) => string;
}

function isTarget(value: unknown): value is GitTarget {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as GitTarget).path === "string" &&
    typeof (value as GitTarget).line === "number"
  );
}

/** A picker the user closed is not a failure. */
async function quietly(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof CancelledError) return;
    throw error;
  }
}

/** What each Git command needs of its file, filled in as they register. */
type Needs = Map<string, GitNeed>;

/**
 * Every command of the editor's context menu (also in the palette and on their shortcuts). Returns how to judge a
 * command for a file other than the one in front (an Explorer or tab menu): why it can't run for that file, or `null`.
 */
export function registerEditorMenuCommands(deps: EditorMenuDeps): {
  reasonForFile: (command: string, path: string) => string | null;
} {
  const needs: Needs = new Map();
  registerAiCommands(deps);
  registerEditingCommands(deps);
  registerGitCommands(deps, needs);
  registerRemoteCommands(deps, needs);
  registerCopyCommands(deps, needs);
  return {
    reasonForFile: (command, path) => {
      const need = needs.get(command);
      return need === undefined ? null : gitBlocker(deps.probe.get(path), need, deps.t);
    },
  };
}

function noEditorReason(deps: EditorMenuDeps): string | undefined {
  const facts = deps.facts();
  if (!facts.hasEditor) return deps.t("editorMenu.openFile");
  if (facts.readOnly) return deps.t("editorMenu.readOnly");
  return undefined;
}

function registerAiCommands(deps: EditorMenuDeps): void {
  const { commands, ai, t } = deps;
  const needSnapshot = () => {
    const snapshot = deps.activeSnapshot();
    if (snapshot === null) throw new Error(t("editorMenu.openFile"));
    return snapshot;
  };
  const snapshotReason = () => (deps.activeSnapshot() === null ? t("editorMenu.openFile") : undefined);
  commands.register(
    "openmindAi.addFileToChat",
    async (target) => {
      ai.addFileToChat(isTarget(target) ? await deps.fileSnapshot(target.path) : needSnapshot());
    },
    { enabled: () => deps.activeSnapshot() !== null, disabledReason: snapshotReason },
  );
  commands.register(
    "openmindAi.addToChat",
    () => {
      ai.addToChat(needSnapshot());
    },
    { enabled: () => deps.activeSnapshot() !== null, disabledReason: snapshotReason },
  );
  commands.register("openmindAi.explain", () => ai.explain(needSnapshot()), {
    enabled: () => deps.activeSnapshot() !== null,
    disabledReason: snapshotReason,
  });
  commands.register("openmindAi.review", () => ai.review(needSnapshot()), {
    enabled: () => deps.activeSnapshot() !== null,
    disabledReason: snapshotReason,
  });
  commands.register(
    "openmindAi.inlineChat",
    () => {
      deps.openInlineChat();
    },
    {
      enabled: () => deps.inlineBlocker() === null,
      disabledReason: () => deps.inlineBlocker() ?? undefined,
    },
  );
}

function registerEditingCommands(deps: EditorMenuDeps): void {
  const { commands } = deps;
  const editable = () => noEditorReason(deps) === undefined;
  const peeks: [string, Parameters<EditorMenuDeps["lspBlocker"]>[0], string][] = [
    ["go.peekDefinition", "definition", "editor.action.peekDefinition"],
    ["go.peekTypeDefinition", "typeDefinition", "editor.action.peekTypeDefinition"],
    ["go.peekImplementations", "implementation", "editor.action.peekImplementation"],
    ["go.peekReferences", "references", "editor.action.referenceSearch.trigger"],
  ];
  for (const [id, action, monacoAction] of peeks) {
    commands.register(
      id,
      () => {
        deps.runEditorAction(monacoAction);
      },
      {
        enabled: () => deps.lspBlocker(action) === null,
        disabledReason: () => deps.lspBlocker(action) ?? undefined,
      },
    );
  }
  const runAction = (actionId: string) => () => {
    deps.runEditorAction(actionId);
  };
  commands.register("edit.changeAllOccurrences", runAction("editor.action.changeAll"), {
    enabled: editable,
    disabledReason: () => noEditorReason(deps),
  });
  const codeActionReason = () => noEditorReason(deps) ?? deps.lspBlocker("codeAction") ?? undefined;
  commands.register("edit.refactor", runAction("editor.action.refactor"), {
    enabled: () => codeActionReason() === undefined,
    disabledReason: codeActionReason,
  });
  commands.register("edit.sourceAction", runAction("editor.action.sourceAction"), {
    enabled: () => codeActionReason() === undefined,
    disabledReason: codeActionReason,
  });
  commands.register("edit.startDictation", () => deps.startDictation(), {
    enabled: editable,
    disabledReason: () => noEditorReason(deps),
  });
}

/** The command's target (an explicit file from the Explorer or a tab, else the editor in front). */
function targetOf(deps: EditorMenuDeps, args: unknown[]): GitTarget {
  const target = isTarget(args[0]) ? args[0] : deps.activeTarget();
  if (target === null) throw new Error(deps.t("gitFile.saveFirst"));
  return target;
}

/** Registers a Git command that needs `need` for its file; disabled (with the reason) when that isn't met. */
function gitCommand(
  deps: EditorMenuDeps,
  needs: Needs,
  id: string,
  need: GitNeed,
  run: (target: GitTarget) => Promise<void>,
): void {
  needs.set(id, need);
  const reason = () => {
    const target = deps.activeTarget();
    if (target === null) return deps.t("gitFile.saveFirst");
    return gitBlocker(deps.probe.get(target.path), need, deps.t) ?? undefined;
  };
  deps.commands.register(id, (...args) => quietly(() => run(targetOf(deps, args))), {
    enabled: () => reason() === undefined,
    disabledReason: reason,
  });
}

function registerGitCommands(deps: EditorMenuDeps, needs: Needs): void {
  const { git, views } = deps;
  gitCommand(deps, needs, "git.openLineChangesWithPrevious", "tracked", (t) => git.lineChangesWithPrevious(t));
  gitCommand(deps, needs, "git.openLineChangesWithWorking", "tracked", (t) => git.lineChangesWithWorking(t));
  gitCommand(deps, needs, "git.openChangesWithPrevious", "tracked", (t) => git.changesWithPrevious(t));
  gitCommand(deps, needs, "git.openChangesWithRevision", "tracked", (t) => git.changesWithRevision(t));
  gitCommand(deps, needs, "git.openChangesWithBranchOrTag", "repository", (t) => git.changesWithBranchOrTag(t));
  gitCommand(deps, needs, "git.quickShowLineCommit", "tracked", (t) => git.showLineCommit(t, true));
  gitCommand(deps, needs, "git.inspectLineCommit", "tracked", (t) => git.showLineCommit(t, false));
  const history = (mode: HistoryMode) => (t: GitTarget) => views.openHistory(t.path, mode);
  gitCommand(deps, needs, "git.openFileHistory", "tracked", history("list"));
  gitCommand(deps, needs, "git.openFileHistoryGraph", "tracked", history("graph"));
  gitCommand(deps, needs, "git.openVisualFileHistory", "tracked", history("visual"));
  gitCommand(deps, needs, "git.quickOpenFileHistory", "tracked", (t) => git.quickOpenHistory(t));
  const toggles: [string, string][] = [
    ["git.toggleFileBlame", "git.annotations.blame"],
    ["git.toggleFileHeatmap", "git.annotations.heatmap"],
    ["git.toggleFileChanges", "git.annotations.changes"],
  ];
  for (const [id, setting] of toggles) {
    deps.commands.register(id, () => deps.toggleSetting(setting), { checked: () => deps.settingOn(setting) });
  }
  deps.commands.register("git.openAnnotationSettings", () => {
    deps.openSettings("git.annotations");
  });
}

function registerRemoteCommands(deps: EditorMenuDeps, needs: Needs): void {
  const { remote } = deps;
  gitCommand(deps, needs, "git.openFileOnRemote", "remote", (t) => remote.fileOnRemote(t, "open"));
  gitCommand(deps, needs, "git.openFileOnRemoteFrom", "remote", (t) => remote.fileOnRemoteFrom(t, "open"));
  gitCommand(deps, needs, "git.openCommitOnRemote", "remote", (t) => remote.commitOnRemote(t, "open"));
  gitCommand(deps, needs, "git.copyVscodeDevLink", "github", (t) => remote.copyVscodeDevLink(t));
}

function registerCopyCommands(deps: EditorMenuDeps, needs: Needs): void {
  const { remote, commands, t } = deps;
  const fileReason = () => (deps.activeTarget() === null ? t("gitFile.saveFirst") : undefined);
  commands.register("copyAs.relativePath", (...args) => remote.copyRelativePath(targetOf(deps, args)), {
    enabled: () => fileReason() === undefined,
    disabledReason: fileReason,
  });
  commands.register("copyAs.fileLink", (...args) => remote.copyFileLink(targetOf(deps, args)), {
    enabled: () => fileReason() === undefined,
    disabledReason: fileReason,
  });
  gitCommand(deps, needs, "copyAs.fileLinkAtRevision", "remote", (target) => remote.linkAtRevision(target));
  gitCommand(deps, needs, "copyAs.remoteFileUrl", "remote", (target) => remote.fileOnRemote(target, "copy"));
  gitCommand(deps, needs, "copyAs.remoteFileUrlFrom", "remote", (target) => remote.fileOnRemoteFrom(target, "copy"));
  gitCommand(deps, needs, "copyAs.remoteCommitUrl", "remote", (target) => remote.commitOnRemote(target, "copy"));
  gitCommand(deps, needs, "copyAs.sha", "tracked", (target) => remote.copySha(target));
  gitCommand(deps, needs, "copyAs.message", "tracked", (target) => remote.copyMessage(target));
}
