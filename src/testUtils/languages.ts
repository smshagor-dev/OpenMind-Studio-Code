import { beforeAll, expect } from "vitest";

import { loadLanguage, type Language } from "../i18n";

/** Loads these UI languages' catalogs before the file's tests (the app loads them lazily, on first use). */
export function preloadLanguages(...languages: Language[]): void {
  beforeAll(async () => {
    for (const language of languages) expect(await loadLanguage(language), language).toBe(true);
  });
}
