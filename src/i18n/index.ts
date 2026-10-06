import { useSyncExternalStore } from "react";

import { I18n, isLanguage, resolveLanguage, type Language, type Params } from "./i18n";
import en from "./locales/en.json";

export {
  LANGUAGE_INFO,
  LANGUAGE_NAMES,
  LANGUAGES,
  SYSTEM_LANGUAGE,
  resolveLanguage,
  type Language,
} from "./i18n";

/** The app's one translator (every window builds its own; all read the same bundled files). */
export const i18n = new I18n({ en });

/**
 * The other languages' catalogs: bundled with the app as separate chunks, so only the language in use is parsed.
 * Nothing is downloaded — these are files of the app itself.
 */
const CATALOGS = import.meta.glob<{ default: unknown }>(["./locales/*.json", "!./locales/en.json"]);

/** Loads a language's catalog if it isn't loaded yet; `false` when it isn't bundled or can't be read. */
export async function loadLanguage(language: Language): Promise<boolean> {
  if (i18n.isLoaded(language)) return true;
  const load = CATALOGS[`./locales/${language}.json`];
  if (!load) return false;
  try {
    i18n.addCatalog(language, (await load()).default);
    return true;
  } catch {
    return false;
  }
}

let switchSeq = 0;

/** Shows `language` once its catalog is loaded (English if it can't be); a newer switch wins over an older one. */
async function switchTo(language: Language): Promise<void> {
  const seq = ++switchSeq;
  const loaded = await loadLanguage(language);
  if (seq !== switchSeq) return;
  i18n.setLanguage(loaded ? language : "en");
}

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
  return isLanguage(value) ? value : "en";
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
    await switchTo(resolveLanguage(answer.setting, answer.systemTags));
    return answer;
  } catch {
    return null;
  }
}

/** Applies a new value of `workbench.language` (live: every component using `useT` re-renders once it is loaded). */
export function applyLanguageSetting(setting: string): Promise<void> {
  return switchTo(resolveLanguage(setting, [i18n.system]));
}
