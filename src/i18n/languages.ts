/**
 * The bundled UI languages. A language is listed only once its catalog (`locales/<code>.json`) translates every
 * English key. Mirrors `openmind_core::locale::LANGUAGES` (a test compares the two).
 */

export interface LanguageInfo {
  /** BCP 47 id, also the catalog's file name. */
  code: string;
  /** The language's own name (shown as-is in every UI language). */
  native: string;
  english: string;
  /** The script runs right to left. */
  rtl: boolean;
}

export const LANGUAGE_INFO = [
  { code: "en", native: "English", english: "English", rtl: false },
  { code: "ru", native: "Русский", english: "Russian", rtl: false },
  { code: "bn", native: "বাংলা", english: "Bangla", rtl: false },
] as const satisfies readonly LanguageInfo[];

export type Language = (typeof LANGUAGE_INFO)[number]["code"];

export const LANGUAGES: readonly Language[] = LANGUAGE_INFO.map((language) => language.code);

/** Each language's own name. */
export const LANGUAGE_NAMES = Object.fromEntries(
  LANGUAGE_INFO.map((language) => [language.code, language.native]),
) as Record<Language, string>;

export function isLanguage(value: string): value is Language {
  return (LANGUAGES as readonly string[]).includes(value);
}

export function isRtl(language: Language): boolean {
  return LANGUAGE_INFO.some((info) => info.code === language && info.rtl);
}

/** The lower-case id a locale tag would be bundled under. Mirrors `openmind_core::locale::canonical_tag`. */
export function canonicalTag(tag: string): string {
  const lowered = tag.trim().toLowerCase().replace(/_/g, "-").split(/[.@]/)[0] ?? "";
  const [base = "", ...rest] = lowered.split("-");
  switch (base) {
    case "zh":
      return rest.some((part) => ["hant", "tw", "hk", "mo"].includes(part)) ? "zh-tw" : "zh-cn";
    case "pt":
      return "pt-br";
    case "tl":
      return "fil";
    case "iw":
      return "he";
    case "in":
      return "id";
    default:
      return base;
  }
}

/** The bundled language for a locale tag (`ru-RU`, `zh-Hant-HK`, `EN`), or null. Mirrors `language_for_tag`. */
export function languageForTag(tag: string): Language | null {
  const candidate = canonicalTag(tag);
  return LANGUAGES.find((language) => language.toLowerCase() === candidate) ?? null;
}
