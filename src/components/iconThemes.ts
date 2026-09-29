import { useSyncExternalStore } from "react";

import type { IconThemeModel } from "../services/extensionIconTheme";

/**
 * Icon themes. The built-in ones use bundled SVGs (the MIT-licensed Material Icon Theme): nothing is fetched, and a
 * name the theme doesn't know falls back to the generic file / folder icon, so no row ever shows a broken image.
 * Since Milestone 18 an enabled extension's icon theme can be chosen too (`extension:<extension id>/<theme id>`): its
 * image icons are read from the extension folder when first needed, and until one is loaded — or when the theme
 * can't be used — the built-in icon is shown.
 */
export interface IconThemeDef {
  id: string;
  label: string;
  /** Files get the icon of their language (else one generic file icon). */
  fileIcons: boolean;
  /** Folders get an icon (else none, only the twistie). */
  folderIcons: boolean;
  /** An extension's theme, once loaded. */
  extension?: LoadedIconTheme;
}

/** A loaded extension icon theme: its model and the reader of its image files (a `data:` URL each). */
export interface LoadedIconTheme {
  id: string;
  label: string;
  model: IconThemeModel;
  readIcon: (path: string) => Promise<string>;
  /** The language of a file name (for the theme's `languageIds`), or `null`. */
  languageOf: (name: string) => string | null;
}

export const ICON_THEMES: readonly IconThemeDef[] = [
  {
    id: "material",
    label: "Material Icons (files and folders)",
    fileIcons: true,
    folderIcons: true,
  },
  {
    id: "material-files",
    label: "Material Icons (files only)",
    fileIcons: true,
    folderIcons: false,
  },
  {
    id: "minimal",
    label: "Minimal (one file icon, no folder icons)",
    fileIcons: false,
    folderIcons: false,
  },
];

export const DEFAULT_ICON_THEME = "material";

/** The theme with this id, or the default when the id is unknown (a removed or mistyped setting). */
export function iconThemeById(id: string): IconThemeDef {
  const builtIn = ICON_THEMES.find((theme) => theme.id === id);
  if (builtIn) return builtIn;
  if (id.startsWith("extension:")) {
    return {
      id,
      label: id.split("/").pop() || "Extension Icons",
      fileIcons: true,
      folderIcons: true,
    };
  }
  return ICON_THEMES[0] as IconThemeDef;
}

let currentId = DEFAULT_ICON_THEME;
let version = 0;
let loaded: LoadedIconTheme | null = null;
const iconUrls = new Map<string, string | null>();
const listeners = new Set<() => void>();

function changed(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

/** The active icon theme's id (what `workbench.iconTheme` says); an extension's id is kept as it is. */
export function setActiveIconTheme(id: string): void {
  const resolved = id.startsWith("extension:") ? id : iconThemeById(id).id;
  if (resolved === currentId) return;
  currentId = resolved;
  changed();
}

/** The loaded extension theme (or `null`: none, still loading, or unusable — the built-in one is shown). */
export function setExtensionIconTheme(theme: LoadedIconTheme | null): void {
  loaded = theme;
  iconUrls.clear();
  changed();
}

export function activeIconTheme(): IconThemeDef {
  if (currentId.startsWith("extension:") && loaded?.id === currentId) {
    return { id: loaded.id, label: loaded.label, fileIcons: true, folderIcons: true, extension: loaded };
  }
  return iconThemeById(currentId);
}

/**
 * The `data:` URL of an extension theme's icon, or `null` while it loads (or when it can't be read); the icons
 * re-render once it is there.
 */
export function extensionIconUrl(theme: LoadedIconTheme, path: string): string | null {
  const known = iconUrls.get(path);
  if (known !== undefined) return known;
  iconUrls.set(path, null);
  theme.readIcon(path).then(
    (url) => {
      if (loaded !== theme) return;
      iconUrls.set(path, url);
      changed();
    },
    () => {
      // Unreadable (missing, too large, not SVG/PNG): the built-in icon stays.
    },
  );
  return null;
}

/** Re-renders the caller when the icon theme changes. */
export function useIconTheme(): IconThemeDef {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => version,
  );
  return activeIconTheme();
}

/** Keeps the theme in step with a setting: applies the current value now and every change after. */
export function followIconTheme(settings: {
  string: (id: string, fallback: string) => string;
  onChange: (ids: string[], handler: () => void) => () => void;
}): () => void {
  const apply = () => {
    setActiveIconTheme(settings.string("workbench.iconTheme", DEFAULT_ICON_THEME));
  };
  apply();
  return settings.onChange(["workbench.iconTheme"], apply);
}
