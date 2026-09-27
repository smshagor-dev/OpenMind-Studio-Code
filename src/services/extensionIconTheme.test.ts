import { afterEach, describe, expect, it, vi } from "vitest";

import { activeIconTheme, setActiveIconTheme, setExtensionIconTheme } from "../components/iconThemes";
import { testExtension } from "../testUtils/fakeExtensionsIpc";
import type { InstalledExtension } from "./extensionsIpc";
import { fileIconPath, folderIconPath, joinInside, parseIconTheme } from "./extensionIconTheme";
import { ExtensionIconThemeService, parseIconThemeValue } from "./extensionIconThemeService";

const THEME = JSON.stringify({
  iconDefinitions: {
    _file: { iconPath: "./icons/file.svg" },
    _folder: { iconPath: "./icons/folder.svg" },
    _ts: { iconPath: "./icons/ts.svg" },
    _dts: { iconPath: "./icons/dts.png" },
    _src: { iconPath: "./icons/src.svg" },
    _srcOpen: { iconPath: "./icons/src-open.svg" },
    _py: { iconPath: "./icons/py.svg" },
    _font: { fontCharacter: "E001" },
    _escape: { iconPath: "../../../evil.svg" },
  },
  file: "_file",
  folder: "_folder",
  fileExtensions: { ts: "_ts", "d.ts": "_dts" },
  fileNames: { "Package.JSON": "_font" },
  folderNames: { src: "_src" },
  folderNamesExpanded: { src: "_srcOpen" },
  languageIds: { python: "_py" },
});

const FONT_ONLY = JSON.stringify({ iconDefinitions: { a: { fontCharacter: "x" } } });

afterEach(() => {
  setExtensionIconTheme(null);
  setActiveIconTheme("material");
});

describe("extension icon theme parsing", () => {
  it("resolves image icons inside the extension and drops font icons and escapes", () => {
    const model = parseIconTheme(`// a comment\n${THEME}`, "themes/icons.json");
    expect(model.icons._ts).toBe("themes/icons/ts.svg");
    expect(model.icons._font).toBeUndefined();
    expect(model.icons._escape).toBeUndefined();
    expect(joinInside("a", "../../b")).toBeNull();
    expect(joinInside("a/b", "./c/../d.svg")).toBe("a/b/d.svg");
  });

  it("maps by file name, longest extension, language, then the default", () => {
    const model = parseIconTheme(THEME, "icons.json");
    expect(fileIconPath(model, "index.d.ts", null)).toBe("icons/dts.png");
    expect(fileIconPath(model, "App.TS", null)).toBe("icons/ts.svg");
    expect(fileIconPath(model, "main.py", "python")).toBe("icons/py.svg");
    // A name mapped to a font icon falls through to the default file icon.
    expect(fileIconPath(model, "package.json", "json")).toBe("icons/file.svg");
    expect(folderIconPath(model, "src", false)).toBe("icons/src.svg");
    expect(folderIconPath(model, "SRC", true)).toBe("icons/src-open.svg");
    expect(folderIconPath(model, "lib", true)).toBe("icons/folder.svg");
  });

  it("refuses a font-only theme and non-objects", () => {
    expect(() => parseIconTheme(FONT_ONLY, "t.json")).toThrow(/font icon/);
    expect(() => parseIconTheme("[]", "t.json")).toThrow();
  });

  it("parses the setting value", () => {
    expect(parseIconThemeValue("extension:pub.ext/my-icons")).toEqual({ extension: "pub.ext", theme: "my-icons" });
    expect(parseIconThemeValue("material")).toBeNull();
    expect(parseIconThemeValue("extension:pub.ext/")).toBeNull();
  });
});

function iconExtension(enabled = true): InstalledExtension {
  const base = testExtension().manifest;
  return testExtension({
    enabled,
    manifest: {
      ...base,
      name: "icons",
      publisher: "pub",
      contributes: {
        ...base.contributes,
        iconThemes: [{ id: "my-icons", label: "My Icons", path: "icons.json" }],
      },
    },
  });
}

function iconService(value: string, initial = [iconExtension()], text = THEME) {
  let current = value;
  let extensions = initial;
  const notice = vi.fn();
  const reset = vi.fn(() => {
    current = "material";
    return Promise.resolve({ ok: true });
  });
  const service = new ExtensionIconThemeService({
    settings: { string: () => current, onChange: () => () => undefined, reset },
    registry: { all: () => extensions, subscribe: () => () => undefined, loaded: () => true },
    readFile: () => Promise.resolve(text),
    readIcon: () => Promise.resolve("data:image/svg+xml;base64,AA=="),
    languageOf: () => null,
    notice,
  });
  const change = (next: { value?: string; extensions?: InstalledExtension[] }) => {
    if (next.value !== undefined) current = next.value;
    if (next.extensions) extensions = next.extensions;
  };
  return { service, notice, reset, change };
}

describe("ExtensionIconThemeService", () => {
  it("loads the chosen extension theme", async () => {
    setActiveIconTheme("extension:pub.icons/my-icons");
    const { service } = iconService("extension:pub.icons/my-icons");
    await service.apply();
    expect(activeIconTheme().extension?.label).toBe("My Icons");
  });

  it("goes back to the built-in icons when the extension is disabled", async () => {
    setActiveIconTheme("extension:pub.icons/my-icons");
    const { service, notice, reset } = iconService("extension:pub.icons/my-icons", [iconExtension(false)]);
    await service.apply();
    expect(reset).toHaveBeenCalledWith("user", "workbench.iconTheme");
    expect(notice).toHaveBeenCalledWith(expect.stringContaining("built-in icons"));
    expect(activeIconTheme().extension).toBeUndefined();
  });

  it("keeps the built-in icons and says why when the theme can't be used", async () => {
    setActiveIconTheme("extension:pub.icons/my-icons");
    const { service, notice } = iconService("extension:pub.icons/my-icons", [iconExtension()], FONT_ONLY);
    await service.apply();
    expect(notice).toHaveBeenCalledWith(expect.stringContaining("My Icons"));
    expect(activeIconTheme().extension).toBeUndefined();
  });

  it("resets the setting once when the applied theme's extension is disabled (the setting then reads as the default)", async () => {
    setActiveIconTheme("extension:pub.icons/my-icons");
    const { service, notice, reset, change } = iconService("extension:pub.icons/my-icons");
    await service.apply();
    // Disabled: its theme is no longer a valid choice, so the effective value is the default.
    change({ value: "material", extensions: [iconExtension(false)] });
    await service.apply();
    expect(reset).toHaveBeenCalledTimes(1);
    expect(notice).toHaveBeenCalledWith(expect.stringContaining("built-in icons"));
    await service.apply();
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("resets and tells the user once even when the settings and the registry both report the removal", async () => {
    setActiveIconTheme("extension:pub.icons/my-icons");
    const { service, notice, reset, change } = iconService("extension:pub.icons/my-icons");
    await service.apply();
    // The registry updates first while the settings still hold the old value, twice in a row.
    change({ extensions: [iconExtension(false)] });
    reset.mockImplementation(() => Promise.resolve({ ok: true }));
    await Promise.all([service.apply(), service.apply()]);
    change({ value: "material" });
    await service.apply();
    expect(reset).toHaveBeenCalledTimes(1);
    expect(notice).toHaveBeenCalledTimes(1);
  });

  it("doesn't reset anything when the user picks a built-in theme again", async () => {
    setActiveIconTheme("extension:pub.icons/my-icons");
    const { service, reset, notice, change } = iconService("extension:pub.icons/my-icons");
    await service.apply();
    change({ value: "minimal" });
    await service.apply();
    expect(reset).not.toHaveBeenCalled();
    expect(notice).not.toHaveBeenCalled();
    expect(activeIconTheme().extension).toBeUndefined();
  });

  it("leaves built-in themes alone", async () => {
    setActiveIconTheme("minimal");
    const { service, reset } = iconService("minimal");
    await service.apply();
    expect(reset).not.toHaveBeenCalled();
    expect(activeIconTheme().id).toBe("minimal");
  });
});
