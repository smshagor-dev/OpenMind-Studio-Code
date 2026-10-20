import type { MenuHostEditor } from "./revisionMenu";

type Attach = (editor: MenuHostEditor, uri: string | null) => (() => void) | undefined;

let attach: Attach | null = null;

/** Set once the editor menu is installed (it owns the revision tabs' menu). */
export function setRevisionAttach(next: Attach): void {
  attach = next;
}

/**
 * A read-only preview editor: a Git revision tab gets the app's context menu (read-only actions only). Kept apart
 * from the menu's wiring so a preview doesn't load the whole app container.
 */
export function attachRevisionEditor(editor: MenuHostEditor, uri: string | null): (() => void) | undefined {
  return attach?.(editor, uri);
}
