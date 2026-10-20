import { describe, expect, it, vi } from "vitest";

import type { EditorAiActions } from "../agent/editorAiActions";
import { CommandRegistry } from "../commandRegistry";
import type { FileGitIpc } from "../git/fileGitIpc";
import { CancelledError, type FileGitRemote } from "../git/fileGitRemote";
import type { FileGitService, GitTarget } from "../git/fileGitService";
import type { GitViewsService } from "../git/gitViewsService";
import type { MenuEntry } from "../menus";
import { ContextMenuService } from "./contextMenuService";
import { registerEditorMenuCommands, type EditorMenuDeps } from "./editorMenuCommands";
import { editorContextMenu, editorMenuCommandIds, fileGitEntries } from "./editorMenuModel";
import { FileGitProbe, gitBlocker } from "./fileGitProbe";

const TARGET: GitTarget = { path: "C:/r/a.ts", line: 4, endLine: 4 };

function labels(entries: MenuEntry[]): string[] {
  return entries.map((entry) => (entry.kind === "separator" ? "-" : entry.label));
}

function probeIpc(overrides: Partial<FileGitIpc> = {}): FileGitIpc {
  return {
    context: vi.fn(() => Promise.resolve({ root: "C:/r", name: "r", relative: "a.ts", tracked: true })),
    remotes: vi.fn(() =>
      Promise.resolve({
        remotes: [{ name: "origin", url: "git@github.com:o/r.git" }],
        branch: "main",
        upstream: null,
        head: "a",
      }),
    ),
    log: vi.fn(),
    fileAt: vi.fn(),
    refs: vi.fn(),
    published: vi.fn(),
    resolve: vi.fn(),
    commit: vi.fn(),
    blame: vi.fn(),
    ...overrides,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function remoteIpc(url: string): FileGitIpc {
  return probeIpc({
    remotes: () => Promise.resolve({ remotes: [{ name: "o", url }], branch: null, upstream: null, head: null }),
  });
}

describe("editor context menu model", () => {
  it("follows VS Code's order with OpenMindAI first and the palette last", () => {
    const top = labels(editorContextMenu([]));
    expect(top.slice(0, 4)).toEqual(["Add File to Chat", "Open Inline Chat", "Explain", "Review"]);
    expect(top.indexOf("Open Changes")).toBeLessThan(top.indexOf("Share"));
    expect(top.indexOf("Cut")).toBeLessThan(top.indexOf("Copy As"));
    expect(top.indexOf("Copy As")).toBeLessThan(top.indexOf("Add to OpenMindAI Chat"));
    expect(top[top.length - 1]).toBe("Command Palette...");
    expect(top.join(" ")).not.toMatch(/codex/i);
  });

  it("lists every requested submenu entry", () => {
    const ids = editorMenuCommandIds();
    for (const id of [
      "git.openLineChangesWithPrevious",
      "git.openLineChangesWithWorking",
      "git.openChangesWithPrevious",
      "git.openChangesWithRevision",
      "git.openChangesWithBranchOrTag",
      "git.quickShowLineCommit",
      "git.inspectLineCommit",
      "git.openFileOnRemote",
      "git.openFileOnRemoteFrom",
      "git.openCommitOnRemote",
      "git.toggleFileBlame",
      "git.toggleFileHeatmap",
      "git.toggleFileChanges",
      "git.openAnnotationSettings",
      "git.openFileHistory",
      "git.openFileHistoryGraph",
      "git.openVisualFileHistory",
      "git.quickOpenFileHistory",
      "git.copyVscodeDevLink",
      "copyAs.relativePath",
      "copyAs.fileLink",
      "copyAs.fileLinkAtRevision",
      "copyAs.remoteFileUrl",
      "copyAs.remoteFileUrlFrom",
      "copyAs.remoteCommitUrl",
      "copyAs.sha",
      "copyAs.message",
    ]) {
      expect(ids, id).toContain(id);
    }
  });

  it("adds contributed commands before the palette, and Explorer/tab entries carry their file", () => {
    const top = labels(editorContextMenu([{ command: "ext.say", label: "Say Hello" }]));
    expect(top.indexOf("Say Hello")).toBeGreaterThan(top.indexOf("Add to OpenMindAI Chat"));
    const serialized = JSON.stringify(fileGitEntries(TARGET));
    expect(serialized).toContain("C:/r/a.ts");
    // Line-based actions make no sense without a line.
    expect(serialized).not.toContain("git.quickShowLineCommit");
    expect(serialized).not.toContain("copyAs.sha");
  });
});

describe("FileGitProbe and gitBlocker", () => {
  const text = (key: string) => key;

  it("answers in the background and redraws its listeners", async () => {
    const probe = new FileGitProbe(probeIpc());
    const changed = vi.fn();
    probe.subscribe(changed);
    expect(probe.get(TARGET.path).repository).toBeNull();
    await settle();
    expect(changed).toHaveBeenCalled();
    const result = probe.get(TARGET.path);
    expect(result).toMatchObject({ repository: true, tracked: true, remotes: 1, supportedRemotes: 1, github: true });
    expect(gitBlocker(result, "github", text)).toBeNull();
  });

  it("explains each missing requirement", async () => {
    const cases: [FileGitIpc, Parameters<typeof gitBlocker>[1], string | null][] = [
      [probeIpc({ context: () => Promise.reject(new Error("not a repo")) }), "repository", "not a repo"],
      [
        probeIpc({ context: () => Promise.resolve({ root: "r", name: "r", relative: "x", tracked: false }) }),
        "tracked",
        "gitFile.notCommitted",
      ],
      [remoteIpc("git@gitlab.com:g/r.git"), "remote", null],
      [remoteIpc("git@gitlab.com:g/r.git"), "github", "gitFile.noGithubRemote"],
      [remoteIpc("https://git.corp/r.git"), "remote", "gitFile.noSupportedRemote"],
      [probeIpc({ remotes: () => Promise.reject(new Error("x")) }), "remote", "gitFile.noRemote"],
    ];
    for (const [ipc, need, expected] of cases) {
      const probe = new FileGitProbe(ipc);
      probe.get("x");
      await settle();
      expect(gitBlocker(probe.get("x"), need, text), need).toBe(expected);
    }
  });
});

type Fake = Record<string, ReturnType<typeof vi.fn>>;

function fake(methods: string[]): Fake {
  return Object.fromEntries(methods.map((name) => [name, vi.fn(() => Promise.resolve())]));
}

/** The fakes behind the last `deps()` (asserted on directly: they are plain mocks, not methods). */
const fakes: { git: Fake; remote: Fake; views: Fake } = { git: {}, remote: {}, views: {} };

function deps(overrides: Partial<EditorMenuDeps> = {}): EditorMenuDeps {
  fakes.git = fake([
    "lineChangesWithPrevious",
    "lineChangesWithWorking",
    "changesWithPrevious",
    "changesWithRevision",
    "changesWithBranchOrTag",
    "showLineCommit",
    "quickOpenHistory",
  ]);
  fakes.remote = fake([
    "fileOnRemote",
    "fileOnRemoteFrom",
    "commitOnRemote",
    "copyVscodeDevLink",
    "linkAtRevision",
    "copyRelativePath",
    "copyFileLink",
    "copySha",
    "copyMessage",
  ]);
  fakes.views = fake(["openHistory"]);
  return {
    commands: new CommandRegistry(),
    runEditorAction: vi.fn(),
    facts: () => ({ hasEditor: true, readOnly: false }),
    lspBlocker: () => null,
    git: fakes.git as unknown as FileGitService,
    remote: fakes.remote as unknown as FileGitRemote,
    views: fakes.views as unknown as GitViewsService,
    probe: new FileGitProbe(probeIpc()),
    ai: fake(["addFileToChat", "addToChat", "explain", "review"]) as unknown as EditorAiActions,
    activeSnapshot: () => ({
      path: "C:/r/a.ts",
      relative: "a.ts",
      language: "ts",
      text: "x",
      selection: null,
      cursorLine: 1,
    }),
    fileSnapshot: vi.fn(() =>
      Promise.resolve({ path: "C:/r/b.ts", relative: "b.ts", language: "ts", text: "y", selection: null, cursorLine: 1 }),
    ),
    inlineBlocker: () => null,
    openInlineChat: vi.fn(),
    activeTarget: () => TARGET,
    toggleSetting: vi.fn(() => Promise.resolve()),
    settingOn: () => false,
    openSettings: vi.fn(),
    startDictation: vi.fn(() => Promise.resolve()),
    t: (key) => key,
    ...overrides,
  };
}

/** Commands the menu reuses from elsewhere in the app (registered by their own services). */
const REUSED = new Set([
  "go.toDefinition",
  "go.toTypeDefinition",
  "go.toImplementations",
  "go.toReferences",
  "edit.renameSymbol",
  "edit.formatDocument",
  "edit.formatDocumentWith",
  "edit.cut",
  "edit.copy",
  "edit.paste",
  "workbench.commandPalette",
]);

describe("editor menu commands", () => {
  it("registers every command the menu names", () => {
    const d = deps();
    registerEditorMenuCommands(d);
    for (const id of editorMenuCommandIds()) {
      if (!REUSED.has(id)) expect(d.commands.has(id), id).toBe(true);
    }
  });

  it("runs a Git action for the editor in front, or for the file it was given", async () => {
    const d = deps();
    registerEditorMenuCommands(d);
    await d.commands.execute("git.openChangesWithPrevious");
    expect(fakes.git.changesWithPrevious).toHaveBeenCalledWith(TARGET);
    const other = { path: "C:/r/b.ts", line: 1, endLine: 1 };
    await d.commands.execute("git.openFileHistoryGraph", other);
    expect(fakes.views.openHistory).toHaveBeenCalledWith("C:/r/b.ts", "graph");
    await d.commands.execute("openmindAi.addFileToChat", other);
    expect(d.fileSnapshot).toHaveBeenCalledWith("C:/r/b.ts");
    await d.commands.execute("edit.refactor");
    expect(d.runEditorAction).toHaveBeenCalledWith("editor.action.refactor");
  });

  it("disables editing in a read-only editor and code actions without a server, with the reason", () => {
    const readOnly = deps({ facts: () => ({ hasEditor: true, readOnly: true }) });
    registerEditorMenuCommands(readOnly);
    expect(readOnly.commands.isEnabled("edit.changeAllOccurrences")).toBe(false);
    expect(readOnly.commands.reasonFor("edit.changeAllOccurrences")).toBe("editorMenu.readOnly");
    const noServer = deps({ lspBlocker: () => "No language server supports this file type." });
    registerEditorMenuCommands(noServer);
    expect(noServer.commands.reasonFor("edit.refactor")).toBe("No language server supports this file type.");
    expect(noServer.commands.isEnabled("go.peekDefinition")).toBe(false);
  });

  it("disables Git entries for an unsaved file and judges another file by its own Git state", async () => {
    const d = deps({ activeTarget: () => null });
    const { reasonForFile } = registerEditorMenuCommands(d);
    expect(d.commands.reasonFor("git.openFileHistory")).toBe("gitFile.saveFirst");
    reasonForFile("git.openFileOnRemote", "C:/r/b.ts");
    await settle();
    expect(reasonForFile("git.openFileOnRemote", "C:/r/b.ts")).toBeNull();
    expect(reasonForFile("tab.close", "C:/r/b.ts")).toBeNull();
  });

  it("a closed picker isn't an error", async () => {
    const d = deps();
    fakes.remote.fileOnRemote = vi.fn(() => Promise.reject(new CancelledError()));
    registerEditorMenuCommands({ ...d, remote: fakes.remote as unknown as FileGitRemote });
    await expect(d.commands.execute("git.openFileOnRemote")).resolves.toBeUndefined();
  });

  it("annotation toggles show their state and flip their setting", async () => {
    const d = deps({ settingOn: (id) => id === "git.annotations.heatmap" });
    registerEditorMenuCommands(d);
    expect(d.commands.isChecked("git.toggleFileHeatmap")).toBe(true);
    expect(d.commands.isChecked("git.toggleFileBlame")).toBe(false);
    await d.commands.execute("git.toggleFileBlame");
    expect(d.toggleSetting).toHaveBeenCalledWith("git.annotations.blame");
    await d.commands.execute("git.openAnnotationSettings");
    expect(d.openSettings).toHaveBeenCalledWith("git.annotations");
  });
});

describe("ContextMenuService", () => {
  it("opens, redraws while open, and tells the opener when it was dismissed", () => {
    const menu = new ContextMenuService();
    const dismissed = vi.fn();
    const before = menu.getState();
    menu.open({ x: 1, y: 2, ariaLabel: "m", entries: () => [], onDismiss: dismissed });
    expect(menu.getState()).not.toBe(before);
    expect(menu.getState()).toBe(menu.getState());
    const opened = menu.getState();
    menu.refresh();
    expect(menu.getState().revision).toBe(opened.revision + 1);
    menu.close(true);
    expect(dismissed).toHaveBeenCalledTimes(1);
    expect(menu.isOpen()).toBe(false);
    menu.refresh();
    menu.close(true);
    expect(dismissed).toHaveBeenCalledTimes(1);
  });
});
