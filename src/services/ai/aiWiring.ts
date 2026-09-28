import type { CommandRegistry } from "../commandRegistry";
import type { EditorService } from "../editorService";
import type { EventBus } from "../eventBus";
import type { ExtensionEditorAction } from "../extensionContributionService";
import type { AppEvents } from "../events";
import type { FilePreviewDoc } from "../filePreviewService";
import type { LayoutService } from "../layoutService";
import type { TerminalService } from "../terminalService";
import type { WorkspaceService } from "../workspaceService";
import {
  AiActionsService,
  AI_ACTION_COMMANDS,
  type AiContextSource,
} from "./aiActionsService";
import { AiChatService } from "./aiChatService";
import type { ActiveKind, AiActionKind, AiSelection } from "./aiContext";
import type { AiIpc } from "./aiIpc";
import {
  AiProviderService,
  type AiExtensionsSource,
  type AiSettingsSource,
} from "./aiProviderService";
import { AiUiService } from "./aiUiService";
import { t } from "../../i18n";

export interface AiWiringDeps {
  ipc: AiIpc;
  events: EventBus<AppEvents>;
  commands: CommandRegistry;
  settings: AiSettingsSource;
  extensions: AiExtensionsSource;
  layout: Pick<LayoutService, "showView">;
  editor: Pick<EditorService, "selectedText" | "insertAtCursor" | "setAiActions" | "hasEditor">;
  terminal: Pick<TerminalService, "activeSelection">;
  workspace: Pick<WorkspaceService, "getState" | "docPath">;
  previews: { get: (id: string) => FilePreviewDoc | undefined };
}

const ACTION_KINDS = Object.keys(AI_ACTION_COMMANDS) as AiActionKind[];

function baseName(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

/** What the AI actions read from the workbench, at the moment the user runs one. */
function createContextSource(deps: AiWiringDeps): AiContextSource {
  const { editor, terminal, workspace } = deps;
  const activeTab = () => {
    const state = workspace.getState();
    const group = state.groups.find((g) => g.id === state.activeGroupId);
    return group?.tabs.find((tab) => tab.id === group.activeTabId) ?? null;
  };
  return {
    activeKind: (): ActiveKind => {
      const tab = activeTab();
      if (tab === null) return "none";
      return tab.kind === "text" ? "text" : "preview";
    },
    selection: (): AiSelection | null => {
      const tab = activeTab();
      if (tab?.kind !== "text") return null;
      const selected = editor.selectedText();
      if (selected === null) return null;
      const path = workspace.docPath(tab.docId);
      return {
        text: selected.text,
        languageId: selected.languageId,
        fileName: path === null ? tab.title : baseName(path),
        startLine: selected.startLine,
        endLine: selected.endLine,
      };
    },
    terminalSelection: () => terminal.activeSelection(),
    activePreview: () => {
      const tab = activeTab();
      return tab?.kind === "filePreview" ? (deps.previews.get(tab.docId) ?? null) : null;
    },
    insertAtCursor: (text) => editor.insertAtCursor(text),
  };
}

/** The AI commands offered in the editor's palette (F1) and right-click menu while a provider is available. */
function editorActionList(): ExtensionEditorAction[] {
  const named = (kind: AiActionKind, inContextMenu: boolean): ExtensionEditorAction => ({
    command: AI_ACTION_COMMANDS[kind],
    label: `${t("view.ai")}: ${t(`ai.action.${kind}`)}`,
    inContextMenu,
  });
  return [
    named("explain", true),
    named("fix", true),
    named("docs", true),
    named("terminal", false),
    named("preview", false),
    { command: "ai.openChat", label: "AI: Open Chat", inContextMenu: false },
  ];
}

/**
 * Builds the AI services and keeps what depends on a provider in step with it: the AI commands and the editor's
 * AI actions exist only while at least one provider is available (an enabled provider, whose extension — if it came
 * from one — is enabled). The activity bar icon and the side bar panel follow `providers.panelVisible()` the same
 * way. Called once by the composition root.
 */
export function wireAi(deps: AiWiringDeps) {
  const { ipc, events, commands, settings, extensions, layout, editor } = deps;
  const providers = new AiProviderService(ipc, events, settings, extensions);
  const chat = new AiChatService(ipc, events, providers, settings);
  const ui = new AiUiService();
  const actions = new AiActionsService(createContextSource(deps), chat, layout, events);

  // Always there: opening the provider manager is how the first provider gets added.
  commands.register("ai.manageProviders", () => {
    ui.openManager();
  });

  const registered = new Set<string>();
  const provide = (
    id: string,
    run: () => void | Promise<void>,
    options: Parameters<CommandRegistry["register"]>[2] = {},
  ) => {
    commands.register(id, run, options);
    registered.add(id);
  };
  const syncCommands = () => {
    if (!providers.panelVisible()) {
      for (const id of registered) commands.unregister(id);
      registered.clear();
      editor.setAiActions([]);
      return;
    }
    if (registered.size > 0) return;
    provide("ai.openChat", () => layout.showView("ai"));
    provide("ai.newChat", async () => {
      chat.newChat();
      await layout.showView("ai");
    });
    for (const kind of ACTION_KINDS) {
      provide(AI_ACTION_COMMANDS[kind], () => actions.run(kind), {
        enabled: () => actions.reason(kind) === null,
        disabledReason: () => actions.reason(kind) ?? undefined,
      });
    }
    editor.setAiActions(editorActionList());
  };
  providers.subscribe(() => {
    syncCommands();
    chat.onProvidersChanged();
  });

  return { providers, chat, actions, ui, syncCommands };
}
