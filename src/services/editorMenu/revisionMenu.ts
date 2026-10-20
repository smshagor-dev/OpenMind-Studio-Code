import type * as monaco from "monaco-editor";

import type { CommandRegistry } from "../commandRegistry";
import type { FileCommit } from "../git/fileGitIpc";
import type { FileGitRemote } from "../git/fileGitRemote";
import type { FileGitService } from "../git/fileGitService";
import type { GitViewsService } from "../git/gitViewsService";
import type { MenuEntry } from "../menus";
import type { ContextMenuService } from "./contextMenuService";

/** A file's text at a commit, shown in a read-only tab (`git-revision:/<hash>/<repo-relative name>`). */
export interface RevisionDocument {
  /** The working file's absolute path (Git commands run in its repository). */
  path: string;
  hash: string;
  /** The file's name in that commit. */
  relative: string;
}

/** The editor API the revision menu uses (structural; the real one is Monaco's). */
export interface RevisionEditor {
  getModel: () => monaco.editor.ITextModel | null;
  getSelection: () => monaco.Selection | null;
  getPosition: () => monaco.Position | null;
  trigger: (source: string, handlerId: string, payload: unknown) => void;
  focus: () => void;
}

export interface MenuHostEditor extends RevisionEditor {
  updateOptions: (options: monaco.editor.IEditorOptions) => void;
  onContextMenu: (listener: (event: monaco.editor.IEditorMouseEvent) => void) => monaco.IDisposable;
}

export interface RevisionMenuDeps {
  commands: CommandRegistry;
  menu: ContextMenuService;
  git: FileGitService;
  remote: FileGitRemote;
  views: GitViewsService;
  copy: (text: string) => Promise<void>;
  notice: (message: string) => void;
  openWorkingFile: (path: string, line: number) => Promise<void>;
  t: (key: string, params?: Record<string, string | number>) => string;
}

export function revisionUri(hash: string, relative: string): string {
  return `git-revision:/${hash}/${relative}`;
}

/** Only read-only actions: there is nothing to edit or save in a past revision. */
export function revisionMenuEntries(uri: string): MenuEntry[] {
  const args = [uri];
  const cmd = (label: string, command: string): MenuEntry => ({ kind: "command", label, command, args });
  return [
    cmd("Copy", "revision.copy"),
    { kind: "separator" },
    cmd("Find", "revision.find"),
    cmd("Go to Line/Column...", "revision.goToLine"),
    { kind: "separator" },
    cmd("Compare with Working File", "revision.compareWithWorking"),
    cmd("Compare with Previous Revision", "revision.compareWithPrevious"),
    cmd("Show Commit Details", "revision.showCommit"),
    cmd("Open File History", "revision.openFileHistory"),
    cmd("Open Working File", "revision.openWorkingFile"),
    { kind: "separator" },
    cmd("Copy SHA", "revision.copySha"),
    cmd("Open File at Revision on Remote", "revision.openOnRemote"),
    { kind: "separator" },
    cmd("Command Palette...", "revision.commandPalette"),
  ];
}

/**
 * The context menu of read-only revision tabs. Keeps which tab shows which revision (and its editor), opens the
 * shared OpenMind menu there instead of Monaco's, and registers the commands that menu runs (each takes the tab's
 * URI as its argument, so it acts on that tab and not on the editor in front).
 */
export class RevisionMenu {
  private readonly documents = new Map<string, RevisionDocument>();
  private readonly editors = new Map<string, RevisionEditor>();

  constructor(private readonly deps: RevisionMenuDeps) {
    this.register();
  }

  /** Remembers what a revision tab shows; returns its URI. */
  remember(document: RevisionDocument): string {
    const uri = revisionUri(document.hash, document.relative);
    this.documents.set(uri, document);
    return uri;
  }

  isRevision(uri: string | null): uri is string {
    return uri !== null && this.documents.has(uri);
  }

  /** The tab's editor gets the shared menu instead of Monaco's. Returns the matching detach function. */
  attach(editor: MenuHostEditor, uri: string): () => void {
    editor.updateOptions({ contextmenu: false });
    this.editors.set(uri, editor);
    const listener = editor.onContextMenu((event) => {
      event.event.preventDefault();
      event.event.stopPropagation();
      this.deps.menu.open({
        x: event.event.posx,
        y: event.event.posy,
        ariaLabel: this.deps.t("editorMenu.label"),
        entries: () => revisionMenuEntries(uri),
        onDismiss: () => {
          editor.focus();
        },
      });
    });
    return () => {
      listener.dispose();
      if (this.editors.get(uri) === editor) this.editors.delete(uri);
    };
  }

  private document(args: unknown[]): RevisionDocument {
    const document = typeof args[0] === "string" ? this.documents.get(args[0]) : undefined;
    if (document === undefined) throw new Error(this.deps.t("gitFile.revisionGone"));
    return document;
  }

  private editor(args: unknown[]): RevisionEditor | undefined {
    return typeof args[0] === "string" ? this.editors.get(args[0]) : undefined;
  }

  private line(args: unknown[]): number {
    return this.editor(args)?.getPosition()?.lineNumber ?? 1;
  }

  /** The revision as a history entry (its subject from the commit). */
  private async commit(document: RevisionDocument): Promise<FileCommit> {
    const details = await this.deps.git.commitDetails(document.path, document.hash);
    return {
      hash: document.hash,
      shortHash: document.hash.slice(0, 7),
      parents: details.parents,
      author: details.author,
      email: details.authorEmail,
      authorTime: details.authorTime,
      committer: details.committer,
      commitTime: details.commitTime,
      subject: details.message.split("\n")[0] ?? "",
      path: document.relative,
      additions: null,
      deletions: null,
    };
  }

  private register(): void {
    const run = (id: string, action: (args: unknown[]) => Promise<void> | void) => {
      this.deps.commands.register(id, (...args) => action(args));
    };
    run("revision.copy", (args) => this.copySelection(args));
    const trigger = (action: string) => (args: unknown[]) => {
      const editor = this.editor(args);
      editor?.focus();
      editor?.trigger("menu", action, null);
    };
    run("revision.find", trigger("actions.find"));
    run("revision.goToLine", trigger("editor.action.gotoLine"));
    run("revision.commandPalette", trigger("editor.action.quickCommand"));
    this.registerGit(run);
  }

  private async copySelection(args: unknown[]): Promise<void> {
    const editor = this.editor(args);
    const model = editor?.getModel();
    const selection = editor?.getSelection();
    if (!editor || !model || !selection) return;
    const text = selection.isEmpty()
      ? model.getLineContent(selection.startLineNumber) + model.getEOL()
      : model.getValueInRange(selection);
    await this.deps.copy(text);
    editor.focus();
  }

  private registerGit(run: (id: string, action: (args: unknown[]) => Promise<void> | void) => void): void {
    const { git, views, remote } = this.deps;
    run("revision.compareWithWorking", async (args) => {
      const document = this.document(args);
      await git.compareCommitWithWorking(document.path, await this.commit(document), this.line(args));
    });
    run("revision.compareWithPrevious", async (args) => {
      const document = this.document(args);
      const commit = await this.commit(document);
      await git.showCommitChange(document.path, commit, await git.previousOf(document.path, commit), this.line(args));
    });
    run("revision.showCommit", (args) => {
      const document = this.document(args);
      return views.showCommit(document.path, document.hash, false, null);
    });
    run("revision.openFileHistory", (args) => views.openHistory(this.document(args).path, "list"));
    run("revision.openWorkingFile", (args) => this.deps.openWorkingFile(this.document(args).path, this.line(args)));
    run("revision.copySha", async (args) => {
      const { hash } = this.document(args);
      await this.deps.copy(hash);
      this.deps.notice(this.deps.t("gitFile.copied", { text: hash }));
    });
    run("revision.openOnRemote", async (args) => {
      const document = this.document(args);
      const line = this.line(args);
      await remote.revisionOnRemote(document.path, document.hash, document.relative, { start: line, end: line }, "open");
    });
  }
}
