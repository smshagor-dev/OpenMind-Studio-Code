import { container } from "../services/container";
import {
  HIDDEN_WHEN_UNREGISTERED,
  pruneMenuEntries,
  unbuiltReason,
  type MenuEntry,
} from "../services/menus";
import type { PopupItem } from "./MenuPopup";

/**
 * Resolves declarative menu entries (command ids) into concrete popup rows:
 * enabled/checked state from the command registry, shortcut labels from the
 * keybinding service. Evaluated at render time, i.e. each time a menu opens.
 */
export function resolveMenuEntries(entries: MenuEntry[]): PopupItem[] {
  // Every entry is listed. One whose feature isn't built is disabled and says why, so no click does nothing; only
  // the AI item is hidden while no provider is on.
  return pruneMenuEntries(
    entries,
    (command) => container.commands.has(command) || !HIDDEN_WHEN_UNREGISTERED.has(command),
  ).map((entry): PopupItem => {
    if (entry.kind === "separator") {
      return entry;
    }
    if (entry.kind === "submenu") {
      return { kind: "submenu", label: entry.label, items: resolveMenuEntries(entry.items) };
    }
    const checked = container.commands.isChecked(entry.command);
    const useToggledLabel = entry.toggledLabel !== undefined && checked === true;
    const enabled = container.commands.isEnabled(entry.command);
    const reason = enabled
      ? undefined
      : container.commands.has(entry.command)
        ? container.commands.reasonFor(entry.command)
        : unbuiltReason(entry.command);
    return {
      kind: "item",
      label: useToggledLabel ? (entry.toggledLabel ?? entry.label) : entry.label,
      // An entry with arguments (a shell profile, a project command) is not the plain command: no shortcut.
      shortcut:
        entry.args === undefined ? container.keybindings.labelFor(entry.command) : undefined,
      enabled,
      reason,
      // A built feature that cannot run right now says why in its row; an unbuilt one only in its tooltip.
      showReason: reason !== undefined && container.commands.has(entry.command) ? true : undefined,
      checked: entry.toggledLabel !== undefined ? undefined : checked,
      onSelect: () => {
        container.run(entry.command, ...(entry.args ?? []));
      },
    };
  });
}
