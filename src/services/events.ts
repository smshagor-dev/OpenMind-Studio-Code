import type { DocumentSnapshot } from "./documentService";
import type { ThemeKind, WorkspaceInfo } from "./ipc";

/**
 * The single shared event map for the app's `EventBus`. Kept centralized
 * (rather than one bus per service) so services can react to each other
 * (e.g. WorkspaceService re-deriving its tab list when a document's dirty
 * state changes) without depending on each other directly.
 */
export interface AppEvents extends Record<string, unknown> {
  documentDirtyChanged: { id: string; dirty: boolean };
  documentSaved: { id: string; path: string };
  /** An open document's relationship with its file on disk changed (changed / deleted / renamed / back in sync). */
  documentExternalChanged: { id: string };
  /** A short, non-error message for the user (a file was reloaded, a diff was closed, ...). */
  appNotice: { message: string };
  tabsChanged: { tabs: DocumentSnapshot[]; activeId: string | null };
  themeChanged: { theme: ThemeKind };
  workspaceFolderChanged: { workspace: WorkspaceInfo | null };
  explorerChanged: undefined;
  /** A folder was pinned or unpinned — StartPage and any explorer pin toggle should re-read the list. */
  pinnedFoldersChanged: undefined;
  /** A caught, non-fatal error to surface to the user (e.g. a toast) — never thrown, so a failed
   * explorer/document operation never crashes the app or fails silently. */
  appError: { message: string };
  /** UI-only requests raised by commands (menus/keybindings) that a component must fulfil. */
  showAbout: undefined;
  focusExplorer: undefined;
  /** Focus the Search view's input (Find in Files). */
  focusSearch: undefined;
  showRuntimeManager: undefined;
  /** Open the "Configure Run Command" dialog for the active file type. */
  showRunConfiguration: undefined;
}
