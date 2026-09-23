import { getTauriVersion, getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";

// Mirrors openmind_fs::TextEncoding (#[serde(rename_all = "kebab-case")]).
export type TextEncoding = "utf8" | "utf8-bom" | "utf16-le" | "utf16-be" | "windows1252";

// Mirrors openmind_fs::LineEnding (#[serde(rename_all = "kebab-case")]).
export type LineEnding = "lf" | "crlf" | "cr" | "mixed";

// Mirrors openmind_settings::ThemeKind (#[serde(rename_all = "kebab-case")]).
export type ThemeKind = "dark" | "light";

// Mirrors src-tauri::commands::document::OpenedDocument (camelCase).
export interface OpenedDocument {
  path: string;
  content: string;
  encoding: TextEncoding;
  lineEnding: LineEnding;
}

// Mirrors openmind_workspace::RecentFileInfo (camelCase).
export interface RecentFileInfo {
  path: string;
  openedAt: string;
}

// Mirrors openmind_workspace::SessionSnapshot (camelCase).
export interface SessionSnapshot {
  openPaths: string[];
  activePath: string | null;
}

// Mirrors openmind_fs::DirEntryInfo (camelCase).
export interface DirEntryInfo {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink: boolean;
}

// Mirrors openmind_fs::PathMetadata (camelCase).
export interface PathMetadata {
  path: string;
  isDir: boolean;
  isFile: boolean;
  isSymlink: boolean;
  size: number;
  readonly: boolean;
  modified: string | null;
}

// Mirrors openmind_workspace::WorkspaceInfo (camelCase).
export interface WorkspaceInfo {
  id: number;
  path: string;
  name: string;
}

// Mirrors openmind_workspace::ExplorerState (camelCase).
export interface ExplorerState {
  expandedPaths: string[];
  selectedPath: string | null;
}

// Mirrors openmind_db::PinnedFolderEntry (camelCase).
export interface PinnedFolderEntry {
  path: string;
  label: string | null;
}

// Mirrors openmind_terminal::ShellKind (camelCase).
export type ShellKind = "powerShell" | "cmd" | "gitBash" | "wsl";

// Mirrors openmind_terminal::ShellInfo.
export interface ShellInfo {
  kind: ShellKind;
  label: string;
  available: boolean;
}

// Mirrors openmind_terminal::TerminalSessionInfo.
export interface TerminalSessionInfo {
  id: string;
  shell: ShellKind;
  cwd: string;
  pid: number | null;
}

/**
 * Everything the frontend needs from the backend, as an interface — so
 * services that depend on it (DocumentService, WorkspaceService,
 * FileSystemService, ExplorerService, ThemeService) can be unit tested
 * against a fake implementation instead of a real Tauri runtime.
 */
// Property (arrow-function-typed), not method-shorthand, syntax: this type
// is implemented by plain object literals (`tauriIpcClient` below, and fake
// clients in tests) that never rely on `this`, and method-shorthand syntax
// makes eslint's `unbound-method` rule flag every bare `ipc.someMethod`
// reference (e.g. `expect(ipc.documentSave).toHaveBeenCalledWith(...)`).
export interface IpcClient {
  // Dialogs
  openDocumentDialog: () => Promise<string | null>;
  saveDocumentDialog: (defaultPath: string | undefined) => Promise<string | null>;
  openFolderDialog: () => Promise<string | null>;

  // Documents
  documentOpen: (path: string) => Promise<OpenedDocument>;
  documentSave: (path: string, content: string, encoding: TextEncoding) => Promise<void>;

  // Session / recent files / theme
  recentFilesList: () => Promise<RecentFileInfo[]>;
  recentFilesClear: () => Promise<void>;
  sessionLoad: () => Promise<SessionSnapshot>;
  sessionSave: (snapshot: SessionSnapshot) => Promise<void>;
  themeGet: () => Promise<ThemeKind>;
  themeSet: (theme: ThemeKind) => Promise<void>;

  // Workspace folder
  workspaceOpenFolder: (path: string) => Promise<WorkspaceInfo>;
  workspaceCloseFolder: () => Promise<void>;
  workspaceRecentFolders: () => Promise<WorkspaceInfo[]>;
  workspaceActiveFolder: () => Promise<WorkspaceInfo | null>;
  explorerStateLoad: (workspacePath: string) => Promise<ExplorerState>;
  explorerStateSave: (workspacePath: string, state: ExplorerState) => Promise<void>;
  pinFolder: (path: string, label: string | undefined) => Promise<void>;
  unpinFolder: (path: string) => Promise<void>;
  listPinnedFolders: () => Promise<PinnedFolderEntry[]>;

  // File system (explorer CRUD)
  fsReadDir: (path: string) => Promise<DirEntryInfo[]>;
  fsMetadata: (path: string) => Promise<PathMetadata>;
  fsIsBinary: (path: string) => Promise<boolean>;
  fsCreateFile: (workspaceRoot: string, parentDir: string, name: string) => Promise<string>;
  fsCreateFolder: (workspaceRoot: string, parentDir: string, name: string) => Promise<string>;
  fsRename: (workspaceRoot: string, path: string, newName: string) => Promise<string>;
  fsDelete: (workspaceRoot: string, path: string) => Promise<void>;
  fsMove: (workspaceRoot: string, source: string, destDir: string) => Promise<string>;
  fsCopy: (workspaceRoot: string, source: string, destDir: string) => Promise<string>;
  fsDuplicate: (workspaceRoot: string, path: string, newName: string) => Promise<string>;

  // Generic settings
  settingsGet: (key: string) => Promise<string | null>;
  settingsSet: (key: string, value: string) => Promise<void>;

  // Terminal (PTY sessions live in Rust; output/exit arrive as pushed events)
  terminalListShells: () => Promise<ShellInfo[]>;
  terminalCreate: (
    shell: ShellKind | null,
    cwd: string | null,
    cols: number,
    rows: number,
  ) => Promise<TerminalSessionInfo>;
  terminalWrite: (id: string, data: string) => Promise<void>;
  terminalResize: (id: string, cols: number, rows: number) => Promise<void>;
  terminalClose: (id: string) => Promise<void>;
  /** Subscribes to raw PTY output; resolves to the unsubscribe function. */
  onTerminalOutput: (handler: (id: string, data: Uint8Array) => void) => Promise<() => void>;
  /** Subscribes to shell-exit notifications; resolves to the unsubscribe function. */
  onTerminalExit: (handler: (id: string, code: number | null) => void) => Promise<() => void>;

  // System clipboard (the webview's own clipboard API is unreliable inside Tauri)
  clipboardWriteText: (text: string) => Promise<void>;
  clipboardReadText: () => Promise<string>;

  // App metadata (Help > About)
  appInfo: () => Promise<AppInfo>;
}

export interface AppInfo {
  version: string;
  tauriVersion: string;
}

function decodeBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export const tauriIpcClient: IpcClient = {
  async openDocumentDialog() {
    const selected = await openDialog({ multiple: false, directory: false });
    return typeof selected === "string" ? selected : null;
  },

  async saveDocumentDialog(defaultPath) {
    const selected = await saveDialog({ defaultPath });
    return selected ?? null;
  },

  async openFolderDialog() {
    const selected = await openDialog({ multiple: false, directory: true });
    return typeof selected === "string" ? selected : null;
  },

  documentOpen: (path) => invoke<OpenedDocument>("document_open", { path }),

  documentSave: (path, content, encoding) => invoke("document_save", { path, content, encoding }),

  recentFilesList: () => invoke<RecentFileInfo[]>("recent_files_list"),

  recentFilesClear: () => invoke("recent_files_clear"),

  sessionLoad: () => invoke<SessionSnapshot>("session_load"),

  sessionSave: (snapshot) => invoke("session_save", { snapshot }),

  themeGet: () => invoke<ThemeKind>("theme_get"),

  themeSet: (theme) => invoke("theme_set", { theme }),

  workspaceOpenFolder: (path) => invoke<WorkspaceInfo>("workspace_open_folder", { path }),

  workspaceCloseFolder: () => invoke("workspace_close_folder"),

  workspaceRecentFolders: () => invoke<WorkspaceInfo[]>("workspace_recent_folders"),

  workspaceActiveFolder: () => invoke<WorkspaceInfo | null>("workspace_active_folder"),

  explorerStateLoad: (workspacePath) =>
    invoke<ExplorerState>("explorer_state_load", { workspacePath }),

  explorerStateSave: (workspacePath, explorerState) =>
    invoke("explorer_state_save", { workspacePath, explorerState }),

  pinFolder: (path, label) => invoke("workspace_pin_folder", { path, label }),

  unpinFolder: (path) => invoke("workspace_unpin_folder", { path }),

  listPinnedFolders: () => invoke<PinnedFolderEntry[]>("workspace_list_pinned_folders"),

  fsReadDir: (path) => invoke<DirEntryInfo[]>("fs_read_dir", { path }),

  fsMetadata: (path) => invoke<PathMetadata>("fs_metadata", { path }),

  fsIsBinary: (path) => invoke<boolean>("fs_is_binary", { path }),

  fsCreateFile: (workspaceRoot, parentDir, name) =>
    invoke<string>("fs_create_file", { workspaceRoot, parentDir, name }),

  fsCreateFolder: (workspaceRoot, parentDir, name) =>
    invoke<string>("fs_create_folder", { workspaceRoot, parentDir, name }),

  fsRename: (workspaceRoot, path, newName) =>
    invoke<string>("fs_rename", { workspaceRoot, path, newName }),

  fsDelete: (workspaceRoot, path) => invoke("fs_delete", { workspaceRoot, path }),

  fsMove: (workspaceRoot, source, destDir) =>
    invoke<string>("fs_move", { workspaceRoot, source, destDir }),

  fsCopy: (workspaceRoot, source, destDir) =>
    invoke<string>("fs_copy", { workspaceRoot, source, destDir }),

  fsDuplicate: (workspaceRoot, path, newName) =>
    invoke<string>("fs_duplicate", { workspaceRoot, path, newName }),

  settingsGet: (key) => invoke<string | null>("settings_get", { key }),

  settingsSet: (key, value) => invoke("settings_set", { key, value }),

  terminalListShells: () => invoke<ShellInfo[]>("terminal_list_shells"),

  terminalCreate: (shell, cwd, cols, rows) =>
    invoke<TerminalSessionInfo>("terminal_create", { shell, cwd, cols, rows }),

  terminalWrite: (id, data) => invoke("terminal_write", { id, data }),

  terminalResize: (id, cols, rows) => invoke("terminal_resize", { id, cols, rows }),

  terminalClose: (id) => invoke("terminal_close", { id }),

  onTerminalOutput: (handler) =>
    listen<{ id: string; data: string }>("terminal:output", (event) => {
      handler(event.payload.id, decodeBase64(event.payload.data));
    }),

  onTerminalExit: (handler) =>
    listen<{ id: string; code: number | null }>("terminal:exit", (event) => {
      handler(event.payload.id, event.payload.code);
    }),

  clipboardWriteText: (text) => writeText(text),

  clipboardReadText: () => readText(),

  appInfo: async () => ({ version: await getVersion(), tauriVersion: await getTauriVersion() }),
};
