import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { BufferManager } from "./bufferManager";
import { CommandRegistry } from "./commandRegistry";
import { DocumentService } from "./documentService";
import { EditorAssociationService } from "./editorAssociationService";
import { registerEditorCommands } from "./editorCommands";
import { EditorGroupService } from "./editorGroupService";
import { buildEditorActionsMenu, type HeaderMenuRow } from "./editorHeaderMenu";
import { parseLayout } from "./editorLayoutService";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { IpcClient, OpenedDocument } from "./ipc";
import { LayoutService } from "./layoutService";
import { MarkdownPreviewService, resolveSiblingPath } from "./markdownPreviewService";
import { OpenEditorsService } from "./openEditorsService";
import { PreviewEditorService } from "./previewEditorService";
import { WorkspaceService } from "./workspaceService";

// Only languages without a lazily-loaded, worker-backed service (see CLAUDE.md, Milestone 3.6).
const FILES: Record<string, string> = {
  "C:/p/a.rs": "fn a() {}",
  "C:/p/b.rs": "fn b() {}",
  "C:/p/notes.md": "# Notes\n\nSee [b](b.rs)",
  "C:/p/other.md": "# Other",
};

function opened(path: string): OpenedDocument {
  return { path, content: FILES[path] ?? "", encoding: "utf8", lineEnding: "lf" };
}

interface Rig {
  ipc: IpcClient;
  events: EventBus<AppEvents>;
  documents: DocumentService;
  groups: EditorGroupService;
  associations: EditorAssociationService;
  previews: PreviewEditorService;
  workspace: WorkspaceService;
  openEditors: OpenEditorsService;
  markdown: MarkdownPreviewService;
  settings: Map<string, string>;
}

function rig(): Rig {
  const settings = new Map<string, string>();
  const ipc = createFakeIpc({
    documentOpen: vi.fn((path: string) => Promise.resolve(opened(path))),
    settingsGet: vi.fn((key: string) => Promise.resolve(settings.get(key) ?? null)),
    settingsSet: vi.fn((key: string, value: string) => {
      settings.set(key, value);
      return Promise.resolve();
    }),
  });
  const events = new EventBus<AppEvents>();
  const documents = new DocumentService(ipc, new BufferManager(), events);
  const groups = new EditorGroupService();
  const associations = new EditorAssociationService(ipc);
  const previews = new PreviewEditorService(ipc);
  const workspace = new WorkspaceService(documents, ipc, events, {
    groups,
    associations,
    previews,
  });
  return {
    ipc,
    events,
    documents,
    groups,
    associations,
    previews,
    workspace,
    openEditors: new OpenEditorsService(workspace),
    markdown: new MarkdownPreviewService(workspace, groups, ipc, events),
    settings,
  };
}

describe("editor groups through WorkspaceService", () => {
  let r: Rig;
  beforeEach(() => {
    r = rig();
  });

  const titles = (groupIndex = 0) =>
    r.workspace.getState().groups[groupIndex]?.tabs.map((tab) => tab.title);

  it("Split Editor Right shows the same document in a second group, sharing one document", async () => {
    await r.workspace.openPath("C:/p/a.rs");

    r.workspace.splitRight();

    const state = r.workspace.getState();
    expect(state.groups).toHaveLength(2);
    expect(titles(0)).toEqual(["a.rs"]);
    expect(titles(1)).toEqual(["a.rs"]);
    expect(state.activeGroupId).toBe(state.groups[1]?.id);
    expect(r.ipc.documentOpen).toHaveBeenCalledTimes(1);
  });

  it("closing a tab in one group keeps the document while another group shows it", async () => {
    const id = (await r.workspace.openPath("C:/p/a.rs")) ?? "";
    r.workspace.splitRight();
    const second = r.workspace.getState().activeGroupId;

    await r.workspace.closeTab(second, id);

    expect(r.workspace.getState().groups).toHaveLength(1);
    expect(r.documents.has(id)).toBe(true);
    await r.workspace.close(id);
    expect(r.documents.has(id)).toBe(false);
  });

  it("new files open in the active group, and getState().tabs follows the active group", async () => {
    await r.workspace.openPath("C:/p/a.rs");
    r.workspace.splitRight();
    await r.workspace.openPath("C:/p/b.rs");

    expect(titles(0)).toEqual(["a.rs"]);
    expect(titles(1)).toEqual(["a.rs", "b.rs"]);
    expect(r.workspace.getState().tabs.map((tab) => tab.title)).toEqual(["a.rs", "b.rs"]);
  });

  it("Close All closes a group's tabs only, or everything when no group is given", async () => {
    await r.workspace.openPath("C:/p/a.rs");
    r.workspace.splitRight();
    await r.workspace.openPath("C:/p/b.rs");
    const firstGroup = r.workspace.getState().groups[0]?.id ?? "";

    await r.openEditors.closeAll(firstGroup);
    expect(r.workspace.getState().groups.map((g) => g.tabs.length)).toEqual([2]);

    await r.openEditors.closeAll();
    expect(r.workspace.getState().groups.flatMap((g) => g.tabs)).toEqual([]);
  });

  it("Close Saved closes clean editors and keeps ones with unsaved changes", async () => {
    const a = (await r.workspace.openPath("C:/p/a.rs")) ?? "";
    await r.workspace.openPath("C:/p/b.rs");
    r.workspace.createUntitled();
    const buffers = (r.documents as unknown as { buffers: BufferManager }).buffers;
    buffers.setValue(a, "changed");

    expect(r.openEditors.hasSaved()).toBe(true);
    await r.openEditors.closeSaved();

    // b.rs and the empty untitled buffer were clean; a.rs has unsaved changes.
    expect(titles()).toEqual(["a.rs"]);
    expect(r.openEditors.hasSaved()).toBe(false);
  });

  describe("preview (provisional) tabs", () => {
    it("a single-click open is provisional and is replaced by the next one", async () => {
      await r.workspace.openPath("C:/p/a.rs", { preview: true });
      await r.workspace.openPath("C:/p/b.rs", { preview: true });

      expect(titles()).toEqual(["b.rs"]);
      expect(r.workspace.getState().tabs[0]?.preview).toBe(true);
    });

    it("editing a provisional tab keeps it", async () => {
      const a = (await r.workspace.openPath("C:/p/a.rs", { preview: true })) ?? "";
      (r.documents as unknown as { buffers: BufferManager }).buffers.setValue(a, "edited");

      await r.workspace.openPath("C:/p/b.rs", { preview: true });

      expect(titles()).toEqual(["a.rs", "b.rs"]);
    });

    it("with Enable Preview Editors off, files open permanently", async () => {
      await r.previews.setEnabled(false);

      await r.workspace.openPath("C:/p/a.rs", { preview: true });
      await r.workspace.openPath("C:/p/b.rs", { preview: true });

      expect(titles()).toEqual(["a.rs", "b.rs"]);
      expect(r.settings.get("editor.enablePreview")).toBe("false");
    });

    it("pinTab makes it permanent", async () => {
      const a = (await r.workspace.openPath("C:/p/a.rs", { preview: true })) ?? "";
      const group = r.workspace.getState().activeGroupId;

      r.workspace.pinTab(group, a);
      await r.workspace.openPath("C:/p/b.rs", { preview: true });

      expect(titles()).toEqual(["a.rs", "b.rs"]);
    });
  });

  describe("locked groups", () => {
    it("files do not open in a locked group", async () => {
      await r.workspace.openPath("C:/p/a.rs");
      const first = r.workspace.getState().activeGroupId;
      r.workspace.splitRight();
      r.workspace.setActiveGroup(first);
      r.workspace.setGroupLocked(first, true);

      await r.workspace.openPath("C:/p/b.rs");

      expect(titles(0)).toEqual(["a.rs"]);
      expect(titles(1)).toEqual(["a.rs", "b.rs"]);
      expect(r.workspace.getState().groups[0]?.locked).toBe(true);
    });
  });

  describe("Reopen Editor With", () => {
    it("switches a Markdown file between text editor, Markdown editor and preview in place", async () => {
      const id = (await r.workspace.openPath("C:/p/notes.md")) ?? "";
      const group = r.workspace.getState().activeGroupId;
      expect(r.workspace.docLanguage(id)).toBe("markdown");

      r.workspace.reopenTabAs(group, id, "text");
      expect(r.workspace.docLanguage(id)).toBe("plaintext");
      expect(r.workspace.getState().tabs[0]?.kind).toBe("text");

      r.workspace.reopenTabAs(group, id, "markdownPreview");
      const tab = r.workspace.getState().tabs[0];
      expect(tab).toMatchObject({
        kind: "markdownPreview",
        id: `${id}#preview`,
        title: "Preview notes.md",
      });

      r.workspace.reopenTabAs(group, `${id}#preview`, "markdownEditor");
      expect(r.workspace.docLanguage(id)).toBe("markdown");
      expect(r.workspace.getState().tabs[0]?.kind).toBe("text");
    });
  });

  describe("default editor associations", () => {
    it("a Markdown file opens as a preview when that is the default, and as text otherwise", async () => {
      await r.associations.setDefault(".md", "markdownPreview");

      await r.workspace.openPath("C:/p/notes.md");
      await r.workspace.openPath("C:/p/a.rs");

      expect(r.workspace.getState().tabs.map((t) => [t.title, t.kind])).toEqual([
        ["Preview notes.md", "markdownPreview"],
        ["a.rs", "text"],
      ]);
      expect(r.settings.get("editor.associations")).toBe('{".md":"markdownPreview"}');
    });

    it("setting it back to the text editor removes the entry; other types cannot get a preview", async () => {
      await r.associations.setDefault(".md", "markdownPreview");
      await r.associations.setDefault(".md", "text");

      expect(r.associations.getDefault(".md")).toBeNull();
      expect(await r.associations.setDefault(".rs", "markdownPreview")).toBe(false);
      expect(r.associations.kindFor("C:/p/a.rs")).toBe("text");
    });

    it("restores saved associations and ignores invalid ones", async () => {
      r.settings.set(
        "editor.associations",
        '{".md":"markdownPreview",".rs":"markdownPreview","x":1}',
      );

      await r.associations.initialize();

      expect(r.associations.getDefault(".md")).toBe("markdownPreview");
      expect(r.associations.getDefault(".rs")).toBeNull();
    });
  });

  describe("opening at a position", () => {
    it("opens the file as text and asks the editor to reveal the position in that document's model", async () => {
      const reveal = vi.fn();
      r.workspace.setRevealer(reveal);

      const id = await r.workspace.openPathAt("C:/p/a.rs", { line: 1, column: 4, length: 1 });

      expect(id).not.toBeNull();
      expect(reveal).toHaveBeenCalledWith(expect.stringContaining("inmemory"), {
        line: 1,
        column: 4,
        length: 1,
      });
    });
  });

  describe("layout persistence", () => {
    it("saves groups, active tab, locked and preview state and restores them", async () => {
      await r.workspace.openPath("C:/p/a.rs");
      await r.workspace.openPath("C:/p/b.rs");
      r.workspace.splitRight();
      await r.workspace.openPath("C:/p/notes.md", { kind: "markdownPreview" });
      const second = r.workspace.getState().activeGroupId;
      r.workspace.setGroupLocked(second, true);
      await vi.waitFor(() => {
        expect(r.settings.get("editor.layout")).toContain("notes.md");
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      const again = rig();
      for (const [key, value] of r.settings) again.settings.set(key, value);
      await again.workspace.restoreSession();

      const groups = again.workspace.getState().groups;
      expect(groups).toHaveLength(2);
      expect(groups[0]?.tabs.map((t) => t.title)).toEqual(["a.rs", "b.rs"]);
      expect(groups[1]?.tabs.map((t) => [t.title, t.kind])).toEqual([
        ["b.rs", "text"],
        ["Preview notes.md", "markdownPreview"],
      ]);
      expect(groups[1]?.locked).toBe(true);
      expect(again.workspace.getState().activeGroupId).toBe(groups[1]?.id);
    });

    it("falls back to the flat session when there is no saved layout", async () => {
      vi.mocked(r.ipc.sessionLoad).mockResolvedValue({
        openPaths: ["C:/p/a.rs", "C:/p/b.rs"],
        activePath: "C:/p/a.rs",
      });

      await r.workspace.restoreSession();

      expect(titles()).toEqual(["a.rs", "b.rs"]);
      expect(
        r.workspace.getState().tabs.find((t) => t.id === r.workspace.getState().activeId)?.title,
      ).toBe("a.rs");
    });

    it("skips files that can no longer be opened without losing the rest", async () => {
      vi.mocked(r.ipc.sessionLoad).mockResolvedValue({
        openPaths: ["C:/p/a.rs", "C:/p/gone.rs"],
        activePath: null,
      });
      vi.mocked(r.ipc.documentOpen).mockImplementation((path: string) =>
        path.endsWith("gone.rs")
          ? Promise.reject(new Error("missing"))
          : Promise.resolve(opened(path)),
      );

      await r.workspace.restoreSession();

      expect(titles()).toEqual(["a.rs"]);
    });

    it("parseLayout rejects malformed data and repairs partial data", () => {
      expect(parseLayout("{nope")).toBeNull();
      expect(parseLayout('{"version":2,"groups":[]}')).toBeNull();
      expect(parseLayout('{"version":1,"groups":[]}')).toBeNull();
      const repaired = parseLayout(
        '{"version":1,"activeGroup":9,"weights":[0],"groups":[{"tabs":[{"path":"a","kind":"text"},{"path":1,"kind":"text"},{"path":"b","kind":"bogus"}],"activeIndex":7}]}',
      );
      expect(repaired).toEqual({
        groups: [
          { tabs: [{ path: "a", kind: "text", preview: false }], activeIndex: 0, locked: false },
        ],
        activeGroup: 0,
        weights: [1],
      });
    });
  });
});

describe("MarkdownPreviewService", () => {
  let r: Rig;
  beforeEach(() => {
    r = rig();
  });

  it("explains why a preview is not available", async () => {
    const rs = (await r.workspace.openPath("C:/p/a.rs")) ?? "";
    const untitled = r.workspace.createUntitled();

    expect(r.markdown.unavailableReason(null)).toMatch(/no editor/i);
    expect(r.markdown.unavailableReason(rs)).toMatch(/Markdown/);
    expect(r.markdown.unavailableReason(untitled)).toMatch(/Save the file/);
    expect(r.markdown.openPreview(rs)).toBe(false);
  });

  it("Open Preview replaces nothing: it adds a preview tab in the same group", async () => {
    const id = (await r.workspace.openPath("C:/p/notes.md")) ?? "";

    expect(r.markdown.openPreview(id)).toBe(true);

    expect(r.workspace.getState().tabs.map((t) => t.kind)).toEqual(["text", "markdownPreview"]);
  });

  it("Open Preview to the Side puts the preview in the group on the right and keeps focus on the editor", async () => {
    const id = (await r.workspace.openPath("C:/p/notes.md")) ?? "";
    const editorGroup = r.workspace.getState().activeGroupId;

    expect(r.markdown.openPreviewToSide(id)).toBe(true);

    const state = r.workspace.getState();
    expect(state.groups).toHaveLength(2);
    expect(state.groups[0]?.tabs.map((t) => t.kind)).toEqual(["text"]);
    expect(state.groups[1]?.tabs.map((t) => t.kind)).toEqual(["markdownPreview"]);
    expect(state.activeGroupId).toBe(editorGroup);

    // Doing it again reuses the group on the right.
    r.markdown.openPreviewToSide(id);
    expect(r.workspace.getState().groups).toHaveLength(2);
  });

  it("follows web links in the browser and relative links to files, and refuses links it cannot resolve", async () => {
    const id = (await r.workspace.openPath("C:/p/notes.md")) ?? "";

    await r.markdown.followLink(id, "https://example.com/x");
    await r.markdown.followLink(id, "b.rs");
    await r.markdown.followLink(id, "javascript:alert(1)");
    await r.markdown.followLink(id, "../../../../nope.md");

    expect(r.ipc.openExternalUrl).toHaveBeenCalledTimes(1);
    expect(r.ipc.openExternalUrl).toHaveBeenCalledWith("https://example.com/x");
    expect(r.ipc.documentOpen).toHaveBeenCalledWith("C:/p/b.rs");
    expect(r.ipc.documentOpen).not.toHaveBeenCalledWith(expect.stringContaining("nope"));
  });

  it("resolveSiblingPath handles ., .. and both separator styles", () => {
    expect(resolveSiblingPath("C:/p/notes.md", "./x/y.md")).toBe("C:/p/x/y.md");
    expect(resolveSiblingPath("C:/p/sub/notes.md", "../a.rs")).toBe("C:/p/a.rs");
    expect(resolveSiblingPath("C:\\p\\notes.md", "sub/a.rs")).toBe("C:\\p\\sub\\a.rs");
    expect(resolveSiblingPath("C:/notes.md", "../../x")).toBeNull();
  });
});

describe("editor header menu and commands", () => {
  let r: Rig;
  let commands: CommandRegistry;

  function menu(): HeaderMenuRow[] {
    return buildEditorActionsMenu(
      {
        workspace: r.workspace,
        groups: r.groups,
        openEditors: r.openEditors,
        previews: r.previews,
        associations: r.associations,
        markdown: r.markdown,
        editor: {
          getOptions: () => ({
            wordWrap: false,
            minimap: true,
            stickyScroll: true,
            renderWhitespace: true,
          }),
        } as never,
        layout: new LayoutService(r.ipc),
        run: (id, ...args) => {
          void commands.execute(id, ...args);
        },
      },
      r.groups.getState().activeGroupId,
    );
  }

  const row = (rows: HeaderMenuRow[], label: string) =>
    rows.find((entry) => entry.kind !== "separator" && entry.label === label);

  beforeEach(() => {
    r = rig();
    commands = new CommandRegistry();
    registerEditorCommands({
      commands,
      workspace: r.workspace,
      groups: r.groups,
      openEditors: r.openEditors,
      previews: r.previews,
      associations: r.associations,
      markdown: r.markdown,
    });
  });

  it("with nothing open, every editor action is disabled with a reason", () => {
    const rows = menu();

    for (const label of [
      "Show Open Editors",
      "Close All",
      "Close Saved",
      "Split Editor Right",
      "Open Preview to the Side",
      "Open as Preview",
      "Reopen Editor With",
    ]) {
      const entry = row(rows, label);
      expect(entry?.kind, label).toBe("item");
      if (entry?.kind === "item") {
        expect(entry.enabled, label).toBe(false);
        expect(entry.reason, label).toBeTruthy();
      }
    }
    expect(commands.isEnabled("editor.splitRight")).toBe(false);
  });

  it("for a .rs file, preview actions say they are Markdown-only and the rest work", async () => {
    await r.workspace.openPath("C:/p/a.rs");
    const rows = menu();

    const toSide = row(rows, "Open Preview to the Side");
    expect(toSide).toMatchObject({
      enabled: false,
      reason: expect.stringContaining("Markdown") as string,
    });
    expect(row(rows, "Split Editor Right")).toMatchObject({ enabled: true });
    expect(row(rows, "Close All")).toMatchObject({ enabled: true });
    const setDefault = rows.find(
      (entry) => entry.kind === "item" && entry.label.startsWith("Set Default"),
    );
    expect(setDefault).toMatchObject({
      enabled: false,
      reason: expect.stringContaining("Markdown") as string,
    });
  });

  it("for a .md file, the preview actions run and Reopen With offers all three editors", async () => {
    await r.workspace.openPath("C:/p/notes.md");
    const rows = menu();

    expect(row(rows, "Open Preview to the Side")).toMatchObject({ enabled: true });
    const reopen = row(rows, "Reopen Editor With");
    expect(reopen?.kind).toBe("submenu");
    if (reopen?.kind === "submenu") {
      expect(
        reopen.items.map((i) => (i.kind === "item" ? [i.label, i.enabled, i.checked] : null)),
      ).toEqual([
        ["Text Editor", true, false],
        ["Markdown Editor", false, true],
        ["Markdown Preview", true, false],
      ]);
    }
    const defaults = rows.find(
      (entry) => entry.kind === "submenu" && entry.label === 'Set Default for ".md"',
    );
    expect(defaults?.kind).toBe("submenu");
  });

  it("menu rows run the same commands: split, preview, lock, preview toggle, reopen and default", async () => {
    await r.workspace.openPath("C:/p/notes.md");
    const select = (rows: HeaderMenuRow[], label: string) => {
      const entry = row(rows, label);
      if (entry?.kind === "item") entry.onSelect();
    };

    select(menu(), "Lock Group");
    expect(r.groups.activeGroup().locked).toBe(true);
    select(menu(), "Lock Group");
    select(menu(), "Enable Preview Editors");
    expect(r.previews.isEnabled()).toBe(false);
    await commands.execute("editor.reopenWith", "markdownPreview");
    expect(r.workspace.getState().tabs[0]?.kind).toBe("markdownPreview");
    await commands.execute("editor.setDefaultForExtension", "markdownPreview");
    expect(r.associations.getDefault(".md")).toBe("markdownPreview");
    await commands.execute("editorLayout.splitRight");
    expect(r.workspace.getState().groups).toHaveLength(2);
  });

  it("Show Open Editors lists every open editor and selecting one focuses it", async () => {
    await r.workspace.openPath("C:/p/a.rs");
    r.workspace.splitRight();
    await r.workspace.openPath("C:/p/b.rs");
    const first = r.workspace.getState().groups[0]?.id ?? "";
    r.workspace.setActiveGroup(first);

    const shown = row(menu(), "Show Open Editors");

    expect(shown?.kind).toBe("submenu");
    if (shown?.kind === "submenu") {
      const labels = shown.items.map((i) => (i.kind === "item" ? i.label : ""));
      expect(labels).toEqual(["a.rs — Group 1", "a.rs — Group 2", "b.rs — Group 2"]);
      const last = shown.items[2];
      if (last?.kind === "item") last.onSelect();
    }
    expect(
      r.workspace.getState().tabs.find((t) => t.id === r.workspace.getState().activeId)?.title,
    ).toBe("b.rs");
  });

  it("Close Saved and Close All commands take a group id", async () => {
    await r.workspace.openPath("C:/p/a.rs");
    r.workspace.splitRight();
    const groupIds = r.workspace.getState().groups.map((g) => g.id);

    await commands.execute("editor.closeAll", groupIds[1]);
    expect(r.workspace.getState().groups).toHaveLength(1);
    await commands.execute("editor.closeSaved");
    expect(r.workspace.getState().groups.flatMap((g) => g.tabs)).toEqual([]);
  });
});
