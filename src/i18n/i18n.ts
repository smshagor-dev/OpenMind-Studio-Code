/**
 * The app's UI language. Translations are JSON files bundled with the app (`locales/*.json`): nothing is downloaded
 * or translated at run time. Which language shows:
 *   1. the user's `workbench.language` setting when it names a bundled language,
 *   2. otherwise the PC's display language (its base: `ru-RU` -> `ru`),
 *   3. otherwise English.
 * A key a language doesn't have falls back to English, and a key English doesn't have shows the key itself (a test
 * keeps that from happening). Only the app's own text is translated — never code, paths, ids or extensions' text.
 */

export const LANGUAGES = ["en", "ru"] as const;
export type Language = (typeof LANGUAGES)[number];

/** The value of `workbench.language` that follows the PC. */
export const SYSTEM_LANGUAGE = "system";

/** Each language's own name (shown as-is in every UI language). */
export const LANGUAGE_NAMES: Record<Language, string> = {
  en: "English",
  ru: "Русский",
};

type PluralForm = "zero" | "one" | "two" | "few" | "many" | "other";
const PLURAL_FORMS: readonly PluralForm[] = ["zero", "one", "two", "few", "many", "other"];

/** A message: text with `{name}` placeholders, or plural forms chosen by the `count` parameter. */
export type Message = string | Partial<Record<PluralForm, string>>;
export type Catalog = Record<string, Message>;
export type Params = Record<string, string | number>;

function isLanguage(value: string): value is Language {
  return (LANGUAGES as readonly string[]).includes(value);
}

/** The bundled language for a locale tag (`ru-RU`, `ru_KZ`, `EN`), or null. Mirrors `openmind_core::locale`. */
export function languageForTag(tag: string): Language | null {
  const base = tag.trim().split(/[-_.@]/)[0]?.toLowerCase() ?? "";
  return isLanguage(base) ? base : null;
}

/** The setting first, then the system's languages in order, then English. */
export function resolveLanguage(setting: string, systemTags: readonly string[]): Language {
  if (setting !== SYSTEM_LANGUAGE && isLanguage(setting)) return setting;
  for (const tag of systemTags) {
    const language = languageForTag(tag);
    if (language) return language;
  }
  return "en";
}

/**
 * Keeps only well-formed entries: a string, or an object of plural forms with an `other` string. Anything else in a
 * damaged file is dropped (those keys then fall back to English) — a bad translation never breaks the app.
 */
export function validateCatalog(raw: unknown): Catalog {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const catalog: Catalog = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") {
      catalog[key] = value;
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const forms: Partial<Record<PluralForm, string>> = {};
      for (const form of PLURAL_FORMS) {
        const text = (value as Record<string, unknown>)[form];
        if (typeof text === "string") forms[form] = text;
      }
      if (forms.other !== undefined) catalog[key] = forms;
    }
  }
  return catalog;
}

/** Replaces `{name}` with `params.name`; an unknown placeholder is left as written. */
export function interpolate(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

export class I18n {
  private readonly catalogs: Record<Language, Catalog>;
  private current: Language = "en";
  private systemLanguage: Language = "en";
  private readonly listeners = new Set<() => void>();
  private readonly plurals = new Map<Language, Intl.PluralRules>();
  /** Keys asked for that English doesn't have (a bug: the UI then shows the key). */
  readonly missing = new Set<string>();

  constructor(raw: Record<Language, unknown>) {
    this.catalogs = {
      en: validateCatalog(raw.en),
      ru: validateCatalog(raw.ru),
    };
  }

  get language(): Language {
    return this.current;
  }

  /** The language System Default resolves to on this PC. */
  get system(): Language {
    return this.systemLanguage;
  }

  setSystemLanguage(language: Language): void {
    this.systemLanguage = language;
  }

  setLanguage(language: Language): void {
    if (language === this.current) return;
    this.current = language;
    if (typeof document !== "undefined") document.documentElement.lang = language;
    for (const listener of this.listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  has(key: string, language: Language = this.current): boolean {
    return key in this.catalogs[language];
  }

  /** The English text of a plain (non-plural) message, if English has the key. */
  english(key: string): string | undefined {
    const message = this.catalogs.en[key];
    return typeof message === "string" ? message : undefined;
  }

  keys(language: Language): string[] {
    return Object.keys(this.catalogs[language]);
  }

  t = (key: string, params?: Params): string => {
    const message = this.catalogs[this.current][key] ?? this.catalogs.en[key];
    if (message === undefined) {
      this.missing.add(key);
      return key;
    }
    return interpolate(this.pick(message, key, params), params);
  };

  private pick(message: Message, key: string, params?: Params): string {
    if (typeof message === "string") return message;
    const count = params?.count;
    const language = this.catalogs[this.current][key] === message ? this.current : "en";
    const form = typeof count === "number" ? this.pluralRules(language).select(count) : "other";
    return message[form] ?? message.other ?? "";
  }

  private pluralRules(language: Language): Intl.PluralRules {
    let rules = this.plurals.get(language);
    if (!rules) {
      rules = new Intl.PluralRules(language);
      this.plurals.set(language, rules);
    }
    return rules;
  }
}
