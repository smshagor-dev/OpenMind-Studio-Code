import { i18n, t } from "./index";

/**
 * Menu rows are data with English labels (`menus.ts`); they are translated when a menu opens. A row is translated
 * only when its label is the English text of its command's key (`command.<id>`, `.alt`, `.toggled`), so rows that
 * carry data — a recent folder's path, a shell's name, a project command — keep their text.
 */
export function commandLabel(command: string, label: string): string {
  const bare = (text: string) => text.replace(/(\.\.\.|…)$/, "");
  for (const key of [`command.${command}`, `command.${command}.alt`, `command.${command}.toggled`]) {
    const english = i18n.english(key);
    if (english === label) return t(key);
    // Lists that name commands without the menu's trailing "..." (Keyboard Shortcuts) still match.
    if (english !== undefined && bare(english) === label) return bare(t(key));
  }
  return label;
}

function camel(text: string): string {
  const words = text.match(/[A-Za-z0-9]+/g) ?? ["x"];
  return words
    .map((word, index) =>
      index === 0 ? word.toLowerCase() : (word[0] ?? "").toUpperCase() + word.slice(1),
    )
    .join("");
}

export function submenuLabel(label: string): string {
  const key = `submenu.${camel(label)}`;
  return i18n.english(key) === label ? t(key) : label;
}

export function topMenuLabel(id: string, label: string): string {
  const key = `menu.${id}`;
  return i18n.english(key) === label ? t(key) : label;
}
