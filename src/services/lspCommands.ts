import type { CommandRegistry } from "./commandRegistry";
import type { EditorService } from "./editorService";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { LspAction } from "./lspAvailability";
import type { LspService } from "./lspService";
import type { OutputService } from "./outputService";
import type { PanelService } from "./panelService";

export interface LspCommandDeps {
  commands: CommandRegistry;
  editor: EditorService;
  lsp: LspService;
  events: EventBus<AppEvents>;
  output: OutputService;
  panel: PanelService;
}

/** Command id → [what it needs from the server, the Monaco action it runs]. Monaco drives the UI (peek, rename box); the provider asks the server. */
export const LSP_EDITOR_COMMANDS: Record<string, [LspAction, string]> = {
  "go.toDefinition": ["definition", "editor.action.revealDefinition"],
  "go.toDeclaration": ["declaration", "editor.action.revealDeclaration"],
  "go.toTypeDefinition": ["typeDefinition", "editor.action.goToTypeDefinition"],
  "go.toImplementations": ["implementation", "editor.action.goToImplementation"],
  "go.toReferences": ["references", "editor.action.referenceSearch.trigger"],
  "lsp.findReferences": ["references", "editor.action.referenceSearch.trigger"],
  "edit.renameSymbol": ["rename", "editor.action.rename"],
  "edit.formatDocument": ["formatting", "editor.action.formatDocument"],
};

/** Commands that `searchWiring` owns (they use the language server when there is one, else the workspace index). */
const REFERENCE_COMMANDS: ReadonlySet<string> = new Set([
  "go.toReferences",
  "lsp.findReferences",
  // Format Document is registered by the formatting service (built-in and tool formatters, and the server).
  "edit.formatDocument",
]);

/**
 * Language features as commands (menus, shortcuts, the palette): each is enabled
 * only when the file in front has a running server that supports it, and says
 * why otherwise. Nothing here pretends: when a command runs, the provider that
 * answers is a real server request.
 */
export function registerLspCommands(deps: LspCommandDeps): void {
  const { commands, editor, lsp, events, output, panel } = deps;
  const reasonFor = (action: LspAction) => () =>
    editor.hasEditor() ? lsp.activeAvailable(action).reason : "Open a file first.";

  for (const [id, [action, monacoAction]] of Object.entries(LSP_EDITOR_COMMANDS)) {
    // Find References is registered with the search commands: it falls back to a text-based search.
    if (REFERENCE_COMMANDS.has(id)) continue;
    commands.register(
      id,
      () => {
        editor.run(monacoAction);
      },
      {
        enabled: () => editor.hasEditor() && lsp.activeAvailable(action).enabled,
        disabledReason: reasonFor(action),
      },
    );
  }

  commands.register(
    "lsp.restart",
    async () => {
      await lsp.restartActive();
    },
    {
      enabled: () => editor.hasEditor() && lsp.activeRestartAvailability().enabled,
      disabledReason: () =>
        editor.hasEditor() ? lsp.activeRestartAvailability().reason : "Open a file first.",
    },
  );
  commands.register("lsp.manage", () => {
    events.emit("showLanguageTools", undefined);
  });
  commands.register("lsp.openOutput", async () => {
    output.ensureChannel("LSP");
    output.select("LSP");
    await panel.show("output");
  });
}
