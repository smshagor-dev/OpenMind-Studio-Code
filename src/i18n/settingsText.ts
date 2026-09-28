import { i18n, LANGUAGE_NAMES, t } from "./index";
import type { SettingDefinition } from "../services/ipc";

/**
 * The backend sends every setting's title, description and option labels in English. A built-in setting is shown
 * translated when the catalog's English matches what the backend sent (so a changed schema falls back to its own
 * English, never to a stale translation); an extension's setting keeps the extension's own text.
 */
function translated(key: string, english: string): string {
  return i18n.english(key) === english ? t(key) : english;
}

export function settingTitle(def: Pick<SettingDefinition, "id" | "title">): string {
  return translated(`setting.${def.id}.title`, def.title);
}

export function settingDescription(def: Pick<SettingDefinition, "id" | "description">): string {
  return translated(`setting.${def.id}.description`, def.description);
}

export function optionLabel(settingId: string, option: { value: string; label: string }): string {
  if (settingId === "workbench.language" && option.value === "system") {
    return t("settings.language.currentlySystem", { language: LANGUAGE_NAMES[i18n.system] });
  }
  return translated(`setting.${settingId}.option.${option.value}`, option.label);
}

function camel(text: string): string {
  const words = text.match(/[A-Za-z0-9]+/g) ?? ["x"];
  return words
    .map((word, index) =>
      index === 0 ? word.toLowerCase() : (word[0] ?? "").toUpperCase() + word.slice(1),
    )
    .join("");
}

export function categoryLabel(category: string): string {
  return translated(`settingCategory.${camel(category)}`, category);
}

/** A title-bar menu's name ("File", "Edit" ...) in the UI language, for lists that group commands by menu. */
export function menuCategoryLabel(category: string): string {
  for (const id of ["file", "edit", "selection", "view", "go", "run", "terminal", "help"]) {
    if (i18n.english(`menu.${id}`) === category) return t(`menu.${id}`);
  }
  return category;
}
