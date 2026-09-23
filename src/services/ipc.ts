import { invoke } from "@tauri-apps/api/core";
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

/**
 * Everything the frontend needs from the backend, as an interface — so
 * services that depend on it (DocumentService, WorkspaceService,
 * ThemeService) can be unit tested against a fake implementation instead of
 * a real Tauri runtime.
 */
// Property (arrow-function-typed), not method-shorthand, syntax: this type
// is implemented by plain object literals (`tauriIpcClient` below, and fake
// clients in tests) that never rely on `this`, and method-shorthand syntax
// makes eslint's `unbound-method` rule flag every bare `ipc.someMethod`
// reference (e.g. `expect(ipc.documentSave).toHaveBeenCalledWith(...)`).
export interface IpcClient {
  openDocumentDialog: () => Promise<string | null>;
  saveDocumentDialog: (defaultPath: string | undefined) => Promise<string | null>;
  documentOpen: (path: string) => Promise<OpenedDocument>;
  documentSave: (path: string, content: string, encoding: TextEncoding) => Promise<void>;
  recentFilesList: () => Promise<RecentFileInfo[]>;
  recentFilesClear: () => Promise<void>;
  sessionLoad: () => Promise<SessionSnapshot>;
  sessionSave: (snapshot: SessionSnapshot) => Promise<void>;
  themeGet: () => Promise<ThemeKind>;
  themeSet: (theme: ThemeKind) => Promise<void>;
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

  documentOpen: (path) => invoke<OpenedDocument>("document_open", { path }),

  documentSave: (path, content, encoding) =>
    invoke("document_save", { path, content, encoding }),

  recentFilesList: () => invoke<RecentFileInfo[]>("recent_files_list"),

  recentFilesClear: () => invoke("recent_files_clear"),

  sessionLoad: () => invoke<SessionSnapshot>("session_load"),

  sessionSave: (snapshot) => invoke("session_save", { snapshot }),

  themeGet: () => invoke<ThemeKind>("theme_get"),

  themeSet: (theme) => invoke("theme_set", { theme }),
};
