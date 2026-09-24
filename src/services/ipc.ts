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

export type DiskRead =
  | { state: "missing" }
  | { state: "file"; content: string; encoding: TextEncoding; lineEnding: LineEnding }
  | { state: "unreadable"; reason: string };

export type FsChangeKind = "created" | "modified" | "removed" | "renamed";

/** Mirrors openmind_file_watch::FileChange. */
export interface FsChange {
  path: string;
  kind: FsChangeKind;
  /** The old path of a rename. */
  from: string | null;
}

/** Mirrors openmind_file_watch::ChangeBatch: `overflow` = too many to list, re-check everything. */
export interface FsChangeBatch {
  changes: FsChange[];
  overflow: boolean;
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

// Mirrors openmind_runtime_manager (camelCase).
export type InstallPhase = "download" | "verify" | "extract" | "finalize" | "done";

export interface InstallProgress {
  kind: string;
  version: string;
  phase: InstallPhase;
  current: number;
  total: number | null;
}

export interface InstalledVersion {
  version: string;
  path: string;
  active: boolean;
  /** Every file the runtime definition requires is present; `false` means "repair me". */
  healthy: boolean;
  /** What this install can do (pip, venv, ...), from what is actually on disk. */
  features: FeatureStatus[];
}

export interface FeatureStatus {
  id: string;
  label: string;
  available: boolean;
  /** Why the feature is missing; empty when it's available. */
  note: string;
}

export interface RuntimeStatus {
  id: string;
  displayName: string;
  description: string;
  notes: string;
  defaultVersion: string;
  availableVersions: string[];
  installed: InstalledVersion[];
  activeVersion: string | null;
  /** A copy of this tool already on the system PATH, if any. */
  globalVersion: string | null;
  busy: boolean;
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
  /** What is on disk now, for an already-open document (does not touch recent files). */
  documentRead: (path: string) => Promise<DiskRead>;
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

  // Portable runtimes (Rust owns installs; progress arrives as pushed events)
  runtimeList: () => Promise<RuntimeStatus[]>;
  runtimeInstall: (kind: string, version: string | null) => Promise<InstalledVersion>;
  runtimeRepair: (kind: string, version: string) => Promise<boolean>;
  runtimeSetActive: (kind: string, version: string) => Promise<void>;
  runtimeDelete: (kind: string, version: string) => Promise<void>;
  onRuntimeProgress: (handler: (progress: InstallProgress) => void) => Promise<() => void>;
  /** After any install/repair/switch/delete in any window: reload the list. */
  onRuntimeChanged: (handler: () => void) => Promise<() => void>;

  // System clipboard (the webview's own clipboard API is unreliable inside Tauri)
  clipboardWriteText: (text: string) => Promise<void>;
  clipboardReadText: () => Promise<string>;

  // Workspace search (Rust walks the disk on a worker thread; the UI never waits on it)
  searchRun: (searchId: string, query: SearchQueryRequest) => Promise<SearchOutcome>;
  searchCancel: (searchId: string) => Promise<boolean>;

  // Opens an http(s) address in the user's default browser (Rust validates it).
  openExternalUrl: (url: string) => Promise<void>;

  // Run Code (Rust resolves the interpreter, spawns the process and streams its output)
  runResolve: (request: RunRequestArgs) => Promise<RunAvailability>;
  runStart: (request: RunRequestArgs) => Promise<RunInfo>;
  runStop: (runId: string) => Promise<boolean>;
  runActive: () => Promise<RunInfo[]>;
  runTerminalCommand: (request: RunRequestArgs, shell: ShellStyle) => Promise<TerminalCommand>;
  onRunEvent: (handler: (event: RunEvent) => void) => Promise<() => void>;

  // PHP built-in server (portable PHP only, bound to 127.0.0.1; events share the run event shape)
  phpServerStart: (request: PhpServerRequest) => Promise<PhpServerInfo>;
  phpServerStop: (runId: string) => Promise<boolean>;
  /** The running server, or `null` — the backend is the one truth both windows read. */
  phpServerStatus: () => Promise<PhpServerInfo | null>;
  /** Opens the PHP Server window (or brings it to the front). */
  phpWindowOpen: () => Promise<void>;
  phpPortFree: (port: number) => Promise<boolean>;
  // Control-panel buttons of the PHP Server window
  /** A module's config file, or `null` while it doesn't exist. */
  panelConfigPath: (module: PanelModule) => Promise<string | null>;
  panelOpenFile: (path: string) => Promise<void>;
  panelOpenFolder: (path: string) => Promise<void>;
  /** A console whose PATH starts with the active portable runtimes. */
  panelOpenShell: (cwd: string | null) => Promise<void>;
  panelNetstat: () => Promise<ListeningPort[]>;
  onPhpEvent: (handler: (event: RunEvent) => void) => Promise<() => void>;
  /** The server started or ended (in any window): re-read `phpServerStatus`. */
  onPhpChanged: (handler: () => void) => Promise<() => void>;

  // MariaDB (a normal child process on 127.0.0.1), phpMyAdmin and Composer project commands
  mariadbStatus: () => Promise<MariaDbStatus>;
  mariadbCredentials: () => Promise<DbCredentials>;
  mariadbInitialize: () => Promise<void>;
  mariadbStart: (port: number) => Promise<ServiceInfo>;
  mariadbStop: () => Promise<void>;
  onMariadbEvent: (handler: (event: RunEvent) => void) => Promise<() => void>;
  onMariadbChanged: (handler: () => void) => Promise<() => void>;
  pmaStart: (port: number, mariadbPort: number) => Promise<ServiceInfo>;
  pmaStop: () => Promise<void>;
  pmaStatus: () => Promise<ServiceInfo | null>;
  onPmaEvent: (handler: (event: RunEvent) => void) => Promise<() => void>;
  onPmaChanged: (handler: () => void) => Promise<() => void>;
  phpProjectInfo: (root: string) => Promise<ProjectInfo>;
  composerRun: (action: ComposerAction, root: string) => Promise<RunInfo>;
  composerStop: () => Promise<void>;
  composerStatus: () => Promise<RunInfo[]>;
  onComposerEvent: (handler: (event: RunEvent) => void) => Promise<() => void>;
  onComposerChanged: (handler: () => void) => Promise<() => void>;

  // External file changes in the open workspace (debounced, ignored folders removed).
  fileWatchStart: (root: string) => Promise<void>;
  fileWatchStop: () => Promise<void>;
  onFsChanged: (handler: (batch: FsChangeBatch) => void) => Promise<() => void>;

  // Source Control (Git). The repository is always the open workspace's; only repo-relative file names are sent.
  gitSnapshot: () => Promise<GitSnapshot>;
  gitInit: () => Promise<void>;
  gitStage: (paths: string[]) => Promise<void>;
  gitStageAll: () => Promise<void>;
  gitUnstage: (paths: string[]) => Promise<void>;
  gitUnstageAll: () => Promise<void>;
  gitDiscard: (paths: string[], confirmed: boolean) => Promise<void>;
  gitDiscardAll: (confirmed: boolean) => Promise<void>;
  gitDeleteUntracked: (path: string, confirmed: boolean) => Promise<void>;
  gitCommit: (message: string) => Promise<string>;
  gitIdentity: () => Promise<GitIdentity>;
  gitSetIdentity: (name: string, email: string) => Promise<void>;
  gitDiff: (path: string, staged: boolean) => Promise<GitDiffSides>;
  gitBranches: () => Promise<GitBranch[]>;
  gitSwitchBranch: (name: string) => Promise<void>;
  gitCreateBranch: (name: string) => Promise<void>;
  gitDeleteBranch: (name: string, confirmed: boolean) => Promise<void>;
  gitFetch: () => Promise<string>;
  gitPull: () => Promise<string>;
  gitPush: () => Promise<string>;
  /** Clones into `<parent>/<name>`; resolves to the new folder. Never overwrites a non-empty folder. */
  gitClone: (url: string, parent: string, name: string) => Promise<string>;
  gitHistory: (limit: number) => Promise<GitCommit[]>;
  gitCommitFiles: (hash: string) => Promise<GitCommitFile[]>;
  gitCommitDiff: (hash: string, file: GitCommitFile) => Promise<GitDiffSides>;
  /** Blame for a file of the open repository (absolute or repo-relative). */
  gitBlame: (path: string) => Promise<GitBlameLine[]>;
  gitStashList: () => Promise<GitStash[]>;
  gitStashPush: (message: string, includeUntracked: boolean) => Promise<string>;
  gitStashApply: (index: number) => Promise<string>;
  gitStashPop: (index: number) => Promise<string>;
  gitStashDrop: (index: number, confirmed: boolean) => Promise<void>;
  gitAllowSystem: () => Promise<boolean>;
  gitSetAllowSystem: (allow: boolean) => Promise<void>;
  /** One Git command finished (label, cwd, exit code, output) — for the Git output channel. */
  onGitLog: (handler: (entry: GitLogEntry) => void) => Promise<() => void>;

  // App metadata (Help > About)
  appInfo: () => Promise<AppInfo>;
}

export interface SearchQueryRequest {
  root: string;
  text: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  useRegex: boolean;
  include: string[];
  exclude: string[];
  maxResults: number;
}

export interface SearchLineMatch {
  line: number;
  column: number;
  /** Length of the match in UTF-16 units (Monaco's unit). */
  length: number;
  preview: string;
  previewStart: number;
  previewEnd: number;
}

export interface SearchFileMatches {
  path: string;
  relativePath: string;
  matches: SearchLineMatch[];
}

export interface SearchOutcome {
  files: SearchFileMatches[];
  totalMatches: number;
  filesSearched: number;
  skippedBinary: number;
  skippedLarge: number;
  truncated: boolean;
  cancelled: boolean;
  durationMs: number;
}

export interface RunRequestArgs {
  file: string;
  workspace: string | null;
  /** A user-chosen command template, or `null` for the file type's default. */
  template: string | null;
}

export type RunnableKind = "python" | "node" | "php" | "typeScript";

/** Whether a file can be run right now, and exactly why not when it can't. */
export interface RunAvailability {
  runnable: boolean;
  kind: RunnableKind | null;
  language: string | null;
  reason: string | null;
  /** A preview exists instead (Markdown). */
  previewable: boolean;
  /** The reason is a missing interpreter — the Runtime Manager can fix it. */
  runtimeMissing: boolean;
  runtime: string | null;
  command: string | null;
  /** Absolute path of the interpreter a run would start. */
  resolved: string | null;
}

export interface RunInfo {
  runId: string;
  file: string;
  pid: number;
}

export type RunEvent = { runId: string } & (
  | {
      type: "started";
      file: string;
      commandLine: string;
      resolved: string;
      cwd: string;
      runtime: string;
      language: string;
      pid: number;
    }
  | { type: "output"; stream: "stdout" | "stderr"; line: string }
  | { type: "exited"; code: number | null; durationMs: number; stopped: boolean }
);

export interface PhpServerRequest {
  root: string;
  port: number;
}

export interface PhpServerInfo {
  run: RunInfo;
  url: string;
  port: number;
  /** The PHP version the process was started with (it keeps it after a switch). */
  phpVersion: string | null;
}

/** A service the backend started (MariaDB, phpMyAdmin). */
export type GitChangeKind =
  | "unmodified"
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "typeChanged"
  | "unmerged"
  | "untracked";

/** Mirrors openmind_git::FileChange. */
export interface GitFileChange {
  path: string;
  origPath: string | null;
  index: GitChangeKind;
  worktree: GitChangeKind;
  conflicted: boolean;
}

/** Mirrors openmind_git::RepoStatus. */
export interface GitRepoStatus {
  branch: string | null;
  detached: boolean;
  oid: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  changes: GitFileChange[];
}

/** What the Source Control view is showing (mirrors commands::git::GitSnapshot). */
export type GitSnapshot =
  | { state: "noWorkspace"; runtime: GitRuntime }
  | { state: "gitMissing"; reason: string; systemGit: string | null }
  | { state: "notRepository"; git: string }
  | { state: "repository"; root: string; name: string; git: string; status: GitRepoStatus };

export interface GitBranch {
  name: string;
  current: boolean;
  upstream: string | null;
}

export interface GitIdentity {
  name: string | null;
  email: string | null;
}

/** `null` = the file doesn't exist on that side (added / deleted). */
export interface GitDiffSides {
  path: string;
  original: string | null;
  modified: string | null;
  binary: boolean;
}

export interface GitRuntime {
  ready: boolean;
  label: string | null;
  reason: string | null;
  systemGit: string | null;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  /** Strict ISO 8601. */
  date: string;
  subject: string;
}

export interface GitCommitFile {
  path: string;
  origPath: string | null;
  /** Git's status letter: A, M, D, R, C, T. */
  status: string;
}

export interface GitBlameLine {
  line: number;
  shortHash: string;
  author: string;
  /** Seconds since the Unix epoch (0 when not committed). */
  time: number;
  summary: string;
  content: string;
  committed: boolean;
}

export interface GitStash {
  index: number;
  description: string;
  message: string | null;
  branch: string | null;
  date: string;
}

export interface GitLogEntry {
  label: string;
  cwd: string;
  code: number | null;
  stdout: string;
  stderr: string;
}

export type PanelModule = "php" | "mariadb" | "phpmyadmin";

/** Mirrors openmind_runner::ListeningPort. */
export interface ListeningPort {
  address: string;
  port: number;
  pid: number;
  process: string | null;
}

export interface ServiceInfo {
  run: RunInfo;
  port: number;
  url: string | null;
  /** MariaDB: it answered a ping. */
  ready: boolean;
  version: string | null;
  /** phpMyAdmin: the PHP it was started with. */
  phpVersion: string | null;
}

export interface MariaDbStatus {
  initialized: boolean;
  running: ServiceInfo | null;
  dataDir: string;
  logDir: string;
  configFile: string;
  hasPassword: boolean;
}

export interface DbCredentials {
  username: string;
  password: string | null;
}

export interface ProjectInfo {
  isDir: boolean;
  hasComposerJson: boolean;
}

export type ComposerAction = "install" | "update" | "dump-autoload";

export type ShellStyle = "powerShell" | "cmd" | "bash";

export interface TerminalCommand {
  line: string;
  display: string;
  runtime: string;
  resolved: string;
  language: string;
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
  documentRead: (path) => invoke<DiskRead>("document_read", { path }),

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

  runtimeList: () => invoke<RuntimeStatus[]>("runtime_list"),

  runtimeInstall: (kind, version) => invoke<InstalledVersion>("runtime_install", { kind, version }),

  runtimeRepair: (kind, version) => invoke<boolean>("runtime_repair", { kind, version }),

  runtimeSetActive: (kind, version) => invoke("runtime_set_active", { kind, version }),

  runtimeDelete: (kind, version) => invoke("runtime_delete", { kind, version }),

  onRuntimeProgress: (handler) =>
    listen<InstallProgress>("runtime:progress", (event) => {
      handler(event.payload);
    }),

  onRuntimeChanged: (handler) =>
    listen("runtime:changed", () => {
      handler();
    }),

  searchRun: (searchId, query) => invoke<SearchOutcome>("search_run", { searchId, query }),

  searchCancel: (searchId) => invoke<boolean>("search_cancel", { searchId }),

  openExternalUrl: (url) => invoke("open_external_url", { url }),

  runResolve: (request) => invoke<RunAvailability>("run_resolve", { request }),

  runStart: (request) => invoke<RunInfo>("run_start", { request }),

  runStop: (runId) => invoke<boolean>("run_stop", { runId }),

  runActive: () => invoke<RunInfo[]>("run_active"),

  runTerminalCommand: (request, shell) =>
    invoke<TerminalCommand>("run_terminal_command", { request, shell }),

  onRunEvent: (handler) =>
    listen<RunEvent>("run:event", (event) => {
      handler(event.payload);
    }),

  phpServerStart: (request) => invoke<PhpServerInfo>("php_server_start", { request }),
  phpServerStop: (runId) => invoke<boolean>("php_server_stop", { runId }),
  phpServerStatus: () => invoke<PhpServerInfo | null>("php_server_status"),
  phpWindowOpen: () => invoke("php_window_open"),
  phpPortFree: (port) => invoke<boolean>("php_port_free", { port }),
  panelConfigPath: (module) => invoke<string | null>("panel_config_path", { kind: module }),
  panelOpenFile: (path) => invoke("panel_open_file", { path }),
  panelOpenFolder: (path) => invoke("panel_open_folder", { path }),
  panelOpenShell: (cwd) => invoke("panel_open_shell", { cwd }),
  panelNetstat: () => invoke<ListeningPort[]>("panel_netstat"),
  fileWatchStart: (root) => invoke("watch_start", { root }),
  fileWatchStop: () => invoke("watch_stop"),
  onFsChanged: (handler) =>
    listen<FsChangeBatch>("fs:changed", (event) => {
      handler(event.payload);
    }),
  gitSnapshot: () => invoke<GitSnapshot>("git_snapshot"),
  gitInit: () => invoke("git_init"),
  gitStage: (paths) => invoke("git_stage", { paths }),
  gitStageAll: () => invoke("git_stage_all"),
  gitUnstage: (paths) => invoke("git_unstage", { paths }),
  gitUnstageAll: () => invoke("git_unstage_all"),
  gitDiscard: (paths, confirmed) => invoke("git_discard", { paths, confirmed }),
  gitDiscardAll: (confirmed) => invoke("git_discard_all", { confirmed }),
  gitDeleteUntracked: (path, confirmed) => invoke("git_delete_untracked", { path, confirmed }),
  gitCommit: (message) => invoke<string>("git_commit", { message }),
  gitIdentity: () => invoke<GitIdentity>("git_identity"),
  gitSetIdentity: (name, email) => invoke("git_set_identity", { name, email }),
  gitDiff: (path, staged) => invoke<GitDiffSides>("git_diff", { path, staged }),
  gitBranches: () => invoke<GitBranch[]>("git_branches"),
  gitSwitchBranch: (name) => invoke("git_switch_branch", { name }),
  gitCreateBranch: (name) => invoke("git_create_branch", { name }),
  gitDeleteBranch: (name, confirmed) => invoke("git_delete_branch", { name, confirmed }),
  gitFetch: () => invoke<string>("git_fetch"),
  gitPull: () => invoke<string>("git_pull"),
  gitPush: () => invoke<string>("git_push"),
  gitClone: (url, parent, name) => invoke<string>("git_clone", { url, parent, name }),
  gitHistory: (limit) => invoke<GitCommit[]>("git_history", { limit }),
  gitCommitFiles: (hash) => invoke<GitCommitFile[]>("git_commit_files", { hash }),
  gitCommitDiff: (hash, file) => invoke<GitDiffSides>("git_commit_diff", { hash, file }),
  gitBlame: (path) => invoke<GitBlameLine[]>("git_blame", { path }),
  gitStashList: () => invoke<GitStash[]>("git_stash_list"),
  gitStashPush: (message, includeUntracked) =>
    invoke<string>("git_stash_push", { message, includeUntracked }),
  gitStashApply: (index) => invoke<string>("git_stash_apply", { index }),
  gitStashPop: (index) => invoke<string>("git_stash_pop", { index }),
  gitStashDrop: (index, confirmed) => invoke("git_stash_drop", { index, confirmed }),
  gitAllowSystem: () => invoke<boolean>("git_allow_system"),
  gitSetAllowSystem: (allow) => invoke("git_set_allow_system", { allow }),
  onGitLog: (handler) =>
    listen<GitLogEntry>("git:log", (event) => {
      handler(event.payload);
    }),
  onPhpEvent: (handler) =>
    listen<RunEvent>("php:event", (event) => {
      handler(event.payload);
    }),
  onPhpChanged: (handler) =>
    listen("php:changed", () => {
      handler();
    }),

  mariadbStatus: () => invoke<MariaDbStatus>("mariadb_status"),
  mariadbCredentials: () => invoke<DbCredentials>("mariadb_credentials"),
  mariadbInitialize: () => invoke("mariadb_initialize"),
  mariadbStart: (port) => invoke<ServiceInfo>("mariadb_start", { port }),
  mariadbStop: () => invoke("mariadb_stop"),
  onMariadbEvent: (handler) =>
    listen<RunEvent>("mariadb:event", (event) => {
      handler(event.payload);
    }),
  onMariadbChanged: (handler) =>
    listen("mariadb:changed", () => {
      handler();
    }),
  pmaStart: (port, mariadbPort) => invoke<ServiceInfo>("pma_start", { port, mariadbPort }),
  pmaStop: () => invoke("pma_stop"),
  pmaStatus: () => invoke<ServiceInfo | null>("pma_status"),
  onPmaEvent: (handler) =>
    listen<RunEvent>("pma:event", (event) => {
      handler(event.payload);
    }),
  onPmaChanged: (handler) =>
    listen("pma:changed", () => {
      handler();
    }),
  phpProjectInfo: (root) => invoke<ProjectInfo>("php_project_info", { root }),
  composerRun: (action, root) => invoke<RunInfo>("composer_run", { action, root }),
  composerStop: () => invoke("composer_stop"),
  composerStatus: () => invoke<RunInfo[]>("composer_status"),
  onComposerEvent: (handler) =>
    listen<RunEvent>("composer:event", (event) => {
      handler(event.payload);
    }),
  onComposerChanged: (handler) =>
    listen("composer:changed", () => {
      handler();
    }),

  clipboardWriteText: (text) => writeText(text),

  clipboardReadText: () => readText(),

  appInfo: async () => ({ version: await getVersion(), tauriVersion: await getTauriVersion() }),
};
