import { parseJsonc } from "./jsonc";

/**
 * An extension's file icon theme (VS Code's icon theme format), as far as OpenMind Studio supports it: icons that are
 * image files (SVG/PNG) inside the extension, chosen by file name, extension, language, folder name, and the
 * default file / folder icons. Font icons (`fontCharacter`), `light` / `highContrast` variants and `hidesExplorerArrows`
 * are not used; a theme with no image icons at all is refused (the built-in theme is used instead). Milestone 18.
 */
export interface IconThemeModel {
  /** Icon id -> image path inside the extension (resolved against the theme file's folder). */
  icons: Record<string, string>;
  file: string | null;
  folder: string | null;
  folderExpanded: string | null;
  fileExtensions: Record<string, string>;
  fileNames: Record<string, string>;
  folderNames: Record<string, string>;
  folderNamesExpanded: Record<string, string>;
  languageIds: Record<string, string>;
}

function lowerMap(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, string> = {};
  for (const [key, id] of Object.entries(value as Record<string, unknown>)) {
    if (typeof id === "string") out[key.toLowerCase()] = id;
  }
  return out;
}

/** `dir/./a/../b.svg` -> `dir/b.svg`; `null` when it climbs above the extension folder. */
export function joinInside(base: string, relative: string): string | null {
  const parts: string[] = [];
  for (const part of `${base}/${relative}`.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

/**
 * Parses an icon theme file (`themePath` is its path inside the extension). Throws with a readable reason when it
 * isn't JSON or has no usable image icons.
 */
export function parseIconTheme(text: string, themePath: string): IconThemeModel {
  const raw = parseJsonc(text);
  if (typeof raw !== "object" || raw === null) throw new Error("The icon theme is not a JSON object.");
  const root = raw as Record<string, unknown>;
  const base = themePath.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
  const icons: Record<string, string> = {};
  const definitions = root.iconDefinitions;
  if (typeof definitions === "object" && definitions !== null) {
    for (const [id, def] of Object.entries(definitions as Record<string, unknown>)) {
      const iconPath = (def as { iconPath?: unknown } | null)?.iconPath;
      if (typeof iconPath !== "string" || !/\.(svg|png)$/i.test(iconPath)) continue;
      const resolved = joinInside(base, iconPath);
      if (resolved !== null) icons[id] = resolved;
    }
  }
  if (Object.keys(icons).length === 0) {
    throw new Error(
      "This icon theme has no SVG or PNG icons (font icon themes aren't supported), so the built-in icons are used.",
    );
  }
  const id = (value: unknown) => (typeof value === "string" && value in icons ? value : null);
  return {
    icons,
    file: id(root.file),
    folder: id(root.folder),
    folderExpanded: id(root.folderExpanded) ?? id(root.folder),
    fileExtensions: lowerMap(root.fileExtensions),
    fileNames: lowerMap(root.fileNames),
    folderNames: lowerMap(root.folderNames),
    folderNamesExpanded: lowerMap(root.folderNamesExpanded),
    languageIds: lowerMap(root.languageIds),
  };
}

/**
 * The icon (image path) for a file: by whole name, then by extension (the longest, `d.ts` before `ts`), then by
 * language, then the theme's default file icon. `null` = the theme has nothing (the built-in icon is used).
 */
export function fileIconPath(theme: IconThemeModel, name: string, languageId: string | null): string | null {
  const lower = name.toLowerCase();
  const pick = (id: string | undefined | null) => (id && theme.icons[id]) || null;
  const byName = pick(theme.fileNames[lower]);
  if (byName) return byName;
  const parts = lower.split(".");
  for (let i = 1; i < parts.length; i += 1) {
    const found = pick(theme.fileExtensions[parts.slice(i).join(".")]);
    if (found) return found;
  }
  if (languageId !== null) {
    const found = pick(theme.languageIds[languageId.toLowerCase()]);
    if (found) return found;
  }
  return pick(theme.file);
}

/** The icon for a folder, open or closed; `null` = none from this theme. */
export function folderIconPath(theme: IconThemeModel, name: string, open: boolean): string | null {
  const lower = name.toLowerCase();
  const pick = (id: string | undefined | null) => (id && theme.icons[id]) || null;
  if (open) return pick(theme.folderNamesExpanded[lower]) ?? pick(theme.folderNames[lower]) ?? pick(theme.folderExpanded);
  return pick(theme.folderNames[lower]) ?? pick(theme.folder);
}
