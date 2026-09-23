import type { DocumentSnapshot } from "./documentService";
import type { ThemeKind } from "./ipc";

/**
 * The single shared event map for the app's `EventBus`. Kept centralized
 * (rather than one bus per service) so services can react to each other
 * (e.g. WorkspaceService re-deriving its tab list when a document's dirty
 * state changes) without depending on each other directly.
 */
export interface AppEvents extends Record<string, unknown> {
  documentDirtyChanged: { id: string; dirty: boolean };
  documentSaved: { id: string; path: string };
  tabsChanged: { tabs: DocumentSnapshot[]; activeId: string | null };
  themeChanged: { theme: ThemeKind };
}
