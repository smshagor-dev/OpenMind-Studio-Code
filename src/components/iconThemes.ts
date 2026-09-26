import { useSyncExternalStore } from "react";

/**
 * Icon themes. Every icon is a bundled SVG (the MIT-licensed Material Icon Theme): nothing is fetched, and a name the
 * theme doesn't know falls back to the generic file / folder icon, so no row ever shows a broken image. Extension
 * icon themes are not supported (an extension's `iconThemes` are listed as unsupported), so only these built-in
 * themes exist.
 */
export interface IconThemeDef {
  id: string;
  label: string;
  /** Files get the icon of their language (else one generic file icon). */
  fileIcons: boolean;
  /** Folders get an icon (else none, only the twistie). */
  folderIcons: boolean;
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
  return ICON_THEMES.find((theme) => theme.id === id) ?? (ICON_THEMES[0] as IconThemeDef);
}

let currentId = DEFAULT_ICON_THEME;
const listeners = new Set<() => void>();

/** The active icon theme's id (what `workbench.iconTheme` says). */
export function setActiveIconTheme(id: string): void {
  const resolved = iconThemeById(id).id;
  if (resolved === currentId) return;
  currentId = resolved;
  for (const listener of [...listeners]) listener();
}

export function activeIconTheme(): IconThemeDef {
  return iconThemeById(currentId);
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
    () => currentId,
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
