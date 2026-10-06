/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { applyLanguageSetting, i18n, initLanguage, loadLanguage, t, type UiLanguage } from "./index";
import { I18n, interpolate, languageForTag, LANGUAGES, resolveLanguage, validateCatalog } from "./i18n";
import { canonicalTag, LANGUAGE_INFO } from "./languages";
import en from "./locales/en.json";
import { commandLabel, submenuLabel, topMenuLabel } from "./menuLabels";
import { categoryLabel, optionLabel, settingDescription, settingTitle } from "./settingsText";
import { unbuiltReason } from "../services/menus";

const ROOT = process.cwd();

/** Every bundled catalog, read from disk (the app itself loads the non-English ones lazily). */
const catalogs: Record<string, Record<string, unknown>> = Object.fromEntries(
  LANGUAGES.map((language) => [
    language,
    JSON.parse(readFileSync(join(ROOT, `src/i18n/locales/${language}.json`), "utf8")) as Record<string, unknown>,
  ]),
);
const TRANSLATED = LANGUAGES.filter((language) => language !== "en");

beforeAll(async () => {
  for (const language of TRANSLATED) expect(await loadLanguage(language), language).toBe(true);
});

afterEach(() => {
  i18n.setSystemLanguage("en");
  i18n.setLanguage("en");
});

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

describe("language resolution", () => {
  it("maps locale tags to bundled languages by their base", () => {
    expect(languageForTag("ru-RU")).toBe("ru");
    expect(languageForTag("bn-BD")).toBe("bn");
    expect(languageForTag("bn_IN")).toBe("bn");
    expect(languageForTag("EN-gb")).toBe("en");
    expect(languageForTag("hi-IN")).toBeNull();
    expect(languageForTag("ur-PK")).toBeNull();
    expect(languageForTag("")).toBeNull();
  });

  it("uses the setting first, then the system languages in order, then English", () => {
    expect(resolveLanguage("bn", ["ru-RU"])).toBe("bn");
    expect(resolveLanguage("system", ["ru-RU", "en-US"])).toBe("ru");
    expect(resolveLanguage("system", ["hi-IN", "bn-IN"])).toBe("bn");
    expect(resolveLanguage("system", ["de-DE"])).toBe("en");
    expect(resolveLanguage("klingon", [])).toBe("en");
  });

  it("the bundled languages match the backend's list", () => {
    const rust = readFileSync(join(ROOT, "crates/core/src/locale.rs"), "utf8");
    expect(rust).toContain(`pub const SUPPORTED_LANGUAGES: &[&str] = &[${LANGUAGES.map((l) => `"${l}"`).join(", ")}];`);
  });

  it("the language table matches the backend's (names and direction)", () => {
    const rust = readFileSync(join(ROOT, "crates/core/src/locale.rs"), "utf8");
    const table = rust.slice(rust.indexOf("pub const LANGUAGES"), rust.indexOf("pub const SUPPORTED_LANGUAGES"));
    const rows = [...table.matchAll(/(lang|rtl)\("([^"]+)", "([^"]+)", "([^"]+)"\)/g)].map((m) => ({
      code: m[2],
      native: m[3],
      english: m[4],
      rtl: m[1] === "rtl",
    }));
    expect(rows).toEqual(LANGUAGE_INFO.map((info) => ({ ...info })));
  });

  it("reduces tags the same way as the backend", () => {
    for (const [tag, id] of [
      ["zh-Hant-TW", "zh-tw"],
      ["zh_HK", "zh-tw"],
      ["zh-MO", "zh-tw"],
      ["zh-Hans-CN", "zh-cn"],
      ["zh-SG", "zh-cn"],
      ["zh", "zh-cn"],
      ["pt-PT", "pt-br"],
      ["pt-BR", "pt-br"],
      ["tl-PH", "fil"],
      ["fil-PH", "fil"],
      ["iw-IL", "he"],
      ["in-ID", "id"],
      ["ar-SA", "ar"],
      ["de_DE.UTF-8", "de"],
      ["  ", ""],
    ] as const) {
      expect(canonicalTag(tag), tag).toBe(id);
    }
  });

  it("offers every bundled language in Settings with the backend's label", () => {
    for (const info of LANGUAGE_INFO) {
      const label = info.native === info.english ? info.native : `${info.native} (${info.english})`;
      expect((en as Record<string, unknown>)[`setting.workbench.language.option.${info.code}`], info.code).toBe(label);
    }
  });
});

describe("the catalogs", () => {
  it("every bundled language translates every English key (no silent fallback)", () => {
    const keys = Object.keys(en);
    expect(keys.length).toBeGreaterThan(1000);
    for (const language of TRANSLATED) {
      const missing = keys.filter((key) => !(key in (catalogs[language] ?? {})));
      expect(missing, language).toEqual([]);
      const extra = Object.keys(catalogs[language] ?? {}).filter((key) => !(key in en));
      expect(extra, language).toEqual([]);
    }
  });

  it("every message is well formed and keeps the English placeholders", () => {
    const names = (value: unknown) =>
      new Set(
        (typeof value === "string" ? value : Object.values(value as Record<string, string>).join(" "))
          .match(/\{(\w+)\}/g) ?? [],
      );
    for (const [key, value] of Object.entries(en)) {
      const english = names(value);
      for (const language of TRANSLATED) {
        const translated = catalogs[language]?.[key];
        if (typeof value !== "string") {
          expect(typeof translated, `${language} ${key}`).toBe("object");
          expect((translated as Record<string, string>).other, `${language} ${key}`).toBeTruthy();
        }
        expect([...names(translated)].sort(), `${language} ${key}`).toEqual([...english].sort());
      }
    }
    for (const language of TRANSLATED) {
      const catalog = catalogs[language] ?? {};
      expect(Object.keys(validateCatalog(catalog)), language).toHaveLength(Object.keys(catalog).length);
    }
  });

  it("there is a catalog for each bundled language and none for a language that isn't listed", () => {
    const files = readdirSync(join(ROOT, "src/i18n/locales"))
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.replace(/\.json$/, ""))
      .sort();
    expect(files).toEqual([...LANGUAGES].sort());
  });

  it("every key the source asks for with t(\"...\") exists in English", () => {
    const used = new Set<string>();
    for (const file of sources(join(ROOT, "src"))) {
      for (const match of readFileSync(file, "utf8").matchAll(/\bt\(\s*"([\w.-]+)"/g)) {
        if (match[1]) used.add(match[1]);
      }
    }
    expect(used.size).toBeGreaterThan(700);
    const missing = [...used].filter((key) => !(key in en));
    expect(missing).toEqual([]);
  });

  it("nothing is downloaded or translated at run time", () => {
    for (const file of sources(join(ROOT, "src/i18n"))) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/\bfetch\(|XMLHttpRequest|import\(|https?:\/\//);
    }
  });
});

describe("translation", () => {
  it("English is the default and the fallback", () => {
    expect(i18n.language).toBe("en");
    expect(t("common.save")).toBe("Save");
    i18n.setLanguage("ru");
    expect(t("common.save")).toBe("Сохранить");
    i18n.setLanguage("bn");
    expect(t("common.save")).toBe("সংরক্ষণ করুন");
  });

  it("a key a language lacks falls back to English, and an unknown key shows itself", () => {
    const translator = new I18n({ en: { a: "A", b: "B {name}" }, ru: { a: "А" }, bn: {} });
    translator.setLanguage("ru");
    expect(translator.t("a")).toBe("А");
    expect(translator.t("b", { name: "x" })).toBe("B x");
    expect(translator.t("nope")).toBe("nope");
    expect(translator.missing.has("nope")).toBe(true);
  });

  it("a damaged catalog never breaks the app: bad entries are dropped", () => {
    const translator = new I18n({
      en: { a: "A", plural: { one: "{count} item", other: "{count} items" } },
      ru: { a: 5, plural: { one: "only one form" } },
      bn: "not an object",
    });
    translator.setLanguage("ru");
    expect(translator.t("a")).toBe("A");
    expect(translator.t("plural", { count: 2 })).toBe("2 items");
    translator.setLanguage("bn");
    expect(translator.t("a")).toBe("A");
    expect(validateCatalog([1, 2])).toEqual({});
    expect(validateCatalog(null)).toEqual({});
  });

  it("interpolates named placeholders and leaves unknown ones", () => {
    expect(interpolate("Found {count} results in {file}", { count: 3, file: "a.ts" })).toBe(
      "Found 3 results in a.ts",
    );
    expect(interpolate("Hello {who}", {})).toBe("Hello {who}");
  });

  it("chooses plural forms by the language's rules", () => {
    expect(t("search.resultCount", { count: 1 })).toBe("1 result");
    expect(t("search.resultCount", { count: 5 })).toBe("5 results");
    i18n.setLanguage("ru");
    expect(t("search.resultCount", { count: 1 })).toBe("1 результат");
    expect(t("search.resultCount", { count: 3 })).toBe("3 результата");
    expect(t("search.resultCount", { count: 5 })).toBe("5 результатов");
    expect(t("search.resultCount", { count: 21 })).toBe("21 результат");
    i18n.setLanguage("bn");
    expect(t("search.resultCount", { count: 5 })).toBe("5টি ফলাফল");
  });

  it("changing the setting changes the language at once (subscribers hear it)", async () => {
    let heard = 0;
    const stop = i18n.subscribe(() => {
      heard += 1;
    });
    i18n.setSystemLanguage("ru");
    await applyLanguageSetting("bn");
    expect(i18n.language).toBe("bn");
    await applyLanguageSetting("system");
    expect(i18n.language).toBe("ru");
    await applyLanguageSetting("en");
    expect(i18n.language).toBe("en");
    expect(heard).toBe(3);
    stop();
  });

  it("when two switches overlap, the newer one wins", async () => {
    const first = applyLanguageSetting("ru");
    const second = applyLanguageSetting("bn");
    await Promise.all([first, second]);
    expect(i18n.language).toBe("bn");
    await applyLanguageSetting("en");
  });

  it("marks the page's language and text direction", async () => {
    await applyLanguageSetting("ru");
    expect(document.documentElement.lang).toBe("ru");
    expect(document.documentElement.dataset.uiDir).toBe("ltr");
    await applyLanguageSetting("en");
    expect(document.documentElement.lang).toBe("en");
  });
});

describe("start-up", () => {
  const answer = (over: Partial<UiLanguage>): UiLanguage => ({
    systemTags: ["ru-RU"],
    systemLanguage: "ru",
    setting: "system",
    language: "ru",
    supported: ["en", "ru", "bn"],
    simulated: false,
    ...over,
  });

  it("follows the PC's language by default", async () => {
    await initLanguage(() => Promise.resolve(answer({})));
    expect(i18n.language).toBe("ru");
    expect(i18n.system).toBe("ru");
  });

  it("a manual choice beats the PC's language", async () => {
    await initLanguage(() => Promise.resolve(answer({ setting: "bn" })));
    expect(i18n.language).toBe("bn");
  });

  it("an unsupported PC language, an error or no answer means English", async () => {
    await initLanguage(() => Promise.resolve(answer({ systemTags: ["hi-IN"], systemLanguage: "en" })));
    expect(i18n.language).toBe("en");
    expect(await initLanguage(() => Promise.reject(new Error("no backend")))).toBeNull();
    expect(i18n.language).toBe("en");
    expect(await initLanguage(() => new Promise(() => undefined), 10)).toBeNull();
    expect(i18n.language).toBe("en");
  });
});

describe("menus and settings text", () => {
  it("menu rows translate by their command, data rows keep their text", () => {
    i18n.setLanguage("ru");
    expect(topMenuLabel("file", "File")).toBe("Файл");
    expect(commandLabel("file.save", "Save")).toBe("Сохранить");
    expect(commandLabel("file.openRecentFolder", "C:/work/site")).toBe("C:/work/site");
    expect(commandLabel("view.toggleSidebarPosition", "Move Primary Side Bar Left")).toBe(
      "Переместить основную боковую панель влево",
    );
    expect(submenuLabel("Open Recent")).toBe("Открыть последние");
    expect(commandLabel("edit.configureDefaultFormatter", "Configure Default Formatter")).toBe(
      "Настроить модуль форматирования по умолчанию",
    );
    expect(submenuLabel("PowerShell")).toBe("PowerShell");
    expect(unbuiltReason("help.checkForUpdates")).toContain("OpenMind Studio");
    expect(unbuiltReason("nothing.known")).toBe("Эта функция пока не реализована.");
  });

  it("built-in settings are translated, an extension's setting keeps its own text", () => {
    i18n.setLanguage("bn");
    expect(settingTitle({ id: "editor.fontSize", title: "Font Size" })).toBe("ফন্টের আকার");
    expect(settingTitle({ id: "myExt.option", title: "My Option" })).toBe("My Option");
    expect(settingTitle({ id: "editor.fontSize", title: "Changed In Rust" })).toBe("Changed In Rust");
    expect(settingDescription({ id: "editor.tabSize", description: "Number of spaces a tab is equal to." })).toBe(
      "একটি ট্যাব কতগুলো স্পেসের সমান।",
    );
    expect(categoryLabel("Editor")).toBe("এডিটর");
    i18n.setSystemLanguage("ru");
    expect(optionLabel("workbench.language", { value: "system", label: "System Default" })).toBe(
      "সিস্টেম ডিফল্ট — এখন Русский",
    );
    expect(optionLabel("workbench.language", { value: "ru", label: "Русский (Russian)" })).toBe("Русский (Russian)");
  });
});
