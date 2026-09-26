import { container } from "../services/container";
import { pruneMenuEntries, type MenuEntry } from "../services/menus";
import type { PopupItem } from "./MenuPopup";

/**
 * Resolves declarative menu entries (command ids) into concrete popup rows:
 * enabled/checked state from the command registry, shortcut labels from the
 * keybinding service. Evaluated at render time, i.e. each time a menu opens.
 */
export function resolveMenuEntries(entries: MenuEntry[]): PopupItem[] {
  // An entry whose command isn't registered is not shown: nothing in a menu is a dead item.
  return pruneMenuEntries(entries, (command) => container.commands.has(command)).map(
    (entry): PopupItem => {
      if (entry.kind === "separator") {
        return entry;
      }
      if (entry.kind === "submenu") {
        return { kind: "submenu", label: entry.label, items: resolveMenuEntries(entry.items) };
      }
      const checked = container.commands.isChecked(entry.command);
      const useToggledLabel = entry.toggledLabel !== undefined && checked === true;
      const enabled = container.commands.isEnabled(entry.command);
      const reason = enabled ? undefined : container.commands.reasonFor(entry.command);
      return {
        kind: "item",
        label: useToggledLabel ? (entry.toggledLabel ?? entry.label) : entry.label,
        // An entry with arguments (a shell profile, a project command) is not the plain command: no shortcut.
        shortcut:
          entry.args === undefined ? container.keybindings.labelFor(entry.command) : undefined,
        enabled,
        reason,
        showReason: reason !== undefined ? true : undefined,
        checked: entry.toggledLabel !== undefined ? undefined : checked,
        onSelect: () => {
          container.run(entry.command, ...(entry.args ?? []));
        },
      };
    },
  );
}
