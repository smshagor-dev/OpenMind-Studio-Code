import { container } from "../services/container";
import type { MenuEntry } from "../services/menus";
import type { PopupItem } from "./MenuPopup";

/**
 * Resolves declarative menu entries (command ids) into concrete popup rows:
 * enabled/checked state from the command registry, shortcut labels from the
 * keybinding service. Evaluated at render time, i.e. each time a menu opens.
 */
export function resolveMenuEntries(entries: MenuEntry[]): PopupItem[] {
  return entries.map((entry): PopupItem => {
    if (entry.kind === "separator") {
      return entry;
    }
    if (entry.kind === "submenu") {
      return { kind: "submenu", label: entry.label, items: resolveMenuEntries(entry.items) };
    }
    const checked = container.commands.isChecked(entry.command);
    const useToggledLabel = entry.toggledLabel !== undefined && checked === true;
    return {
      kind: "item",
      label: useToggledLabel ? (entry.toggledLabel ?? entry.label) : entry.label,
      shortcut: container.keybindings.labelFor(entry.command),
      enabled: container.commands.isEnabled(entry.command),
      checked: entry.toggledLabel !== undefined ? undefined : checked,
      onSelect: () => {
        container.run(entry.command, ...(entry.args ?? []));
      },
    };
  });
}
