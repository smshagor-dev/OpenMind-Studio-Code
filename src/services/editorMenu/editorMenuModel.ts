import type { MenuEntry } from "../menus";

/**
 * The editor's right-click menu and the Git / Copy As groups the Explorer and tab menus share, as pure data over
 * command ids (VS Code's order). Every entry is a registered command, so the menu, its shortcut and the command
 * palette run the same code; whether an entry can run now (and why not) comes from the command itself.
 */

const SEPARATOR: MenuEntry = { kind: "separator" };

function cmd(label: string, command: string, args?: unknown[]): MenuEntry {
  return args ? { kind: "command", label, command, args } : { kind: "command", label, command };
}

function sub(label: string, items: MenuEntry[]): MenuEntry {
  return { kind: "submenu", label, items };
}

/** Commands extensions (and the AI panel) put into the editor's context menu. */
export interface ContributedEntry {
  command: string;
  label: string;
}

export const OPEN_CHANGES_COMMANDS = [
  ["Open Line Changes with Previous Revision", "git.openLineChangesWithPrevious"],
  ["Open Line Changes with Working File", "git.openLineChangesWithWorking"],
  ["Open Changes with Previous Revision", "git.openChangesWithPrevious"],
  ["Open Changes with Revision...", "git.openChangesWithRevision"],
  ["Open Changes with Branch or Tag...", "git.openChangesWithBranchOrTag"],
] as const;

export const LINE_COMMIT_COMMANDS = [
  ["Quick Show Line Commit", "git.quickShowLineCommit"],
  ["Inspect Line Commit Details", "git.inspectLineCommit"],
] as const;

export const REMOTE_COMMANDS = [
  ["Open File on Remote", "git.openFileOnRemote"],
  ["Open File on Remote From...", "git.openFileOnRemoteFrom"],
  ["Open Commit on Remote", "git.openCommitOnRemote"],
] as const;

export const ANNOTATION_COMMANDS = [
  ["Toggle File Blame", "git.toggleFileBlame"],
  ["Toggle File Heatmap", "git.toggleFileHeatmap"],
  ["Toggle File Changes", "git.toggleFileChanges"],
] as const;

export const HISTORY_COMMANDS = [
  ["Open File History", "git.openFileHistory"],
  ["Open File History in Commit Graph", "git.openFileHistoryGraph"],
  ["Open Visual File History", "git.openVisualFileHistory"],
  ["Quick Open File History", "git.quickOpenFileHistory"],
] as const;

export const COPY_AS_COMMANDS = [
  ["Copy Relative Path", "copyAs.relativePath"],
  ["Copy Link to File", "copyAs.fileLink"],
  ["Copy Link to File at Revision...", "copyAs.fileLinkAtRevision"],
  ["Copy Remote File URL", "copyAs.remoteFileUrl"],
  ["Copy Remote File URL From...", "copyAs.remoteFileUrlFrom"],
  ["Copy Remote Commit URL", "copyAs.remoteCommitUrl"],
  ["Copy SHA", "copyAs.sha"],
  ["Copy Message", "copyAs.message"],
] as const;

type Pair = readonly [string, string];

function list(pairs: readonly Pair[], args?: unknown[]): MenuEntry[] {
  return pairs.map(([label, command]) => cmd(label, command, args));
}

function openChangesMenu(args?: unknown[]): MenuEntry {
  return sub("Open Changes", [...list(OPEN_CHANGES_COMMANDS, args), SEPARATOR, ...list(LINE_COMMIT_COMMANDS, args)]);
}

function remoteMenu(args?: unknown[]): MenuEntry {
  return sub("Open on Remote (Web)", [
    ...list(REMOTE_COMMANDS.slice(0, 2), args),
    SEPARATOR,
    ...list(REMOTE_COMMANDS.slice(2), args),
  ]);
}

function historyMenu(args?: unknown[]): MenuEntry {
  return sub("File History", [...list(HISTORY_COMMANDS.slice(0, 3), args), SEPARATOR, ...list(HISTORY_COMMANDS.slice(3), args)]);
}

function copyAsMenu(args?: unknown[]): MenuEntry {
  return sub("Copy As", [
    ...list(COPY_AS_COMMANDS.slice(0, 3), args),
    SEPARATOR,
    ...list(COPY_AS_COMMANDS.slice(3, 6), args),
    SEPARATOR,
    ...list(COPY_AS_COMMANDS.slice(6), args),
  ]);
}

/** The editor's context menu. `contributed`: extension and AI panel commands that asked to be in it. */
export function editorContextMenu(contributed: ContributedEntry[]): MenuEntry[] {
  const extra = contributed.map((entry) => cmd(entry.label, entry.command));
  return [
    cmd("Add File to Chat", "openmindAi.addFileToChat"),
    cmd("Open Inline Chat", "openmindAi.inlineChat"),
    cmd("Explain", "openmindAi.explain"),
    cmd("Review", "openmindAi.review"),
    SEPARATOR,
    cmd("Go to Definition", "go.toDefinition"),
    cmd("Go to Type Definition", "go.toTypeDefinition"),
    cmd("Go to Implementations", "go.toImplementations"),
    cmd("Go to References", "go.toReferences"),
    sub("Peek", [
      cmd("Peek Definition", "go.peekDefinition"),
      cmd("Peek Type Definition", "go.peekTypeDefinition"),
      cmd("Peek Implementations", "go.peekImplementations"),
      cmd("Peek References", "go.peekReferences"),
    ]),
    SEPARATOR,
    cmd("Rename Symbol", "edit.renameSymbol"),
    cmd("Change All Occurrences", "edit.changeAllOccurrences"),
    cmd("Format Document", "edit.formatDocument"),
    cmd("Format Document With...", "edit.formatDocumentWith"),
    cmd("Refactor...", "edit.refactor"),
    cmd("Source Action...", "edit.sourceAction"),
    SEPARATOR,
    cmd("Start Dictation in Editor", "edit.startDictation"),
    SEPARATOR,
    openChangesMenu(),
    remoteMenu(),
    sub("File Annotations", [...list(ANNOTATION_COMMANDS), SEPARATOR, cmd("Open File Annotation Settings", "git.openAnnotationSettings")]),
    historyMenu(),
    SEPARATOR,
    sub("Share", [cmd("Copy vscode.dev Link", "git.copyVscodeDevLink")]),
    SEPARATOR,
    cmd("Cut", "edit.cut"),
    cmd("Copy", "edit.copy"),
    cmd("Paste", "edit.paste"),
    copyAsMenu(),
    SEPARATOR,
    cmd("Add to OpenMindAI Chat", "openmindAi.addToChat"),
    ...(extra.length > 0 ? [SEPARATOR, ...extra] : []),
    SEPARATOR,
    cmd("Command Palette...", "workbench.commandPalette"),
  ];
}

/**
 * The Git and Copy As groups for a file chosen in the Explorer or a tab (`target` is the commands' argument). Only
 * file-level actions: a line's commit means nothing without a line.
 */
export function fileGitEntries(target: unknown): MenuEntry[] {
  const args = [target];
  return [
    sub("Open Changes", list(OPEN_CHANGES_COMMANDS.slice(2), args)),
    sub("Open on Remote (Web)", list(REMOTE_COMMANDS.slice(0, 2), args)),
    historyMenu(args),
    sub("Share", [cmd("Copy vscode.dev Link", "git.copyVscodeDevLink", args)]),
    sub("Copy As", list(COPY_AS_COMMANDS.slice(0, 5), args)),
    cmd("Add File to Chat", "openmindAi.addFileToChat", args),
  ];
}

/** Every command id the editor menu names (tests check each is registered). */
export function editorMenuCommandIds(): string[] {
  const ids: string[] = [];
  const walk = (entries: MenuEntry[]) => {
    for (const entry of entries) {
      if (entry.kind === "command") ids.push(entry.command);
      else if (entry.kind === "submenu") walk(entry.items);
    }
  };
  walk(editorContextMenu([]));
  return ids;
}
