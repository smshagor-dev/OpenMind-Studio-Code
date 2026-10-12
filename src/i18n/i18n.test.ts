/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { applyLanguageSetting, i18n, initLanguage, t, type UiLanguage } from "./index";
import { I18n, interpolate, languageForTag, LANGUAGES, resolveLanguage, validateCatalog } from "./i18n";
import en from "./locales/en.json";
import ru from "./locales/ru.json";
import { commandLabel, submenuLabel, topMenuLabel } from "./menuLabels";
import { categoryLabel, optionLabel, settingDescription, settingTitle } from "./settingsText";
import { unbuiltReason } from "../services/menus";

const ROOT = process.cwd();

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
    expect(languageForTag("ru_KZ")).toBe("ru");
    expect(languageForTag("EN-gb")).toBe("en");
    expect(languageForTag("hi-IN")).toBeNull();
    expect(languageForTag("ur-PK")).toBeNull();
    expect(languageForTag("bn-BD")).toBeNull();
    expect(languageForTag("")).toBeNull();
  });

  it("uses the setting first, then the system languages in order, then English", () => {
    expect(resolveLanguage("ru", ["en-US"])).toBe("ru");
    expect(resolveLanguage("system", ["ru-RU", "en-US"])).toBe("ru");
    expect(resolveLanguage("system", ["hi-IN", "ru-RU"])).toBe("ru");
    expect(resolveLanguage("system", ["de-DE"])).toBe("en");
    expect(resolveLanguage("klingon", [])).toBe("en");
  });

  it("the bundled languages match the backend's list", () => {
    const rust = readFileSync(join(ROOT, "crates/core/src/locale.rs"), "utf8");
    expect(rust).toContain(`pub const SUPPORTED_LANGUAGES: &[&str] = &[${LANGUAGES.map((l) => `"${l}"`).join(", ")}];`);
  });
});

describe("the catalogs", () => {
  const catalogs = { en, ru } as Record<string, Record<string, unknown>>;

  it("Russian translates every English key (no silent fallback)", () => {
    const keys = Object.keys(en);
    expect(keys.length).toBeGreaterThan(1000);
    for (const language of ["ru"]) {
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
      for (const language of ["ru"]) {
        const translated = catalogs[language]?.[key];
        if (typeof value !== "string") {
          expect(typeof translated, `${language} ${key}`).toBe("object");
          expect((translated as Record<string, string>).other, `${language} ${key}`).toBeTruthy();
        }
        expect([...names(translated)].sort(), `${language} ${key}`).toEqual([...english].sort());
      }
    }
    expect(Object.keys(validateCatalog(ru))).toHaveLength(Object.keys(ru).length);
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
  });

  it("a key a language lacks falls back to English, and an unknown key shows itself", () => {
    const translator = new I18n({ en: { a: "A", b: "B {name}" }, ru: { a: "А" } });
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
    });
    translator.setLanguage("ru");
    expect(translator.t("a")).toBe("A");
    expect(translator.t("plural", { count: 2 })).toBe("2 items");
    expect(new I18n({ en: { a: "A" }, ru: "not an object" }).t("a")).toBe("A");
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
  });

  it("changing the setting changes the language at once (subscribers hear it)", () => {
    let heard = 0;
    const stop = i18n.subscribe(() => {
      heard += 1;
    });
    i18n.setSystemLanguage("ru");
    applyLanguageSetting("system");
    expect(i18n.language).toBe("ru");
    applyLanguageSetting("en");
    expect(i18n.language).toBe("en");
    applyLanguageSetting("ru");
    expect(i18n.language).toBe("ru");
    applyLanguageSetting("en");
    expect(heard).toBe(4);
    stop();
  });
});

describe("start-up", () => {
  const answer = (over: Partial<UiLanguage>): UiLanguage => ({
    systemTags: ["ru-RU"],
    systemLanguage: "ru",
    setting: "system",
    language: "ru",
    supported: ["en", "ru"],
    simulated: false,
    ...over,
  });

  it("follows the PC's language by default", async () => {
    await initLanguage(() => Promise.resolve(answer({})));
    expect(i18n.language).toBe("ru");
    expect(i18n.system).toBe("ru");
  });

  it("a manual choice beats the PC's language", async () => {
    await initLanguage(() => Promise.resolve(answer({ setting: "en" })));
    expect(i18n.language).toBe("en");
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
    expect(unbuiltReason("help.reportIssue")).toContain("OpenMind Studio");
    expect(unbuiltReason("nothing.known")).toBe("Эта функция пока не реализована.");
  });

  it("built-in settings are translated, an extension's setting keeps its own text", () => {
    i18n.setLanguage("ru");
    expect(settingTitle({ id: "editor.fontSize", title: "Font Size" })).toBe("Размер шрифта");
    expect(settingTitle({ id: "myExt.option", title: "My Option" })).toBe("My Option");
    expect(settingTitle({ id: "editor.fontSize", title: "Changed In Rust" })).toBe("Changed In Rust");
    expect(settingDescription({ id: "editor.tabSize", description: "Number of spaces a tab is equal to." })).toBe(
      "Количество пробелов, которому равна табуляция.",
    );
    expect(categoryLabel("Editor")).toBe("Редактор");
    i18n.setSystemLanguage("ru");
    expect(optionLabel("workbench.language", { value: "system", label: "System Default" })).toBe(
      "Системный по умолчанию — сейчас Русский",
    );
    expect(optionLabel("workbench.language", { value: "ru", label: "Русский (Russian)" })).toBe("Русский (Russian)");
  });
});
