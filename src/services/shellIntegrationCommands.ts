import { i18n, t } from "../i18n";
import type { CommandRegistry } from "./commandRegistry";
import type { EditorService } from "./editorService";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { ConfirmPrompt } from "./extensionPromptService";
import type { IntegrationAction, IntegrationStatus, IpcClient } from "./ipc";

/** Palette command id -> backend action and the i18n key of its title. */
export const SHELL_INTEGRATION_COMMANDS: [string, IntegrationAction, string][] = [
  ["integration.addToPath", "add-path", "integration.palette.addToPath"],
  ["integration.removeFromPath", "remove-path", "integration.palette.removeFromPath"],
  ["integration.registerExplorer", "add-explorer", "integration.palette.registerExplorer"],
  ["integration.unregisterExplorer", "remove-explorer", "integration.palette.unregisterExplorer"],
];

export interface ShellIntegrationDeps {
  commands: CommandRegistry;
  events: EventBus<AppEvents>;
  ipc: Pick<IpcClient, "integrationStatus" | "integrationApply">;
  editor: Pick<EditorService, "setAppActions">;
  /** The confirmation dialog; resolves with the chosen button, `null` when cancelled. */
  confirm: (request: Omit<ConfirmPrompt, "kind" | "id">) => Promise<string | null>;
}

/** What the confirmation says will change, as labelled lines. */
export function changeDetails(
  action: IntegrationAction,
  status: IntegrationStatus,
): { label: string; value: string }[] {
  if (action === "add-path" || action === "remove-path") {
    return [
      { label: t("integration.detail.variable"), value: "HKCU\\Environment\\Path" },
      { label: t("integration.detail.folder"), value: status.binDir },
    ];
  }
  return [
    { label: t("integration.detail.entries"), value: t("integration.detail.entriesValue") },
    { label: t("integration.detail.program"), value: status.exe },
  ];
}

/** Why the action has nothing to do, or `null`. */
export function nothingToDo(action: IntegrationAction, status: IntegrationStatus): string | null {
  switch (action) {
    case "add-path":
      return status.pathPresent ? t("integration.already.path", { folder: status.binDir }) : null;
    case "remove-path":
      return status.pathAdded ? null : t("integration.notOurs.path");
    case "add-explorer":
      return status.explorerThisCopy ? t("integration.already.explorer") : null;
    case "remove-explorer":
      return status.explorerThisCopy ? null : t("integration.notOurs.explorer");
  }
}

/**
 * "Add OpenMind Studio to PATH", "Remove ... from PATH", "Add/Remove 'Open with OpenMind Studio' in File Explorer" in
 * the command palette — for portable copies, which never register anything by themselves (the installer offers the
 * same as check boxes). Each asks first, per user only, and removal takes away only what OpenMind added.
 */
export function registerShellIntegrationCommands(deps: ShellIntegrationDeps): void {
  const run = async (action: IntegrationAction, titleKey: string) => {
    try {
      const status = await deps.ipc.integrationStatus();
      const skip = nothingToDo(action, status);
      if (skip !== null) {
        deps.events.emit("appNotice", { message: skip });
        return;
      }
      const notes = [t("integration.note.perUser"), t("integration.note.undo")];
      if (action === "add-path" || action === "remove-path") notes.push(t("integration.note.terminals"));
      if (action === "add-explorer" && status.explorerOtherCopy !== null) {
        notes.push(t("integration.note.replaces", { command: status.explorerOtherCopy }));
      }
      const yes = t("integration.confirm");
      const answer = await deps.confirm({
        extension: "OpenMind Studio",
        title: t(titleKey),
        details: changeDetails(action, status),
        notes,
        buttons: [yes],
      });
      if (answer !== yes) return;
      const message = await deps.ipc.integrationApply(action);
      deps.events.emit("appNotice", { message });
    } catch (error) {
      deps.events.emit("appError", { message: t("integration.failed", { error: String(error) }) });
    }
  };
  for (const [id, action, titleKey] of SHELL_INTEGRATION_COMMANDS) {
    deps.commands.register(id, () => run(action, titleKey));
  }
  const actions = () =>
    SHELL_INTEGRATION_COMMANDS.map(([command, , key]) => ({ command, label: t(key), inContextMenu: false }));
  deps.editor.setAppActions(actions(), "integration");
  i18n.subscribe(() => {
    deps.editor.setAppActions(actions(), "integration");
  });
}
