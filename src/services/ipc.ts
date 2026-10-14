import { getTauriVersion, getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { SymbolHit } from "./searchIpc";

import { type ExtensionsIpc, tauriExtensionsIpc } from "./extensionsIpc";
import { type PreviewIpc, tauriPreviewIpc } from "./previewIpc";
import { type AiIpc, tauriAiIpc } from "./ai/aiIpc";
import { type FormattingIpc, tauriFormattingIpc } from "./formatting/formattingIpc";
import { type SourceBreakpoint, tauriWorkflowIpc, type WorkflowIpc } from "./workflowIpc";
import { type LanguageIpc, tauriLanguageIpc } from "./language/languageIpc";
import { type ProfilesIpc, tauriProfilesIpc } from "./profiles/profilesIpc";
import { type ToolchainIpc, tauriToolchainIpc } from "./toolchains/toolchainIpc";
import { type SearchIpc, tauriSearchIpc } from "./searchIpc";

// Mirrors openmind_fs::TextEncoding (#[serde(rename_all = "kebab-case")]).
export type TextEncoding = "utf8" | "utf8-bom" | "utf16-le" | "utf16-be" | "windows1252";

// Mirrors openmind_fs::LineEnding (#[serde(rename_all = "kebab-case")]).
export type LineEnding = "lf" | "crlf" | "cr" | "mixed";

// The colors the workbench is actually drawn with; `system` resolves to one of the others (see ThemeService).
export type ThemeKind = "dark" | "light" | "high-contrast";
/** The `workbench.colorTheme` setting: a theme, or "follow Windows". */
export type ThemeMode = ThemeKind | "system";

// Mirrors openmind_settings::schema (camelCase / kebab-case as serialized).
export type SettingKindInfo =
  | { type: "bool" }
  | { type: "int"; min: number; max: number }
  | { type: "text"; maxLength: number }
  | { type: "enum"; options: { value: string; label: string }[] };

export interface SettingDefinition {
  id: string;
  category: string;
  title: string;
  description: string;
  kind: SettingKindInfo;
  default: SettingValue;
  scope: "user" | "both";
}

export type SettingValue = boolean | number | string;
export type SettingSource = "default" | "user" | "workspace";
export type SettingsScope = "user" | "workspace";
/** Which of the app's editable JSON files a path is. */
export type SettingsFileKind = SettingsScope | "keybindings";

export interface EffectiveSetting {
  id: string;
  value: SettingValue;
  source: SettingSource;
}

export interface SettingsIssue {
  key: string | null;
  message: string;
  severity: "error" | "warning";
  line: number | null;
}

/** Mirrors src-tauri::commands::preferences::PreferencesSnapshot. */
export interface PreferencesSnapshot {
  definitions: SettingDefinition[];
  categories: string[];
  values: EffectiveSetting[];
  workspace: string | null;
  userFile: string;
  workspaceFile: string | null;
  userSet: string[];
  workspaceSet: string[];
  userError: string | null;
  workspaceError: string | null;
  userIssues: SettingsIssue[];
  workspaceIssues: SettingsIssue[];
}

export interface KeybindingEntry {
  key: string;
  command: string;
}

export interface KeybindingsFile {
  entries: KeybindingEntry[];
  error: string | null;
}

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

// --- Language servers (mirrors src-tauri/src/commands/lsp.rs and openmind_lsp) ---

/** LSP positions: 0-based line and UTF-16 column. */
export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

/** 1 error, 2 warning, 3 information, 4 hint. */
export interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
  /** 1 unnecessary, 2 deprecated. */
  tags?: number[];
}

export interface LspDiagnosticsEvent {
  server: string;
  path: string;
  version: number | null;
  diagnostics: LspDiagnostic[];
}

export interface LspLogEvent {
  server: string;
  level: "info" | "warning" | "error";
  text: string;
}

/** What the server said it can do (hover, completion, ...). */
export interface LspCapabilities {
  hover: boolean;
  completion: boolean;
  completionResolve: boolean;
  completionTriggers: string[];
  signatureHelp: boolean;
  signatureTriggers: string[];
  definition: boolean;
  declaration: boolean;
  typeDefinition: boolean;
  implementation: boolean;
  references: boolean;
  rename: boolean;
  prepareRename: boolean;
  formatting: boolean;
  rangeFormatting: boolean;
  documentSymbol: boolean;
  /** `workspace/symbol` (Ctrl+T); absent from older status snapshots. */
  workspaceSymbol?: boolean;
}

export type LspServerState = "stopped" | "installing" | "starting" | "running" | "error";

export interface LspServerInfo {
  id: string;
  name: string;
  languages: string[];
  note: string | null;
  /** What the server package holds ("pyright 1.1.414"). */
  contents: string;
  /** `node`: runs on Node.js; `native`: its own program (rust-analyzer, clangd); `pythonModule`: on Python (fortls). */
  runtime: "node" | "native" | "pythonModule";
  installed: boolean;
  /** The offline LSP bundle shipped with the app carries it: unpacked on first use, never downloaded. */
  bundled: boolean;
  /** Where the installed files came from (null while not installed). */
  installSource: "bundle" | "download" | null;
  /** A Python-package server's Python ("OpenMind portable Python 3.14.7", "System Python at C:\..."). */
  python?: string | null;
  /** That Python is the computer's own (OpenMind's portable Python isn't installed). */
  pythonIsSystem?: boolean;
  state: LspServerState;
  /** The reason, when `state` is "error". */
  message?: string;
  workspace: string | null;
  node: string | null;
  capabilities: LspCapabilities | null;
  openDocuments: number;
  pid: number | null;
  canInstall: boolean;
  installBlocked: string | null;
  logPath: string;
  logExists: boolean;
}

/** The offline LSP bundle (`lsp/` next to the executable). */
export interface LspBundleInfo {
  present: boolean;
  /** Why an `lsp/bundle.json` that exists can't be used. */
  problem: string | null;
  nodeVersion: string | null;
  packs: number;
}

export interface LspSnapshot {
  workspace: string | null;
  node: string | null;
  nodeProblem: string | null;
  bundle: LspBundleInfo;
  verbose: boolean;
  servers: LspServerInfo[];
}

/** Why (or that) a file has language features. */
export type LspSyncOutcome =
  | { state: "ready"; server: string }
  | { state: "unsupported" }
  /** Its server is switched off in Settings (asm-lsp: Assembly > Enable Language Server). */
  | { state: "turnedOff"; server: string }
  | { state: "noWorkspace" }
  | { state: "outsideWorkspace" }
  | { state: "otherWindowFolder" }
  | { state: "notInstalled"; server: string }
  | { state: "nodeMissing" }
  | { state: "failed"; server: string; message: string };

// --- Debugging (mirrors src-tauri/src/commands/debug.rs and openmind_dap) ---

export type DebugTarget = "python" | "node" | "php";

export interface DebugReadiness {
  target: DebugTarget;
  ready: boolean;
  /** Why not, when not ready ("Python debugger is not installed yet."). */
  problem: string | null;
  /** Which interpreter would run the program ("OpenMind portable Python"). */
  interpreter: string | null;
  /** The Runtime Manager kind whose install provides the missing debugger. */
  installKind: string | null;
}

export interface LaunchConfig {
  name: string;
  target: DebugTarget;
  program: string;
  cwd?: string | null;
  args: string[];
  stopOnEntry: boolean;
  /** Variables set for the program (launch.json `env`). */
  env?: Record<string, string>;
  /** Python only: false steps into library code too. */
  justMyCode?: boolean | null;
}

export interface DebugStopped {
  reason: string;
  threadId: number | null;
  description: string | null;
  text: string | null;
  allThreadsStopped: boolean;
}

export type DebugRunState = "starting" | "running" | "stopped" | "terminated";

export interface DebugRun {
  runId: number;
  configName: string;
  target: DebugTarget;
  state: DebugRunState;
  /** Present while `state` is "stopped". */
  stopped?: DebugStopped;
  /** Present when the run ended because of a problem. */
  error?: string | null;
  program: string;
  pid: number | null;
  /** What the adapter can do (known once it answered `initialize`). */
  capabilities?: import("./workflowIpc").DebugCapabilities;
}

export interface DebugStatus {
  workspace: string | null;
  run: DebugRun | null;
  python: DebugReadiness;
  node: DebugReadiness;
  php: DebugReadiness;
}

export interface DebugEventPayload {
  name: string;
  body: Record<string, unknown>;
}

export interface DebugLogEvent {
  level: "info" | "warning" | "error";
  text: string;
}

export interface BreakpointRow {
  filePath: string;
  line: number;
  enabled: boolean;
  /** Stop only when this expression is true. */
  condition?: string | null;
  /** Stop only on this hit count ("3", ">= 5"). */
  hitCondition?: string | null;
  /** A logpoint: print this (with {expressions}) instead of stopping. */
  logMessage?: string | null;
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

/** Mirrors `launch::LaunchRequest`: what the command line named, sorted by the backend. */
export interface LaunchRequest {
  folder: string | null;
  files: string[];
  /** Folders after the first (a window has one workspace). */
  ignoredFolders: string[];
  /** Paths that don't exist. */
  missing: string[];
}

/** Mirrors `integration::Status`. */
export interface IntegrationStatus {
  exe: string;
  binDir: string;
  pathPresent: boolean;
  /** OpenMind added the PATH entry (and will remove it). */
  pathAdded: boolean;
  explorerThisCopy: boolean;
  /** The command of Explorer entries that run another OpenMind copy. */
  explorerOtherCopy: string | null;
}

/** Mirrors `python_packages::PythonBundleStatus`. */
export interface PythonBundleStatus {
  present: boolean;
  problem: string | null;
  python: string | null;
  packages: string[];
  stdlib: string[];
}

export type IntegrationAction = "add-path" | "remove-path" | "add-explorer" | "remove-explorer";

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
export type InstallPhase = "waiting" | "download" | "verify" | "extract" | "finalize" | "done";

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
  /** Optional parts for this version (Tcl/Tk GUI support for Python 3.14.7) and whether each is installed. */
  addons?: AddonStatus[];
}

/** An optional part installed into one installed runtime version, from its own pinned download. */
export interface AddonStatus {
  id: string;
  label: string;
  description: string;
  installed: boolean;
  /** There is a download for this platform. */
  available: boolean;
  downloadBytes: number | null;
  installBytes: number | null;
  license: { name: string; url: string } | null;
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
  /** Other runtimes it needs (Maven needs the JDK). */
  requires: string[];
  license: RuntimeLicense | null;
  /** Download and installed size of the default version for this computer (`null`: unknown). */
  downloadBytes: number | null;
  installBytes: number | null;
}

export interface RuntimeLicense {
  name: string;
  url: string;
  /** The vendor's terms must be accepted before installing (Android SDK). */
  acceptanceRequired: boolean;
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
export interface IpcClient
  extends
    ExtensionsIpc,
    PreviewIpc,
    SearchIpc,
    AiIpc,
    LanguageIpc,
    ToolchainIpc,
    FormattingIpc,
    ProfilesIpc,
    WorkflowIpc {
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
  /** A file or folder was renamed/moved: recent files under it follow. */
  recentFilesRename: (from: string, to: string) => Promise<void>;
  sessionLoad: () => Promise<SessionSnapshot>;
  sessionSave: (snapshot: SessionSnapshot) => Promise<void>;
  // Settings (settings/settings.json, <workspace>/.openmind/settings.json) and keybindings (settings/keybindings.json).
  preferencesLoad: () => Promise<PreferencesSnapshot>;
  preferencesSet: (
    scope: SettingsScope,
    id: string,
    value: SettingValue,
  ) => Promise<PreferencesSnapshot>;
  preferencesReset: (scope: SettingsScope, id: string) => Promise<PreferencesSnapshot>;
  preferencesFile: (scope: SettingsScope) => Promise<string>;
  preferencesValidate: (scope: SettingsScope, text: string) => Promise<SettingsIssue[]>;
  preferencesScopeOf: (path: string) => Promise<SettingsFileKind | null>;
  keybindingsLoad: () => Promise<KeybindingsFile>;
  keybindingsSave: (entries: KeybindingEntry[]) => Promise<KeybindingEntry[]>;
  keybindingsFile: () => Promise<string>;

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
  /** Whether a program besides the shell runs in that terminal (`null`: unknown). */
  terminalBusy: (id: string) => Promise<boolean | null>;
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

  /** `acceptLicense`: the user accepted the runtime's vendor licence (required for some, e.g. the Android SDK). */
  runtimeInstall: (kind: string, version: string | null, acceptLicense?: boolean) => Promise<InstalledVersion>;
  runtimeRepair: (kind: string, version: string) => Promise<boolean>;
  /** Adds / removes an optional part (see `AddonStatus`) of an installed version; progress arrives like an install's. */
  runtimeAddonInstall: (kind: string, version: string, addon: string) => Promise<void>;
  runtimeAddonRemove: (kind: string, version: string, addon: string) => Promise<void>;
  runtimeSetActive: (kind: string, version: string) => Promise<void>;
  runtimeDelete: (kind: string, version: string) => Promise<void>;
  onRuntimeProgress: (handler: (progress: InstallProgress) => void) => Promise<() => void>;

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
  /** `underGdb`: an assembly file's program runs under GDB (`gdb --args`). */
  runTerminalCommand: (request: RunRequestArgs, shell: ShellStyle, underGdb?: boolean) => Promise<TerminalCommand>;
  onRunEvent: (handler: (event: CodeRunEvent) => void) => Promise<() => void>;

  // PHP built-in server (portable PHP only, bound to 127.0.0.1; events share the run event shape)
  phpServerStart: (request: PhpServerRequest) => Promise<PhpServerInfo>;
  phpServerStop: (runId: string) => Promise<boolean>;
  /** Opens the PHP Server window (or brings it to the front). */
  phpWindowOpen: () => Promise<void>;
  phpPortFree: (port: number) => Promise<boolean>;
  /** The default web root (`<app>/htdocs`), created with a start page if needed. */
  phpWebRoot: () => Promise<string>;
  /** Opens a new, empty editor window (File > New Window); resolves to its label. */
  windowNew: (options?: { path?: string; x?: number; y?: number }) => Promise<string>;
  /** The file this window was opened for (a tab dragged out of another window), or `null`. */
  windowTakePendingOpen: () => Promise<string | null>;
  /** What `OpenMindStudio.exe <folder|file ...>` asked to open; the main window gets it once, others `null`. */
  launchTake: () => Promise<LaunchRequest | null>;
  /** Shell integration of this copy (reads the user's Registry; changes nothing). */
  integrationStatus: () => Promise<IntegrationStatus>;
  /** Adds or removes the PATH entry or the File Explorer entries (only after the user confirmed). */
  integrationApply: (action: IntegrationAction) => Promise<string>;
  /** Creates or repairs this user's Desktop shortcut to this copy (its network path on a share); what was done. */
  integrationDesktopShortcut: () => Promise<string>;
  /** The deployment check's report (`OpenMindStudio.exe --integration check`), as text. */
  integrationCheck: () => Promise<string>;
  /** The offline Python package bundle that ships with this copy (a local read). */
  pythonPackagesStatus: () => Promise<PythonBundleStatus>;
  /** Installs the bundle into a portable Python (`null` = the active one); resolves with what was installed. */
  pythonPackagesInstall: (version: string | null) => Promise<string>;
  // Control-panel buttons of the PHP Server window
  /** A module's config file, or `null` while it doesn't exist. */
  panelConfigPath: (module: PanelModule) => Promise<string | null>;
  panelOpenFile: (path: string) => Promise<void>;
  panelOpenFolder: (path: string) => Promise<void>;
  /** A console whose PATH starts with the active portable runtimes. */
  panelOpenShell: (cwd: string | null) => Promise<void>;
  panelNetstat: () => Promise<ListeningPort[]>;
  onPhpEvent: (handler: (event: RunEvent) => void) => Promise<() => void>;

  // MariaDB (a normal child process on 127.0.0.1), phpMyAdmin and Composer project commands
  mariadbStatus: () => Promise<MariaDbStatus>;
  mariadbCredentials: () => Promise<DbCredentials>;
  mariadbInitialize: () => Promise<void>;
  mariadbStart: (port: number) => Promise<ServiceInfo>;
  mariadbStop: () => Promise<void>;
  onMariadbEvent: (handler: (event: RunEvent) => void) => Promise<() => void>;
  pmaStart: (port: number, mariadbPort: number) => Promise<ServiceInfo>;
  pmaStop: () => Promise<void>;
  onPmaEvent: (handler: (event: RunEvent) => void) => Promise<() => void>;
  mysqlStart: () => Promise<MySqlStatus>;
  mysqlStop: () => Promise<MySqlStatus>;
  mysqlRestart: () => Promise<MySqlStatus>;
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

  // Debugging. Only an explicit debugStart ever starts anything; the backend checks the program, finds the interpreter and adapter.
  debugRun: () => Promise<DebugRun | null>;
  debugStart: (config: LaunchConfig, breakpoints: BreakpointRow[]) => Promise<DebugRun>;
  debugStop: () => Promise<void>;
  debugControl: (action: string) => Promise<void>;
  debugRequest: (command: string, args: unknown) => Promise<unknown>;
  debugSetBreakpoints: (path: string, breakpoints: SourceBreakpoint[]) => Promise<void>;
  breakpointsLoad: () => Promise<BreakpointRow[]>;
  breakpointsSave: (rows: BreakpointRow[]) => Promise<void>;
  onDebugEvent: (handler: (event: DebugEventPayload) => void) => Promise<() => void>;
  onDebugState: (handler: (run: DebugRun) => void) => Promise<() => void>;
  onDebugLog: (handler: (event: DebugLogEvent) => void) => Promise<() => void>;

  lspInstall: (server: string) => Promise<void>;
  /** Removes a downloaded language server (its processes stop first). */
  lspUninstall: (server: string) => Promise<void>;
  /** Workspace symbols from the running servers that offer them (none are started for this). */
  lspWorkspaceSymbols: (query: string, limit: number) => Promise<SymbolHit[]>;
  lspSyncDocument: (path: string, text: string) => Promise<LspSyncOutcome>;
  lspSaveDocument: (path: string) => Promise<void>;
  lspCloseDocument: (path: string) => Promise<void>;
  lspRequest: (path: string, method: string, params: unknown) => Promise<unknown>;
  lspStop: (server: string) => Promise<void>;
  lspStopAll: () => Promise<void>;
  lspSetVerbose: (verbose: boolean) => Promise<void>;
  onLspDiagnostics: (handler: (event: LspDiagnosticsEvent) => void) => Promise<() => void>;
  onLspLog: (handler: (event: LspLogEvent) => void) => Promise<() => void>;

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
  /** Everything the About window shows, and the text "Copy system info" copies. */
  aboutInfo: () => Promise<AboutInfo>;
  /** Start-up phase timings (names and milliseconds) for the app log. */
  startupReport: (marks: [string, number][], usableMs: number) => Promise<string>;
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
  /** The program's command-line arguments as typed (split by the backend, never by a shell), `null` for none. */
  arguments?: string | null;
}

export type RunnableKind = "python" | "node" | "php" | "typeScript" | "c" | "cpp" | "java" | "rust";

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
  /** When a tool is missing: the Runtime Manager item that provides it (Run Code offers to install it). */
  installRuntime?: string | null;
  /** Shown in the built-in browser: an HTML page (runnable), or JavaScript when Node.js is missing. */
  browser?: boolean;
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
  /** `phase` is "build" for the compiler's output, "run" (or absent) for the program's. */
  | { type: "output"; stream: "stdout" | "stderr"; line: string; phase?: "build" | "run" }
  /** `buildFailed`: the build failed, so the program never ran (`code` is the compiler's). */
  | { type: "exited"; code: number | null; durationMs: number; stopped: boolean; buildFailed?: boolean }
);

/**
 * Run Code's events: a service's (`RunEvent`) plus a compiled language's build (C, C++, Java, Rust) — `building`,
 * then `built`, and `started` only after a successful build. Services (PHP server, MariaDB ...) never build.
 */
export type CodeRunEvent =
  | RunEvent
  | {
      runId: string;
      type: "building";
      file: string;
      commandLine: string;
      compiler: string;
      cwd: string;
      runtime: string;
      language: string;
      pid: number;
    }
  | { runId: string; type: "built"; success: boolean; code: number | null; durationMs: number };

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

export type MySqlState =
  "notInstalled" | "initializing" | "starting" | "running" | "stopping" | "stopped" | "error";

/** The MySQL service (MariaDB + phpMyAdmin) as one status (mirrors `commands::mysql::MySqlStatus`). */
export interface MySqlStatus {
  state: MySqlState;
  /** What isn't installed yet: "MariaDB", "phpMyAdmin", "PHP". */
  missing: string[];
  initialized: boolean;
  error: string | null;
  mariadb: ServiceInfo | null;
  phpmyadmin: ServiceInfo | null;
  mariadbVersion: string | null;
  phpmyadminVersion: string | null;
  /** phpMyAdmin signs in by itself (root / root); otherwise it shows its login page. */
  autoLogin: boolean;
}

export interface DbCredentials {
  username: string;
  password: string | null;
}

export interface ProjectInfo {
  isDir: boolean;
  hasComposerJson: boolean;
  /** composer.json requires laravel/framework and there is an artisan file. */
  isLaravel?: boolean;
  hasVendor?: boolean;
  hasEnv?: boolean;
  /** `dev` and `build` from package.json's scripts, when they exist. */
  npmScripts?: string[];
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

export interface AboutAuthor {
  name: string;
  role: string;
  line: string;
  github: string;
  supportEmail: string;
  telegram: string;
  whatsapp: string;
  /** `null` until a portfolio address is configured. */
  portfolio: string | null;
}

export interface AboutInfo {
  name: string;
  version: string;
  tauriVersion: string;
  rustc: string;
  webview: string;
  os: string;
  arch: string;
  license: string;
  description: string;
  appDir: string;
  logsDir: string;
  author: AboutAuthor;
  systemInfo: string;
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
  ...tauriExtensionsIpc,
  ...tauriPreviewIpc,
  ...tauriSearchIpc,
  ...tauriAiIpc,
  ...tauriLanguageIpc,
  ...tauriFormattingIpc,
  ...tauriWorkflowIpc,
  ...tauriProfilesIpc,
  ...tauriToolchainIpc,
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
  recentFilesRename: (from, to) => invoke("recent_files_rename", { from, to }),

  sessionLoad: () => invoke<SessionSnapshot>("session_load"),

  sessionSave: (snapshot) => invoke("session_save", { snapshot }),

  preferencesLoad: () => invoke<PreferencesSnapshot>("preferences_load"),
  preferencesSet: (scope, id, value) =>
    invoke<PreferencesSnapshot>("preferences_set", { scope, id, value }),
  preferencesReset: (scope, id) => invoke<PreferencesSnapshot>("preferences_reset", { scope, id }),
  preferencesFile: (scope) => invoke<string>("preferences_file", { scope }),
  preferencesValidate: (scope, text) =>
    invoke<SettingsIssue[]>("preferences_validate", { scope, text }),
  preferencesScopeOf: (path) => invoke<SettingsFileKind | null>("preferences_scope_of", { path }),
  keybindingsLoad: () => invoke<KeybindingsFile>("keybindings_load"),
  keybindingsSave: (entries) => invoke<KeybindingEntry[]>("keybindings_save", { entries }),
  keybindingsFile: () => invoke<string>("keybindings_file"),

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
  terminalBusy: (id) => invoke<boolean | null>("terminal_busy", { id }),

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


  runtimeInstall: (kind, version, acceptLicense) =>
    invoke<InstalledVersion>("runtime_install", { kind, version, acceptLicense: acceptLicense ?? false }),

  runtimeRepair: (kind, version) => invoke<boolean>("runtime_repair", { kind, version }),

  runtimeAddonInstall: (kind, version, addon) => invoke("runtime_addon_install", { kind, version, addon }),

  runtimeAddonRemove: (kind, version, addon) => invoke("runtime_addon_remove", { kind, version, addon }),

  runtimeSetActive: (kind, version) => invoke("runtime_set_active", { kind, version }),

  runtimeDelete: (kind, version) => invoke("runtime_delete", { kind, version }),

  onRuntimeProgress: (handler) =>
    listen<InstallProgress>("runtime:progress", (event) => {
      handler(event.payload);
    }),


  searchRun: (searchId, query) => invoke<SearchOutcome>("search_run", { searchId, query }),

  searchCancel: (searchId) => invoke<boolean>("search_cancel", { searchId }),

  openExternalUrl: (url) => invoke("open_external_url", { url }),

  runResolve: (request) => invoke<RunAvailability>("run_resolve", { request }),

  runStart: (request) => invoke<RunInfo>("run_start", { request }),

  runStop: (runId) => invoke<boolean>("run_stop", { runId }),

  runActive: () => invoke<RunInfo[]>("run_active"),

  runTerminalCommand: (request, shell, underGdb) =>
    invoke<TerminalCommand>("run_terminal_command", { request, shell, debugger: underGdb ?? false }),

  onRunEvent: (handler) =>
    listen<RunEvent>("run:event", (event) => {
      handler(event.payload);
    }),

  phpServerStart: (request) => invoke<PhpServerInfo>("php_server_start", { request }),
  phpServerStop: (runId) => invoke<boolean>("php_server_stop", { runId }),
  phpWindowOpen: () => invoke("php_window_open"),
  phpPortFree: (port) => invoke<boolean>("php_port_free", { port }),
  phpWebRoot: () => invoke<string>("php_web_root"),
  windowNew: (options) =>
    invoke<string>("window_new", {
      path: options?.path ?? null,
      x: options?.x ?? null,
      y: options?.y ?? null,
    }),
  windowTakePendingOpen: () => invoke<string | null>("window_take_pending_open"),
  launchTake: () => invoke<LaunchRequest | null>("launch_take"),
  integrationStatus: () => invoke<IntegrationStatus>("integration_status"),
  integrationApply: (action) => invoke<string>("integration_apply", { action }),
  integrationDesktopShortcut: () => invoke<string>("integration_desktop_shortcut"),
  integrationCheck: () => invoke<string>("integration_check"),
  pythonPackagesStatus: () => invoke<PythonBundleStatus>("python_packages_status"),
  pythonPackagesInstall: (version) => invoke<string>("python_packages_install", { version }),
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
  debugRun: () => invoke<DebugRun | null>("debug_run"),
  debugStart: (config, breakpoints) => invoke<DebugRun>("debug_start", { config, breakpoints }),
  debugStop: () => invoke("debug_stop"),
  debugControl: (action) => invoke("debug_control", { action }),
  debugRequest: (command, args) => invoke("debug_request", { command, arguments: args }),
  debugSetBreakpoints: (path, breakpoints) => invoke("debug_set_breakpoints", { path, breakpoints }),
  breakpointsLoad: () => invoke<BreakpointRow[]>("breakpoints_load"),
  breakpointsSave: (rows) => invoke("breakpoints_save", { rows }),
  onDebugEvent: (handler) =>
    listen<DebugEventPayload>("debug:event", (event) => {
      handler(event.payload);
    }),
  onDebugState: (handler) =>
    listen<DebugRun>("debug:state", (event) => {
      handler(event.payload);
    }),
  onDebugLog: (handler) =>
    listen<DebugLogEvent>("debug:log", (event) => {
      handler(event.payload);
    }),
  lspInstall: (server) => invoke("lsp_install", { server }),
  lspUninstall: (server) => invoke("lsp_uninstall", { server }),
  lspWorkspaceSymbols: (query, limit) => invoke<SymbolHit[]>("lsp_workspace_symbols", { query, limit }),
  lspSyncDocument: (path, text) => invoke<LspSyncOutcome>("lsp_sync_document", { path, text }),
  lspSaveDocument: (path) => invoke("lsp_save_document", { path }),
  lspCloseDocument: (path) => invoke("lsp_close_document", { path }),
  lspRequest: (path, method, params) => invoke("lsp_request", { path, method, params }),
  lspStop: (server) => invoke("lsp_stop", { server }),
  lspStopAll: () => invoke("lsp_stop_all"),
  lspSetVerbose: (verbose) => invoke("lsp_set_verbose", { verbose }),
  onLspDiagnostics: (handler) =>
    listen<LspDiagnosticsEvent>("lsp:diagnostics", (event) => {
      handler(event.payload);
    }),
  onLspLog: (handler) =>
    listen<LspLogEvent>("lsp:log", (event) => {
      handler(event.payload);
    }),
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

  mariadbStatus: () => invoke<MariaDbStatus>("mariadb_status"),
  mariadbCredentials: () => invoke<DbCredentials>("mariadb_credentials"),
  mariadbInitialize: () => invoke("mariadb_initialize"),
  mariadbStart: (port) => invoke<ServiceInfo>("mariadb_start", { port }),
  mariadbStop: () => invoke("mariadb_stop"),
  onMariadbEvent: (handler) =>
    listen<RunEvent>("mariadb:event", (event) => {
      handler(event.payload);
    }),
  pmaStart: (port, mariadbPort) => invoke<ServiceInfo>("pma_start", { port, mariadbPort }),
  pmaStop: () => invoke("pma_stop"),
  onPmaEvent: (handler) =>
    listen<RunEvent>("pma:event", (event) => {
      handler(event.payload);
    }),
  mysqlStart: () => invoke<MySqlStatus>("mysql_start"),
  mysqlStop: () => invoke<MySqlStatus>("mysql_stop"),
  mysqlRestart: () => invoke<MySqlStatus>("mysql_restart"),
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

  aboutInfo: () => invoke<AboutInfo>("about_info"),
  startupReport: (marks, usableMs) => invoke<string>("startup_report", { marks, usableMs }),
  appInfo: async () => ({ version: await getVersion(), tauriVersion: await getTauriVersion() }),
};
