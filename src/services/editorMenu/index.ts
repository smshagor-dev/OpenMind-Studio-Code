// The editor's context menu and everything it reaches (per-file Git views and annotations, OpenMindAI actions, inline
// chat), built from the app's own services. Kept out of container.ts, which is at its size limit; installed once by
// the main workbench (`installEditorMenu`).
import { invoke } from "@tauri-apps/api/core";
import * as monaco from "monaco-editor";

import { languageForPath } from "../../editor/languageForPath";
import { i18n, t } from "../../i18n";
import { agent } from "../agent";
import { EditorAiActions, type EditorSnapshot } from "../agent/editorAiActions";
import { InlineChatService, tauriInlineIpc } from "../agent/inlineChat";
import { container } from "../container";
import { ANNOTATION_SETTINGS, FileAnnotationsService } from "../git/fileAnnotations";
import { tauriFileGitIpc } from "../git/fileGitIpc";
import { FileGitRemote, relativeTo } from "../git/fileGitRemote";
import { FileGitService, type FileGitHost, type GitTarget } from "../git/fileGitService";
import { GitViewsService } from "../git/gitViewsService";
import { ContextMenuService } from "./contextMenuService";
import { registerEditorMenuCommands } from "./editorMenuCommands";
import {
  ANNOTATION_COMMANDS,
  COPY_AS_COMMANDS,
  HISTORY_COMMANDS,
  LINE_COMMIT_COMMANDS,
  OPEN_CHANGES_COMMANDS,
  REMOTE_COMMANDS,
  editorContextMenu,
  fileGitEntries,
} from "./editorMenuModel";
import type { MenuEntry } from "../menus";
import { FileGitProbe } from "./fileGitProbe";
import { setRevisionAttach } from "./revisionHook";
import { RevisionMenu, type MenuHostEditor } from "./revisionMenu";

type MonacoEditor = monaco.editor.IStandaloneCodeEditor;

const ipc = tauriFileGitIpc;
export const gitViews = new GitViewsService(ipc);
export const contextMenu = new ContextMenuService();
export const gitProbe = new FileGitProbe(ipc);

function notice(message: string): void {
  container.events.emit("appNotice", { message });
}

/** The real Monaco editor in front (the service's editors are typed structurally). */
function currentEditor(): MonacoEditor | null {
  const editor = container.editor.current();
  return editor !== null && "onContextMenu" in editor ? (editor as MonacoEditor) : null;
}

function pathOfModel(model: monaco.editor.ITextModel): string | null {
  const id = container.documents.idForModelUri(model.uri.toString());
  if (id === undefined) return null;
  return container.documents.snapshot(id).path;
}

/** The open buffer's text for a file (unsaved edits included), or `null` when it isn't open. */
function bufferText(path: string): string | null {
  const id = container.documents.idForPath(path);
  const uri = id === null ? null : container.documents.modelUri(id);
  return uri === null ? null : (monaco.editor.getModel(monaco.Uri.parse(uri))?.getValue() ?? null);
}

function language(path: string): string {
  return languageForPath(path.replace(/\\/g, "/"));
}

const host: FileGitHost = {
  ipc,
  views: gitViews,
  bufferText,
  pick: async (placeholder, items) => {
    const answer = await container.extensions.prompts.quickPick({
      extension: "Git",
      items,
      placeHolder: placeholder,
      canPickMany: false,
    });
    return typeof answer === "number" ? answer : null;
  },
  copy: (text) => container.ipc.clipboardWriteText(text),
  openUrl: (url) => container.ipc.openExternalUrl(url),
  openRevision: (path, revision, relative, text) => {
    if (revisionMenu === null) return;
    container.workspace.openVirtualDocument({
      uri: revisionMenu.remember({ path, hash: revision, relative }),
      text,
      language: language(path),
      extension: `Git ${revision.slice(0, 7)}`,
      readonly: true,
    });
  },
  notice,
  t,
};

export const fileGit = new FileGitService(host);
export const fileGitRemote = new FileGitRemote(host, fileGit, () => container.workspace.getActiveWorkspace()?.path ?? null);

export const annotations = new FileAnnotationsService({
  ipc,
  blame: (path) => fileGit.blame(path),
  pathOf: pathOfModel,
  settings: container.settings,
  locale: () => i18n.language,
  log: (line) => {
    container.output.append("Git", line);
  },
});

/** The file and line(s) of the editor in front, or `null` (untitled, a preview, no editor). */
function activeTarget(): GitTarget | null {
  const editor = currentEditor();
  const model = editor?.getModel();
  const selection = editor?.getSelection();
  if (!model || !selection) return null;
  const path = pathOfModel(model);
  if (path === null) return null;
  return { path, line: selection.startLineNumber, endLine: selection.endLineNumber };
}

function relative(path: string): string {
  const root = container.workspace.getActiveWorkspace()?.path ?? null;
  return (root === null ? null : relativeTo(root, path))?.replace(/\\/g, "/") ?? (path.split(/[\\/]/).pop() ?? path);
}

function activeSnapshot(): EditorSnapshot | null {
  const editor = currentEditor();
  const model = editor?.getModel();
  const selection = editor?.getSelection();
  if (!model || !selection) return null;
  const path = pathOfModel(model) ?? model.uri.path;
  return {
    path,
    relative: relative(path),
    language: model.getLanguageId(),
    text: model.getValue(),
    selection: selection.isEmpty()
      ? null
      : { startLine: selection.startLineNumber, endLine: selection.endLineNumber, text: model.getValueInRange(selection) },
    cursorLine: selection.positionLineNumber,
  };
}

async function fileSnapshot(path: string): Promise<EditorSnapshot> {
  let text = bufferText(path);
  if (text === null) {
    const disk = await container.ipc.documentRead(path);
    if (disk.state !== "file") throw new Error(t("editorAi.unreadable", { path }));
    text = disk.content;
  }
  return { path, relative: relative(path), language: language(path), text, selection: null, cursorLine: 1 };
}

export const editorAi = new EditorAiActions({
  attachText: (name, text) => {
    agent.attachText(name, text);
  },
  send: (text, attachments, mode) => agent.send(text, false, attachments, undefined, mode),
  blocker: () => agent.sendBlocker(),
  showAgent: () => {
    void container.layout.showView("agent");
  },
  notice,
  t,
});

export const inlineChat = new InlineChatService({
  ipc: tauriInlineIpc,
  model: () => {
    const state = agent.getState();
    const blocked = agent.sendBlocker();
    if (blocked !== null || !state.modelId) return { blocked: blocked ?? t("agent.blocker.noModel") };
    const options = agent.options();
    return { modelId: state.modelId, useGpu: options.useGpu, contextTokens: options.contextTokens };
  },
  describe: (model) => {
    const path = pathOfModel(model);
    return { name: path === null ? model.uri.path : relative(path), language: model.getLanguageId() };
  },
  t,
});

function readOnly(editor: MonacoEditor | null): boolean {
  return editor?.getOption(monaco.editor.EditorOption.readOnly) === true;
}

function inlineBlocker(): string | null {
  const editor = currentEditor();
  if (editor?.getModel() == null) return t("editorMenu.openFile");
  if (readOnly(editor)) return t("editorMenu.readOnly");
  return null;
}

/** Opens the context menu for `editor` at a screen point (or at the cursor for the keyboard). */
export function openEditorMenu(editor: MonacoEditor, x: number | null, y: number | null): void {
  let left = x;
  let top = y;
  if (left === null || top === null) {
    const position = editor.getPosition();
    const visible = position ? editor.getScrolledVisiblePosition(position) : null;
    const rect = editor.getDomNode()?.getBoundingClientRect();
    left = (rect?.left ?? 0) + (visible?.left ?? 0);
    top = (rect?.top ?? 0) + (visible?.top ?? 0) + (visible?.height ?? 0);
  }
  const target = activeTarget();
  if (target !== null) gitProbe.get(target.path);
  contextMenu.open({
    x: left,
    y: top,
    ariaLabel: t("editorMenu.label"),
    entries: () => editorContextMenu(container.editor.contextMenuActions()),
    onDismiss: () => {
      editor.focus();
    },
  });
}

/** Every editor: our context menu instead of Monaco's (which can't nest menus), and the Git annotations. */
function attachEditor(editor: MonacoEditor): () => void {
  editor.updateOptions({ contextmenu: false });
  const menu = editor.onContextMenu((event) => {
    event.event.preventDefault();
    event.event.stopPropagation();
    const keyboard = event.event.posx === 0 && event.event.posy === 0;
    openEditorMenu(editor, keyboard ? null : event.event.posx, keyboard ? null : event.event.posy);
  });
  const detachAnnotations = annotations.attach(editor);
  return () => {
    menu.dispose();
    detachAnnotations();
  };
}

/** A real file on disk (not untitled, not a virtual document). */
function isFilePath(path: string | null): path is string {
  return path !== null && (/^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\") || path.startsWith("/"));
}

function findTab(groupId: string, tabId: string) {
  return container.workspace
    .getState()
    .groups.find((group) => group.id === groupId)
    ?.tabs.find((tab) => tab.id === tabId);
}

/** The context menu of an editor tab: close, paths, reveal, and the file's Git and Copy As groups. */
export function openTabMenu(groupId: string, tabId: string, x: number, y: number): void {
  const tab = findTab(groupId, tabId);
  if (tab === undefined) return;
  const args = [groupId, tabId];
  const path = isFilePath(tab.path) ? tab.path : null;
  if (path !== null) gitProbe.get(path);
  const entry = (label: string, command: string): MenuEntry => ({ kind: "command", label, command, args });
  contextMenu.open({
    x,
    y,
    ariaLabel: t("tabMenu.label"),
    entries: () => [
      entry("Close", "tab.close"),
      entry("Close Others", "tab.closeOthers"),
      entry("Close All", "tab.closeAll"),
      { kind: "separator" },
      entry("Copy Path", "tab.copyPath"),
      entry("Reveal in Explorer View", "tab.reveal"),
      ...(path === null ? [] : [{ kind: "separator" } as MenuEntry, ...fileGitEntries({ path, line: 1, endLine: 1 })]),
    ],
  });
}

function registerTabCommands(): void {
  const tabOf = (args: unknown[]) => findTab(String(args[0]), String(args[1]));
  const { commands, workspace } = container;
  commands.register("tab.close", (...args) => workspace.closeTab(String(args[0]), String(args[1])));
  commands.register("tab.closeOthers", (...args) =>
    workspace.closeTabsWhere(String(args[0]), (tab) => tab.id !== String(args[1])),
  );
  commands.register("tab.closeAll", (...args) => workspace.closeAll(String(args[0])));
  commands.register("tab.copyPath", async (...args) => {
    const path = tabOf(args)?.path;
    if (!path) throw new Error(t("gitFile.saveFirst"));
    await container.ipc.clipboardWriteText(path);
    notice(t("gitFile.copied", { text: path }));
  });
  commands.register("tab.reveal", async (...args) => {
    const path = tabOf(args)?.path;
    if (!isFilePath(path ?? null) || !path) throw new Error(t("gitFile.saveFirst"));
    await container.layout.showView("explorer");
    await container.explorer.revealPath(path);
  });
}

/** The menu's commands in the command palette (F1 / Ctrl+Shift+P), each under its area's name. */
function registerPaletteEntries(): void {
  const label = (command: string, english: string) => {
    const key = `command.${command}`;
    const text = t(key);
    return text === key ? english : text;
  };
  const git: (readonly [string, string])[] = [
    ...OPEN_CHANGES_COMMANDS,
    ...LINE_COMMIT_COMMANDS,
    ...REMOTE_COMMANDS,
    ...ANNOTATION_COMMANDS,
    ["Open File Annotation Settings", "git.openAnnotationSettings"],
    ...HISTORY_COMMANDS,
    ["Copy vscode.dev Link", "git.copyVscodeDevLink"],
    ...COPY_AS_COMMANDS,
  ];
  const ai: [string, string][] = [
    ["Add File to Chat", "openmindAi.addFileToChat"],
    ["Open Inline Chat", "openmindAi.inlineChat"],
    ["Explain", "openmindAi.explain"],
    ["Review", "openmindAi.review"],
    ["Add to OpenMindAI Chat", "openmindAi.addToChat"],
  ];
  const editing: [string, string][] = [
    ["Change All Occurrences", "edit.changeAllOccurrences"],
    ["Refactor...", "edit.refactor"],
    ["Source Action...", "edit.sourceAction"],
    ["Start Dictation in Editor", "edit.startDictation"],
  ];
  const entries = (prefix: string, list: readonly (readonly [string, string])[]) =>
    list.map(([english, command]) => ({
      command,
      label: prefix === "" ? label(command, english) : `${prefix}: ${label(command, english)}`,
      inContextMenu: false,
    }));
  container.editor.setAppActions(
    [...entries("OpenMindAI", ai), ...entries("Git", git), ...entries("", editing)],
    "editorMenu",
  );
}

/** Read-only revision tabs' context menu (created with the commands, at install). */
let revisionMenu: RevisionMenu | null = null;

/** A read-only preview editor: a Git revision tab gets the shared menu (read-only actions only). */
function attachRevisionEditor(editor: MenuHostEditor, uri: string | null): (() => void) | undefined {
  return revisionMenu?.isRevision(uri) ? revisionMenu.attach(editor, uri) : undefined;
}

let installed: { reasonForFile: (command: string, path: string) => string | null } | null = null;

/** Wires the menu, its commands and the annotations into the app (once per window). */
export function installEditorMenu(): { reasonForFile: (command: string, path: string) => string | null } {
  if (installed !== null) return installed;
  const result = registerEditorMenuCommands({
    commands: container.commands,
    runEditorAction: (id) => {
      container.editor.run(id);
    },
    facts: () => {
      const editor = currentEditor();
      return { hasEditor: editor?.getModel() != null, readOnly: readOnly(editor) };
    },
    lspBlocker: (action) =>
      container.editor.hasEditor() ? (container.lsp.activeAvailable(action).reason ?? null) : t("editorMenu.openFile"),
    git: fileGit,
    remote: fileGitRemote,
    views: gitViews,
    probe: gitProbe,
    ai: editorAi,
    activeSnapshot,
    fileSnapshot,
    inlineBlocker,
    openInlineChat: () => {
      const editor = currentEditor();
      const selection = editor?.getSelection();
      if (!editor || !selection) return;
      inlineChat.open(editor, selection);
    },
    activeTarget,
    toggleSetting: async (id) => {
      await container.settings.setEffective(id, !container.settings.bool(id, false));
    },
    settingOn: (id) => container.settings.bool(id, false),
    openSettings: (query) => {
      container.preferencesPage.open("settings", { query });
    },
    startDictation: async () => {
      currentEditor()?.focus();
      await invoke("dictation_toggle");
    },
    t,
  });
  installed = result;
  registerTabCommands();
  revisionMenu = new RevisionMenu({
    commands: container.commands,
    menu: contextMenu,
    git: fileGit,
    remote: fileGitRemote,
    views: gitViews,
    copy: (text) => container.ipc.clipboardWriteText(text),
    notice,
    openWorkingFile: async (path, line) => {
      await container.workspace.openPathAt(path, { line, column: 1, length: 0 });
    },
    t,
  });
  setRevisionAttach(attachRevisionEditor);
  registerPaletteEntries();
  // The palette's names follow the UI language.
  i18n.subscribe(registerPaletteEntries);
  // Ctrl+I opens inline chat (Monaco also binds it to Trigger Suggest; Ctrl+Space still does that) and Shift+F10 this
  // menu (Monaco's own context menu is off).
  monaco.editor.addKeybindingRules([
    { keybinding: monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI, command: "-editor.action.triggerSuggest" },
    { keybinding: monaco.KeyMod.Shift | monaco.KeyCode.F10, command: "-editor.action.showContextMenu" },
  ]);
  container.editor.onEditorAttached((editor) =>
    "onContextMenu" in editor ? attachEditor(editor as MonacoEditor) : undefined,
  );
  container.commands.register("editor.showContextMenu", () => {
    const editor = currentEditor();
    if (editor) openEditorMenu(editor, null, null);
  });
  container.events.on("documentSaved", ({ path }) => {
    fileGit.invalidate(path);
    annotations.refreshAll(path);
  });
  container.settings.onChange(ANNOTATION_SETTINGS, () => {
    annotations.refreshAll();
  });
  container.events.on("workspaceFolderChanged", () => {
    gitViews.closeAll();
    gitProbe.invalidate();
    fileGit.invalidate();
    inlineChat.close();
  });
  // Commits, checkouts and stashes change what Git says about every file: follow the repository's status (not every
  // notification — typing a commit message notifies too).
  let snapshot = container.sourceControl.getState().snapshot;
  container.sourceControl.subscribe(() => {
    const next = container.sourceControl.getState().snapshot;
    if (next === snapshot) return;
    snapshot = next;
    gitProbe.invalidate();
    fileGit.invalidate();
    annotations.refreshAll();
  });
  gitProbe.subscribe(() => {
    contextMenu.refresh();
  });
  return result;
}
