import { describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../../testUtils/fakeIpcClient";
import { CommandRegistry } from "../commandRegistry";
import { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import { KeybindingService, type KeyEventLike } from "../keybindings";
import { buildMenuBar, pruneMenuEntries } from "../menus";
import { wireFormatting, type FormattingWiringDeps } from "./formattingWiring";

const MINIFIED = '{"a":1}';
const PRETTY = '{\n  "a": 1\n}';

function rig(activeKind: "text" | "filePreview" = "text") {
  const texts = new Map([["d1", MINIFIED]]);
  const replaced: string[] = [];
  let beforeSave: ((id: string) => Promise<void>) | null = null;
  const settingsValues: Record<string, boolean> = {};
  const set = vi.fn().mockImplementation((_scope: string, id: string, value: boolean) => {
    settingsValues[id] = value;
    return Promise.resolve({ ok: true });
  });
  const ipc = createFakeIpc({
    formatOptions: vi.fn().mockResolvedValue({
      languageId: "json",
      languageName: "JSON",
      formatters: [
        {
          id: "builtin.json",
          name: "Built-in JSON formatter",
          source: "builtIn",
          mode: "builtIn",
          available: true,
          reason: null,
          path: null,
        },
      ],
      selected: "builtin.json",
      reason: null,
    }),
    formatRun: vi.fn().mockResolvedValue({
      text: PRETTY,
      formatterId: "builtin.json",
      formatterName: "Built-in JSON formatter",
      source: "builtIn",
    }),
  });
  const commands = new CommandRegistry();
  const notices: string[] = [];
  const documents = {
    has: (id: string) => texts.has(id),
    snapshot: () => ({ path: "C:/My Project/package.json" }),
    languageOf: () => "json",
    modelFor: () => null,
    modelUri: () => null,
    eolOf: () => "\n",
    indentUnitOf: () => "  ",
    contentOf: (id: string) => texts.get(id) ?? "",
    replaceText: (id: string, text: string) => {
      texts.set(id, text);
      replaced.push(text);
    },
    setBeforeSave: (hook: (id: string) => Promise<void>) => {
      beforeSave = hook;
    },
  };
  const events = new EventBus<AppEvents>();
  events.on("appNotice", ({ message }) => notices.push(message));
  let lspEnabled = false;
  let rangeFormatting = true;
  const deps = {
    ipc,
    events,
    commands,
    workspace: {
      getState: () => ({ activeId: "d1", tabs: [{ id: "d1", kind: activeKind }] }),
      subscribe: () => () => undefined,
    },
    documents,
    editor: { hasEditor: () => true, run: vi.fn(), selectionsFor: () => null },
    lsp: {
      available: () => ({ enabled: lspEnabled, reason: "No language server." }),
      activeAvailable: () => ({ enabled: lspEnabled, reason: "No language server." }),
      serverForPath: () => ({ capabilities: { rangeFormatting: rangeFormatting } }),
    },
    settings: {
      bool: (id: string, fallback: boolean) => settingsValues[id] ?? fallback,
      number: (_id: string, fallback: number) => fallback,
      string: (_id: string, fallback: string) => fallback,
      onChange: () => () => undefined,
      set,
    },
    log: vi.fn(),
  } as unknown as FormattingWiringDeps;
  const { service } = wireFormatting(deps);
  return {
    commands,
    service,
    ipc,
    texts,
    replaced,
    set,
    editor: deps.editor as unknown as { run: ReturnType<typeof vi.fn> },
    beforeSave: () => beforeSave,
    enableLsp: () => {
      lspEnabled = true;
    },
    setRangeFormatting: (value: boolean) => {
      rangeFormatting = value;
    },
    notices,
  };
}

describe("formatting commands", () => {
  it("Format Document formats the package.json in front through the real handler", async () => {
    const r = rig();
    expect(r.commands.isEnabled("edit.formatDocument")).toBe(true);
    await r.commands.execute("edit.formatDocument");
    expect(r.replaced).toEqual([PRETTY]);
    expect(r.texts.get("d1")).toBe(PRETTY);
  });

  it("with a preview tab in front every formatting command is disabled with the reason", () => {
    const r = rig("filePreview");
    for (const id of [
      "edit.formatDocument",
      "edit.formatDocumentWith",
      "edit.configureDefaultFormatter",
      "format.showStatus",
    ]) {
      expect(r.commands.isEnabled(id), id).toBe(false);
      expect(r.commands.reasonFor(id), id).toContain("A preview is read-only");
    }
  });

  it("Format Document With... opens the list and Formatter Status opens it read-only", async () => {
    const r = rig();
    await r.commands.execute("edit.formatDocumentWith");
    expect(r.service.getState().dialog?.mode).toBe("with");
    r.service.closeDialog();
    await r.commands.execute("format.showStatus");
    expect(r.service.getState().dialog?.mode).toBe("status");
  });

  it("Format Selection is only offered when a language server can do it, and says so otherwise", async () => {
    const r = rig();
    expect(r.commands.isEnabled("edit.formatSelection")).toBe(false);
    expect(r.commands.reasonFor("edit.formatSelection")).toContain("language server");
    r.enableLsp();
    expect(r.commands.isEnabled("edit.formatSelection")).toBe(true);
    r.setRangeFormatting(false);
    expect(r.commands.isEnabled("edit.formatSelection")).toBe(false);
    expect(r.commands.reasonFor("edit.formatSelection")).toContain("can't format a selection");
    r.setRangeFormatting(true);
    await r.commands.execute("edit.formatSelection");
    expect(r.notices.at(-1)).toBe("Select the text to format first.");
  });

  it("the Format on Save toggle writes the user setting and is checkable", async () => {
    const r = rig();
    expect(r.commands.isChecked("format.toggleOnSave")).toBe(false);
    await r.commands.execute("format.toggleOnSave");
    expect(r.set).toHaveBeenCalledWith("user", "editor.formatOnSave", true);
    expect(r.commands.isChecked("format.toggleOnSave")).toBe(true);
  });

  it("saving runs the formatting hook: formatted before the write when the setting is on", async () => {
    const r = rig();
    const hook = r.beforeSave();
    expect(hook).not.toBeNull();
    await hook?.("d1");
    expect(r.texts.get("d1")).toBe(MINIFIED); // off by default
    await r.commands.execute("format.toggleOnSave");
    await hook?.("d1");
    expect(r.texts.get("d1")).toBe(PRETTY);
  });
});

describe("Shift+Alt+F and the Edit menu", () => {
  const event = (): KeyEventLike => ({
    code: "KeyF",
    ctrlKey: false,
    shiftKey: true,
    altKey: true,
    metaKey: false,
  });

  it("the shortcut is the app's own and runs Format Document", () => {
    const r = rig();
    const keys = new KeybindingService(r.commands);
    expect(keys.resolve(event())).toBe("edit.formatDocument");
  });

  it("the Edit menu offers Format Document, With..., Selection, default, status and Format on Save — each backed by a command", () => {
    const r = rig();
    const edit = buildMenuBar({ folders: [], files: [] }).find((menu) => menu.id === "edit");
    expect(edit).toBeDefined();
    const entries = pruneMenuEntries(edit?.items ?? [], (command) => r.commands.has(command));
    const labels = entries.flatMap((entry) => (entry.kind === "command" ? [entry.label] : []));
    for (const label of [
      "Format Document",
      "Format Document With...",
      "Format Selection",
      "Configure Default Formatter...",
      "Formatter Status",
      "Format on Save",
    ]) {
      expect(labels, label).toContain(label);
    }
  });
});
