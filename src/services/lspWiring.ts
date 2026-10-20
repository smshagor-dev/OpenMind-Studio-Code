import { DiagnosticsService } from "./diagnosticsService";
import type { DocumentService } from "./documentService";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { ConfirmPrompt } from "./extensionPromptService";
import type { IpcClient } from "./ipc";
import { registerCodeActions } from "./lspCodeActions";
import { registerLspProviders } from "./lspProviders";
import { LspService } from "./lspService";
import type { SettingsService } from "./settingsService";
import type { WorkspaceService } from "./workspaceService";
import { registerIndexSymbolProvider } from "../editor/indexSymbolProvider";
import { t } from "../i18n";

export interface LspWiringDeps {
  ipc: IpcClient;
  events: EventBus<AppEvents>;
  documents: DocumentService;
  workspace: WorkspaceService;
  settings: SettingsService;
  log: (line: string) => void;
  confirm: (request: Omit<ConfirmPrompt, "kind" | "id">) => Promise<string | null>;
}

/** Language servers: the open documents told to their server, diagnostics as editor markers, the editor's providers. */
export function wireLsp(deps: LspWiringDeps) {
  const { ipc, events, documents, workspace } = deps;
  const lsp = new LspService(ipc, events, documents, {
    log: deps.log,
    activeDocId: () => {
      const id = workspace.getState().activeId;
      return id !== null && documents.has(id) ? id : null;
    },
    enabled: () => deps.settings.bool("lsp.enabled", true),
  });
  const diagnostics = new DiagnosticsService(events, documents);
  // Removing a downloaded language server always asks first, naming what is deleted.
  lsp.setRemoveConfirmation(async (server) => {
    const button = t("lsp.removeConfirm.button");
    const answer = await deps.confirm({
      extension: t("runtimes.tab.tools"),
      title: t("lsp.removeConfirm.title", { name: server.name }),
      details: [{ label: t("lsp.removeConfirm.removes"), value: server.contents }],
      notes: [t("lsp.removeConfirm.note")],
      buttons: [button],
    });
    return answer === button;
  });

  /**
   * Starts language support once the app is up: diagnostics become editor markers and
   * the providers (hover, completion, definition, ...) ask the language servers.
   */
  async function start(): Promise<void> {
    diagnostics.initialize();
    registerLspProviders({ ipc, documents, workspace, lsp });
    registerCodeActions({
      ipc,
      documents,
      workspace,
      lsp,
      report: (message) => {
        events.emit("appError", { message });
      },
      // An edit across files names them first (Refactor / Source Action can change files that aren't open).
      confirmFiles: async (paths) => {
        const button = t("codeAction.applyButton");
        const answer = await deps.confirm({
          extension: t("codeAction.source"),
          title: t("codeAction.confirmTitle", { count: paths.length }),
          details: paths.map((path) => ({ label: "", value: path })),
          notes: [t("codeAction.confirmNote")],
          buttons: [button],
        });
        return answer === button;
      },
    });
    registerIndexSymbolProvider({
      textSymbols: (language, text) => ipc.searchSymbolsOfText(language, text),
      languageServerHandles: (uri) => {
        const id = documents.idForModelUri(uri);
        return id !== undefined && lsp.available("documentSymbol", id).enabled;
      },
    });
    await lsp.initialize();
  }

  return { lsp, diagnostics, start };
}
