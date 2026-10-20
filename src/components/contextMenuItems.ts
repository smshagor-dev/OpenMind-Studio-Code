import { commandLabel, submenuLabel } from "../i18n/menuLabels";
import { container } from "../services/container";
import type { GitTarget } from "../services/git/fileGitService";
import { unbuiltReason, type MenuEntry } from "../services/menus";
import type { PopupItem } from "./MenuPopup";
import { resolveMenuEntries } from "./menuItems";

function isTarget(value: unknown): value is GitTarget {
  return typeof value === "object" && value !== null && typeof (value as GitTarget).path === "string";
}

/** No separator first, last or twice in a row. */
function tidy(items: PopupItem[]): PopupItem[] {
  const result: PopupItem[] = [];
  for (const item of items) {
    const last = result[result.length - 1];
    if (item.kind === "separator" && (last === undefined || last.kind === "separator")) continue;
    result.push(item);
  }
  while (result[result.length - 1]?.kind === "separator") result.pop();
  return result;
}

/**
 * Menu entries as popup rows. An entry about a particular file (an Explorer or tab menu passes the file as the
 * command's argument) is judged for that file, not for the editor in front.
 */
export function resolveContextEntries(
  entries: MenuEntry[],
  reasonForFile: (command: string, path: string) => string | null,
): PopupItem[] {
  return tidy(
    entries.flatMap((entry): PopupItem[] => {
      if (entry.kind === "separator") return [{ kind: "separator" }];
      if (entry.kind === "submenu") {
        const items = resolveContextEntries(entry.items, reasonForFile);
        return items.length === 0 ? [] : [{ kind: "submenu", label: submenuLabel(entry.label), items }];
      }
      const target = entry.args?.[0];
      if (!isTarget(target)) return resolveMenuEntries([entry]);
      const registered = container.commands.has(entry.command);
      const reason = registered ? reasonForFile(entry.command, target.path) : unbuiltReason(entry.command);
      return [
        {
          kind: "item",
          label: commandLabel(entry.command, entry.label),
          enabled: registered && reason === null,
          reason: reason ?? undefined,
          showReason: reason !== null && registered ? true : undefined,
          onSelect: () => {
            container.run(entry.command, ...(entry.args ?? []));
          },
        },
      ];
    }),
  );
}
