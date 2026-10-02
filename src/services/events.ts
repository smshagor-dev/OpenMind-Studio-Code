import type { DebugFrame } from "./debugModel";
import type { DocumentSnapshot } from "./documentService";
import type { DebugRun, LspDiagnosticsEvent, ThemeKind, WorkspaceInfo } from "./ipc";

/**
 * The single shared event map for the app's `EventBus`. Kept centralized
 * (rather than one bus per service) so services can react to each other
 * (e.g. WorkspaceService re-deriving its tab list when a document's dirty
 * state changes) without depending on each other directly.
 */
export interface AppEvents extends Record<string, unknown> {
  documentDirtyChanged: { id: string; dirty: boolean };
  documentSaved: { id: string; path: string };
  /** A document now exists (its text is loaded and it can be edited). */
  documentOpened: { id: string };
  /** A document is about to go away; `path` is where its file was, if it had one. */
  documentClosed: { id: string; path: string | null };
  /** A language server published diagnostics for a file. */
  lspDiagnostics: LspDiagnosticsEvent;
  /** A language server is no longer running (stopped, crashed or restarted): what it reported is stale. */
  lspServerStopped: { server: string };
  /** The installed extensions, their state or the extension host changed. */
  extensionsChanged: undefined;
  /** Language server status changed (started, stopped, installed, ...). */
  lspChanged: undefined;
  /** The debug run changed (started, paused, resumed, ended); null once there is none. */
  debugRunChanged: DebugRun | null;
  /** The program is paused: the stack, variables and watches should be read. */
  debugPaused: { threadId: number };
  /** A stack frame was chosen (or `null`: nothing is selected any more). */
  debugFrameSelected: DebugFrame | null;
  /** The program runs again or the run ended: what was read while paused is stale. */
  debugResumed: undefined;
  /** Open the Language Tools dialog. */
  showLanguageTools: undefined;
  /** An open document's relationship with its file on disk changed (changed / deleted / renamed / back in sync). */
  documentExternalChanged: { id: string };
  /** A short, non-error message for the user (a file was reloaded, a diff was closed, ...). */
  appNotice: { message: string };
  tabsChanged: { tabs: DocumentSnapshot[]; activeId: string | null };
  themeChanged: { theme: ThemeKind };
  /** The effective value of these settings changed (a file was saved, the folder changed, the page edited them). */
  settingsChanged: { ids: string[] };
  workspaceFolderChanged: { workspace: WorkspaceInfo | null };
  explorerChanged: undefined;
  /** A folder was pinned or unpinned — StartPage and any explorer pin toggle should re-read the list. */
  pinnedFoldersChanged: undefined;
  /** A caught, non-fatal error to surface to the user (e.g. a toast) — never thrown, so a failed
   * explorer/document operation never crashes the app or fails silently. */
  appError: { message: string };
  /** UI-only requests raised by commands (menus/keybindings) that a component must fulfil. */
  showAbout: undefined;
  /** New File / New Folder from a menu or the palette: the Explorer shows a name box in the tree. */
  explorerCreate: { kind: "file" | "folder" };
  focusExplorer: undefined;
  /** Focus the Search view's input (Find in Files). */
  focusSearch: undefined;
  showRuntimeManager: undefined;
  /** Open the "Configure Run Command" dialog for the active file type. */
  showRunConfiguration: undefined;
}
