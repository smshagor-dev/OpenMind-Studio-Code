import * as monaco from "monaco-editor";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CommandRegistry } from "../commandRegistry";
import type { FileGitRemote } from "../git/fileGitRemote";
import type { FileGitService } from "../git/fileGitService";
import type { GitViewsService } from "../git/gitViewsService";
import { ContextMenuService } from "./contextMenuService";
import { RevisionMenu, revisionMenuEntries, type MenuHostEditor } from "./revisionMenu";

const HASH = "a".repeat(40);
const models: monaco.editor.ITextModel[] = [];
afterEach(() => {
  for (const model of models.splice(0)) model.dispose();
});

function setup() {
  const commands = new CommandRegistry();
  const menu = new ContextMenuService();
  const git = {
    commitDetails: vi.fn(() =>
      Promise.resolve({
        hash: HASH,
        parents: [],
        author: "Ada",
        authorEmail: "a@x",
        authorTime: 1,
        committer: "Ada",
        committerEmail: "a@x",
        commitTime: 1,
        message: "subject\n\nbody",
        files: [],
      }),
    ),
    compareCommitWithWorking: vi.fn(() => Promise.resolve()),
    showCommitChange: vi.fn(() => Promise.resolve()),
    previousOf: vi.fn(() => Promise.resolve(null)),
  };
  const remote = { revisionOnRemote: vi.fn(() => Promise.resolve()) };
  const views = { showCommit: vi.fn(() => Promise.resolve()), openHistory: vi.fn(() => Promise.resolve()) };
  const copy = vi.fn(() => Promise.resolve());
  const revisions = new RevisionMenu({
    commands,
    menu,
    git: git as unknown as FileGitService,
    remote: remote as unknown as FileGitRemote,
    views: views as unknown as GitViewsService,
    copy,
    notice: vi.fn(),
    openWorkingFile: vi.fn(() => Promise.resolve()),
    t: (key) => key,
  });
  const uri = revisions.remember({ path: "C:/r/a.ts", hash: HASH, relative: "old/a.ts" });
  const model = monaco.editor.createModel("one\ntwo\n", "plaintext");
  models.push(model);
  let contextMenu: ((event: monaco.editor.IEditorMouseEvent) => void) | null = null;
  const editor: MenuHostEditor = {
    getModel: () => model,
    getSelection: () => new monaco.Selection(2, 1, 2, 1),
    getPosition: () => new monaco.Position(2, 1),
    trigger: vi.fn(),
    focus: vi.fn(),
    updateOptions: vi.fn(),
    onContextMenu: (listener) => {
      contextMenu = listener;
      return { dispose: () => undefined };
    },
  };
  return { commands, menu, git, remote, views, copy, revisions, uri, editor, open: () => contextMenu };
}

describe("revision tab menu", () => {
  it("offers only read-only actions", () => {
    const ids = revisionMenuEntries("git-revision:/x/a.ts").flatMap((entry) =>
      entry.kind === "command" ? [entry.command] : [],
    );
    expect(ids).toContain("revision.copy");
    expect(ids).toContain("revision.compareWithWorking");
    for (const editing of ["edit.cut", "edit.paste", "revision.cut", "revision.paste", "edit.formatDocument"]) {
      expect(ids).not.toContain(editing);
    }
  });

  it("replaces Monaco's menu and runs the commands for its own tab", async () => {
    const s = setup();
    s.revisions.attach(s.editor, s.uri);
    expect(s.editor.updateOptions).toHaveBeenCalledWith({ contextmenu: false });
    const preventDefault = vi.fn();
    s.open()?.({
      event: { posx: 10, posy: 20, preventDefault, stopPropagation: vi.fn() },
    } as unknown as monaco.editor.IEditorMouseEvent);
    expect(preventDefault).toHaveBeenCalled();
    expect(s.menu.getState().request?.x).toBe(10);
    await s.commands.execute("revision.copy", s.uri);
    expect(s.copy).toHaveBeenCalledWith("two\n");
    await s.commands.execute("revision.compareWithWorking", s.uri);
    expect(s.git.compareCommitWithWorking).toHaveBeenCalledWith(
      "C:/r/a.ts",
      expect.objectContaining({ hash: HASH, subject: "subject", path: "old/a.ts" }),
      2,
    );
    await s.commands.execute("revision.openOnRemote", s.uri);
    expect(s.remote.revisionOnRemote).toHaveBeenCalledWith("C:/r/a.ts", HASH, "old/a.ts", { start: 2, end: 2 }, "open");
  });

  it("only recognises revisions it opened", async () => {
    const s = setup();
    expect(s.revisions.isRevision(s.uri)).toBe(true);
    expect(s.revisions.isRevision("memfs:/a.ts")).toBe(false);
    await expect(s.commands.execute("revision.showCommit", "git-revision:/unknown/a.ts")).rejects.toThrow(
      "gitFile.revisionGone",
    );
  });
});
