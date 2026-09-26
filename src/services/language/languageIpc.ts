import { invoke } from "@tauri-apps/api/core";

// Mirrors openmind_language (serde camelCase). Every call is a lookup of files: nothing is run or installed.

export type SupportLevel =
  "syntax" | "lsp" | "format" | "lint" | "run" | "build" | "debug" | "test";
export type SyntaxKind = "exact" | "approximate" | "none";

export interface LanguageDef {
  id: string;
  name: string;
  group: string;
  extensions: string[];
  filenames: string[];
  comment: string;
  /** The editor (Monaco) grammar used. */
  monaco: string;
  syntax: SyntaxKind;
  formatters: string[];
  linters: string[];
  lsp: string[];
  toolchains: string[];
  levels: SupportLevel[];
}

export type ToolSource = "project" | "bundled" | "portable" | "system" | "env";

export interface ToolFound {
  path: string;
  source: ToolSource;
}

export interface ToolStatus {
  id: string;
  name: string;
  found: ToolFound | null;
  hint: string;
}

export type CommandCategory =
  "run" | "dev" | "build" | "test" | "lint" | "format" | "install" | "clean";

export interface ProjectCommand {
  id: string;
  label: string;
  category: CommandCategory;
  argv: string[];
  /** The folder to run in, relative to the workspace ("" = the workspace). */
  cwd: string;
  tools: string[];
  /** It downloads something (still runs only on a click). */
  network: boolean;
  note: string | null;
  /** A platform limit that no tool can fix. */
  unavailable: string | null;
}

export interface CommandStatus extends ProjectCommand {
  available: boolean;
  reason: string | null;
  missing: string[];
}

export type Confidence = "low" | "medium" | "high";

export interface Detection {
  id: string;
  name: string;
  group: string;
  confidence: Confidence;
  evidence: string;
}

export interface ProjectStatus {
  root: string;
  name: string;
  detections: Detection[];
  packageManager: string | null;
  ambiguous: boolean;
  notes: string[];
  tools: string[];
  commands: ProjectCommand[];
  title: string;
  toolStatus: ToolStatus[];
  commandStatus: CommandStatus[];
  summary: string;
}

export type OsName = "windows" | "macOs" | "linux";

export interface WorkspaceStatus {
  os: OsName;
  projects: ProjectStatus[];
  tools: ToolStatus[];
}

export interface LspCandidate {
  tool: string;
  name: string;
  /** OpenMind's own server id (typescript, python, php, html, css, json). */
  builtin: string | null;
  found: ToolFound | null;
  note: string;
}

export interface FormatOption {
  tool: string;
  name: string;
  kind: CommandCategory;
  found: ToolFound | null;
  hint: string;
  /** The program's resolved path first (empty when the tool wasn't found). */
  argv: string[];
  /** The argument list that formats text passed on stdin (empty when the tool only works on files). */
  stdinArgv: string[];
  wholeProject: boolean;
}

export interface FileLanguageStatus {
  path: string;
  language: LanguageDef | null;
  projectRoot: string | null;
  lsp: LspCandidate[];
  formatters: FormatOption[];
  linters: FormatOption[];
}

export type TerminalShellStyle = "powerShell" | "cmd" | "bash";

export interface LanguageIpc {
  languageRegistry: () => Promise<LanguageDef[]>;
  languageWorkspaceStatus: () => Promise<WorkspaceStatus>;
  languageFileStatus: (path: string) => Promise<FileLanguageStatus>;
  languageTerminalLine: (argv: string[], style: TerminalShellStyle) => Promise<string>;
}

export const tauriLanguageIpc: LanguageIpc = {
  languageRegistry: () => invoke<LanguageDef[]>("language_registry"),
  languageWorkspaceStatus: () => invoke<WorkspaceStatus>("language_workspace_status"),
  languageFileStatus: (path) => invoke<FileLanguageStatus>("language_file_status", { path }),
  languageTerminalLine: (argv, style) => invoke<string>("language_terminal_line", { argv, style }),
};
