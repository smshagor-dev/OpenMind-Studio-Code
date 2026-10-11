import type { CommandRegistry } from "../commandRegistry";
import type { DocumentService } from "../documentService";
import type { EditorService } from "../editorService";
import type { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import type { IpcClient } from "../ipc";
import type { LspService } from "../lspService";
import { createFormattingProvider } from "../lspProviders";
import { formatSelection, formatSelectionReason } from "./formatSelection";
import type { SettingsService } from "../settingsService";
import type { WorkspaceService } from "../workspaceService";
import { type ExtensionFormatterRegistry, toEditorEdits } from "../extensionFormatters";
import {
  FormattingService,
  type FormatTarget,
  type FormattingHost,
  LSP_FORMATTER_ID,
} from "./formattingService";

export interface FormattingWiringDeps {
  ipc: IpcClient;
  events: EventBus<AppEvents>;
  commands: CommandRegistry;
  workspace: WorkspaceService;
  documents: DocumentService;
  editor: EditorService;
  lsp: LspService;
  settings: SettingsService;
  log: (line: string) => void;
  /** Formatters extensions registered (Milestone 18). */
  extensionFormatters?: ExtensionFormatterRegistry;
}

const NO_EDITOR = "Open a text file first.";

/** What the document in front is, as far as formatting is concerned. */
function activeState(deps: FormattingWiringDeps): { id: string } | { reason: string } {
  const state = deps.workspace.getState();
  const tab = state.tabs.find((candidate) => candidate.id === state.activeId);
  if (tab === undefined) return { reason: NO_EDITOR };
  if (tab.kind === "filePreview") {
    return {
      reason: "A preview is read-only and can't be formatted. Open the file as text first.",
    };
  }
  if (tab.kind !== "text") {
    return { reason: "Only a text editor can be formatted. Switch to the text tab." };
  }
  return deps.documents.has(tab.id) ? { id: tab.id } : { reason: NO_EDITOR };
}

function makeHost(deps: FormattingWiringDeps): FormattingHost {
  const { documents, lsp, ipc, workspace } = deps;
  const targetOf = (id: string): FormatTarget | null => {
    if (!documents.has(id)) return null;
    const snapshot = documents.snapshot(id);
    return {
      id,
      path: snapshot.path,
      language: documents.languageOf(id),
      eol: documents.eolOf(id),
      indent: documents.indentUnitOf(id),
    };
  };
  return {
    active() {
      const active = activeState(deps);
      if ("reason" in active) return active;
      const target = targetOf(active.id);
      return target === null ? { reason: NO_EDITOR } : { target };
    },
    target: targetOf,
    text: (id) => documents.contentOf(id),
    apply: (id, text) => {
      documents.replaceText(id, text);
    },
    lsp(id) {
      const availability = lsp.available("formatting", id);
      return {
        available: availability.enabled,
        reason: availability.reason ?? null,
        run: async () => {
          const model = documents.modelFor(id);
          if (model === null) return null;
          const indent = documents.indentUnitOf(id);
          const provider = createFormattingProvider({ ipc, documents, workspace, lsp });
          const edits = await provider.provideDocumentFormattingEdits(
            model,
            { tabSize: indent === "\t" ? 4 : indent.length, insertSpaces: indent !== "\t" },
            {
              isCancellationRequested: false,
              onCancellationRequested: () => ({ dispose: () => undefined }),
            },
          );
          return edits === null || edits === undefined ? null : documents.textWithEdits(id, edits);
        },
      };
    },
    extensionFormatters(id) {
      const registry = deps.extensionFormatters;
      const target = targetOf(id);
      // An extension formats a saved file it knows by its path; an unsaved one isn't offered.
      if (registry === undefined || target === null || target.path === null) return [];
      const path = target.path;
      const indent = target.indent;
      const options = { tabSize: indent === "\t" ? 4 : indent.length, insertSpaces: indent !== "\t" };
      return registry.forLanguage(target.language).map((formatter) => ({
        id: formatter.id,
        name: formatter.name,
        run: async () => {
          const edits = await formatter.format(path, options);
          return documents.textWithEdits(id, toEditorEdits(edits));
        },
      }));
    },
  };
}

/** Builds the formatting service and registers its commands. `container.ts` connects it to saving and the UI. */
export function wireFormatting(deps: FormattingWiringDeps): { service: FormattingService } {
  const { commands, settings, events, ipc, log } = deps;
  const service = new FormattingService(ipc, makeHost(deps), settings, events, log);
  const reason = () => service.unavailableReason();
  const usable = () => reason() === undefined;

  commands.register(
    "edit.formatDocument",
    async () => {
      await service.formatActive();
    },
    { enabled: usable, disabledReason: reason },
  );
  commands.register(
    "edit.formatDocumentWith",
    async () => {
      await service.openDialog("with");
    },
    { enabled: usable, disabledReason: reason },
  );
  commands.register(
    "edit.configureDefaultFormatter",
    async () => {
      await service.openDialog("configure");
    },
    { enabled: usable, disabledReason: reason },
  );
  commands.register(
    "format.showStatus",
    async () => {
      await service.openDialog("status");
    },
    { enabled: usable, disabledReason: reason },
  );
  commands.register(
    "edit.formatSelection",
    async () => {
      await formatSelection(deps);
    },
    {
      // Only a language server formats part of a document; the built-in and tool formatters format the whole file.
      enabled: () => formatSelectionReason(deps) === undefined,
      disabledReason: () => formatSelectionReason(deps),
    },
  );
  commands.register(
    "format.toggleOnSave",
    async () => {
      await settings.set("user", "editor.formatOnSave", !service.formatOnSaveEnabled());
    },
    { checked: () => service.formatOnSaveEnabled() },
  );

  const refresh = () => {
    void service.refreshStatus();
  };
  // Every workspace change (each keystroke too): look up again only when the file in front or its kind changed.
  deps.workspace.subscribe(() => {
    void service.refreshStatusIfChanged();
  });
  settings.onChange(
    [
      "editor.defaultFormatter",
      "formatter.useProjectLocalTools",
      "formatter.useBundledTools",
      "formatter.useSystemTools",
      "editor.tabSize",
      "editor.insertSpaces",
    ],
    refresh,
  );
  deps.documents.setBeforeSave((id) => service.beforeSave(id));
  // Format Document and Format Document With... in the F1 palette and the editor's right-click menu.
  deps.editor.setFormatActions([
    { command: "edit.formatDocument", label: "Format Document", inContextMenu: true },
    { command: "edit.formatDocumentWith", label: "Format Document With...", inContextMenu: true },
  ]);
  return { service };
}

export { LSP_FORMATTER_ID };
