import { useSyncExternalStore } from "react";

import { I18n, LANGUAGES, resolveLanguage, type Language, type Params } from "./i18n";
import en from "./locales/en.json";
import ru from "./locales/ru.json";

export { LANGUAGE_NAMES, LANGUAGES, SYSTEM_LANGUAGE, resolveLanguage, type Language } from "./i18n";

/** The app's one translator (every window builds its own; all read the same bundled files). */
export const i18n = new I18n({ en, ru });

/** Translates `key` into the current UI language (English when the language lacks it). */
export function t(key: string, params?: Params): string {
  return i18n.t(key, params);
}

/** `t` for components: re-renders the component when the UI language changes. */
export function useT(): typeof t {
  useSyncExternalStore(i18n.subscribe, () => i18n.language);
  return t;
}

/** The backend's `locale::UiLanguage`. */
export interface UiLanguage {
  systemTags: string[];
  systemLanguage: string;
  setting: string;
  language: string;
  supported: string[];
  simulated: boolean;
}

function asLanguage(value: string): Language {
  return (LANGUAGES as readonly string[]).includes(value) ? (value as Language) : "en";
}

/**
 * Sets the language before the first screen renders: the PC's language and the user's setting, both from the
 * backend. Never blocks for long and never fails: without an answer the UI is English.
 */
export async function initLanguage(
  ask: () => Promise<UiLanguage>,
  timeoutMs = 1500,
): Promise<UiLanguage | null> {
  try {
    const answer = await Promise.race([
      ask(),
      new Promise<null>((resolve) => {
        setTimeout(() => {
          resolve(null);
        }, timeoutMs);
      }),
    ]);
    if (!answer) return null;
    i18n.setSystemLanguage(asLanguage(answer.systemLanguage));
    i18n.setLanguage(resolveLanguage(answer.setting, answer.systemTags));
    return answer;
  } catch {
    return null;
  }
}

/** Applies a new value of `workbench.language` (live: every component using `useT` re-renders). */
export function applyLanguageSetting(setting: string): void {
  i18n.setLanguage(resolveLanguage(setting, [i18n.system]));
}
